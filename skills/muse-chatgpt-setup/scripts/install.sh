#!/usr/bin/env bash
# muse-chatgpt-setup: install / restore / stop the OpenAI Secure MCP Tunnel client
# plus a minimal MCP server, in one self-contained directory.
#
# Assumes nothing exists (no tunnel client, no MCP server, no units). Never
# touches services, ports or files it did not create.
#
# Usage (on the target machine):
#   TUNNEL_ID=tunnel_xxx KEY_FILE=/path/to/key-file bash install.sh
#   bash ~/muse-chatgpt/restore.sh                     # restart after a VM swap
#   KEY_FILE=/path/new-key bash ~/muse-chatgpt/restore.sh   # rotate the key
#   bash ~/muse-chatgpt/restore.sh stop                # stop both processes
#
# KEY_FILE holds either `CONTROL_PLANE_API_KEY=sk-...` or the bare key on one line.
#
# Optional environment:
#   DIR=~/muse-chatgpt          install root (default)
#   INSTANCE=muse-chatgpt       prefix for the systemd unit names
#   CONSUME_KEY_FILE=1          overwrite + delete KEY_FILE after copying it
#   NO_SYSTEMD=1                force the nohup mode
#   MCP_PORT= HEALTH_PORT=      default: keep previous ports, else pick free ones
#   VERIFY_TIMEOUT=90           seconds to wait for the first successful poll
#   TUNNEL_CLIENT_VERSION=v0.0.11
#   TUNNEL_CLIENT_BIN=/path     use this binary instead of downloading (tests)
#   TUNNEL_CLIENT_BASE_URL=...  release mirror (default: GitHub releases)
#   MCP_SRC=/path/muse-mcp.py   default: muse-mcp.py next to this script
#
# Exit codes: 0 connected, 2 pending (egress not approved yet),
#             3 key missing/rejected/forbidden, 4 a process failed to start,
#             1 any other error.
# The API key is never printed, logged or placed on a command line.

set -euo pipefail
umask 077

ACTION="${1:-install}"
case "$ACTION" in
  install|restore|stop) ;;
  *) echo "usage: install.sh [install|restore|stop]" >&2; exit 1 ;;
esac

DIR="${DIR:-$HOME/muse-chatgpt}"
INSTANCE="${INSTANCE:-muse-chatgpt}"
UNIT_MCP="${INSTANCE}-mcp.service"
UNIT_TUN="${INSTANCE}-tunnel.service"
MARKER="# managed-by: muse-chatgpt-setup dir=$DIR"
CONF="$DIR/run/config.env"
KEY_DST="$DIR/run/control-plane.env"

say() { printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"; }
die() { say "ERROR: $*"; exit 1; }

case "$DIR" in *[[:space:]]*) die "DIR must not contain spaces: $DIR" ;; esac
case "$INSTANCE" in *[!A-Za-z0-9_-]*|"") die "INSTANCE may only contain letters, digits, - and _" ;; esac
command -v python3 >/dev/null || die "python3 is required"
PY="$(command -v python3)"

# ---------- saved config (explicit env wins) ----------
SAVED_TUNNEL_ID="" SAVED_MCP_PORT="" SAVED_HEALTH_PORT="" SAVED_NO_SYSTEMD="" SAVED_CLIENT_VERSION=""
if [ -f "$CONF" ]; then
  # shellcheck disable=SC1090
  . "$CONF"
fi
CLIENT_VERSION="${TUNNEL_CLIENT_VERSION:-${SAVED_CLIENT_VERSION:-v0.0.11}}"
NO_SYSTEMD="${NO_SYSTEMD:-${SAVED_NO_SYSTEMD:-0}}"

# ---------- helpers ----------
same_file() { [ -e "$1" ] && [ -e "$2" ] && [ "$1" -ef "$2" ]; }

copy_in() {  # copy_in SRC DST MODE - no-op when SRC and DST are the same file
  local src="$1" dst="$2" mode="$3"
  same_file "$src" "$dst" && return 0
  cp "$src" "$dst.tmp.$$" && chmod "$mode" "$dst.tmp.$$" && mv -f "$dst.tmp.$$" "$dst"
}

port_free() {
  "$PY" - "$1" <<'PY'
import socket, sys
s = socket.socket()
s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
try:
    s.bind(("127.0.0.1", int(sys.argv[1])))
except OSError:
    sys.exit(1)
finally:
    s.close()
PY
}

pick_port() {
  "$PY" -c 'import socket;s=socket.socket();s.bind(("127.0.0.1",0));print(s.getsockname()[1]);s.close()'
}

wait_port() {  # wait_port PORT SECONDS
  "$PY" - "$1" "$2" <<'PY'
import socket, sys, time
port, deadline = int(sys.argv[1]), time.time() + float(sys.argv[2])
while time.time() < deadline:
    s = socket.socket(); s.settimeout(1)
    ok = s.connect_ex(("127.0.0.1", port)) == 0
    s.close()
    if ok:
        sys.exit(0)
    time.sleep(0.25)
sys.exit(1)
PY
}

ours_pid() {  # ours_pid PIDFILE -> prints pid if alive and its command line points into $DIR
  local f="$1" pid cmd
  [ -f "$f" ] || return 1
  pid="$(tr -cd '0-9' < "$f")"
  [ -n "$pid" ] || return 1
  kill -0 "$pid" 2>/dev/null || return 1
  cmd="$(ps -p "$pid" -o command= 2>/dev/null || true)"
  case "$cmd" in *"$DIR/"*) printf '%s\n' "$pid" ;; *) return 1 ;; esac
}

stop_pidfile() {
  local f="$1" pid i
  pid="$(ours_pid "$f")" || { rm -f "$f"; return 0; }
  kill "$pid" 2>/dev/null || true
  for i in $(seq 1 40); do kill -0 "$pid" 2>/dev/null || break; sleep 0.25; done
  kill -9 "$pid" 2>/dev/null || true
  rm -f "$f"
  say "stopped pid $pid ($(basename "$f"))"
}

have_systemd() {
  [ "$(id -u)" = "0" ] && command -v systemctl >/dev/null 2>&1 && [ -d /run/systemd/system ]
}

unit_is_ours() { [ -f "$1" ] && grep -qF "$MARKER" "$1"; }

stop_all() {
  if have_systemd; then
    local u
    for u in "$UNIT_TUN" "$UNIT_MCP"; do
      if unit_is_ours "/etc/systemd/system/$u"; then systemctl stop "$u" 2>/dev/null || true; fi
    done
    # Units written by v0 of this installer into the same DIR (muse-mcp/muse-tunnel).
    for u in muse-tunnel.service muse-mcp.service; do
      if [ -f "/etc/systemd/system/$u" ] && grep -qF "$DIR/" "/etc/systemd/system/$u" \
         && ! grep -qF "managed-by: muse-chatgpt-setup" "/etc/systemd/system/$u"; then
        systemctl disable --now "$u" >/dev/null 2>&1 || true
        say "disabled legacy unit $u (v0 install in $DIR)"
      fi
    done
  fi
  stop_pidfile "$DIR/run/tunnel.pid"
  stop_pidfile "$DIR/run/mcp.pid"
}

if [ "$ACTION" = "stop" ]; then
  stop_all
  [ -d "$DIR/run" ] && : > "$DIR/run/stopped"   # keepalive.sh leaves a stopped install alone
  say "stopped"
  exit 0
fi
rm -f "$DIR/run/stopped"

# ---------- tunnel id ----------
TUNNEL_ID="${TUNNEL_ID:-$SAVED_TUNNEL_ID}"
[ -n "$TUNNEL_ID" ] || die "TUNNEL_ID is required (tunnel_...)"
printf '%s' "$TUNNEL_ID" | grep -Eq '^tunnel_[A-Za-z0-9]+$' || die "TUNNEL_ID must look like tunnel_<alphanumeric>"
if [ -n "$SAVED_TUNNEL_ID" ] && [ "$SAVED_TUNNEL_ID" != "$TUNNEL_ID" ]; then
  say "WARN: re-pointing this install from $SAVED_TUNNEL_ID to $TUNNEL_ID;"
  say "      a ChatGPT connector bound to the old tunnel stops working."
fi

# ---------- layout + payload ----------
mkdir -p "$DIR"/bin "$DIR"/run "$DIR"/systemd "$DIR"/logs
chmod 700 "$DIR" "$DIR/run"

SELF="${BASH_SOURCE[0]:-$0}"
SCRIPT_DIR="$(cd "$(dirname "$SELF")" && pwd)"
[ -f "$SELF" ] && copy_in "$SELF" "$DIR/install.sh" 755
MCP_SRC="${MCP_SRC:-$SCRIPT_DIR/muse-mcp.py}"
if [ -f "$MCP_SRC" ]; then
  copy_in "$MCP_SRC" "$DIR/muse-mcp.py" 644
elif [ ! -f "$DIR/muse-mcp.py" ]; then
  die "muse-mcp.py not found (looked at $MCP_SRC)"
fi

cat > "$DIR/restore.sh" <<EOF
#!/usr/bin/env bash
# Restart (or, with KEY_FILE=..., rotate the key of) this install.
# Same code path as install.sh. Usage: bash $DIR/restore.sh [stop]
exec env DIR="$DIR" INSTANCE="$INSTANCE" bash "$DIR/install.sh" "\${1:-restore}"
EOF
chmod 755 "$DIR/restore.sh"

# ---------- keepalive: restart after a VM swap without anyone asking ----------
# keepalive.sh is plain bash (cron, a Muse hook, anything that polls).
# muse-hook.sh wraps it in the Muse hook protocol (one silent/wake line).
cat > "$DIR/keepalive.sh" <<EOF
#!/usr/bin/env bash
# Restart this install when its processes are gone (for example after a VM swap).
# Exit 0: running, restarted, stopped on purpose or no key yet.
# Exit 1: restart failed (first failure).  Exit 2: still failing; retries every 10 min.
# DRY_RUN=1 only reports.
set -uo pipefail
DIR="$DIR"
EOF
cat >> "$DIR/keepalive.sh" <<'EOF'
LOG="$DIR/logs/keepalive.log"
FAIL="$DIR/run/keepalive.failed"
say() { printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"; }
[ -f "$DIR/run/stopped" ] && { echo "stopped on purpose (restore.sh stop)"; exit 0; }
[ -s "$DIR/run/control-plane.env" ] || { echo "no key installed yet"; exit 0; }
SAVED_MCP_PORT="" SAVED_HEALTH_PORT=""
# shellcheck disable=SC1091
. "$DIR/run/config.env" 2>/dev/null || true
# Healthy = MCP answers and the tunnel polled OpenAI successfully in the last
# KEEPALIVE_STALE_SECS (a live process with a rejected key is not healthy).
STALE="${KEEPALIVE_STALE_SECS:-300}"
up() { curl -fsS --max-time 3 "http://127.0.0.1:$1/healthz" >/dev/null 2>&1; }
last_poll() {
  curl -fsS --max-time 3 "http://127.0.0.1:$SAVED_HEALTH_PORT/metrics" 2>/dev/null | awk '
    $1 == "commands_poll_last_successful_timestamp_seconds" || index($1, "commands_poll_last_successful_timestamp_seconds{") == 1 { v = $NF }
    END { printf "%d\n", v + 0 }'
}
WHY="not running"
if [ -n "$SAVED_MCP_PORT" ] && [ -n "$SAVED_HEALTH_PORT" ] && up "$SAVED_MCP_PORT" && up "$SAVED_HEALTH_PORT"; then
  AGE=$(( $(date +%s) - $(last_poll) ))
  [ "$AGE" -lt "$STALE" ] && { rm -f "$FAIL"; echo "running"; exit 0; }
  WHY="up, but no successful poll for ${AGE}s"
fi
[ "${DRY_RUN:-0}" = "1" ] && { echo "$WHY; would run restore.sh"; exit 0; }
if [ -f "$FAIL" ] && [ $(( $(date +%s) - $(cat "$FAIL" 2>/dev/null || echo 0) )) -lt 600 ]; then
  echo "still failing; next retry within 10 min"; exit 2
fi
exec 9>"$DIR/run/keepalive.lock"
command -v flock >/dev/null 2>&1 && { flock -n 9 || { echo "a restart is already running"; exit 0; }; }
[ -f "$LOG" ] && [ "$(wc -c < "$LOG")" -gt 1000000 ] && mv -f "$LOG" "$LOG.prev"
say "$WHY; restore.sh" >> "$LOG"
bash "$DIR/restore.sh" >> "$LOG" 2>&1
RC=$?
if [ "$RC" = 0 ]; then
  rm -f "$FAIL"; say "restarted" >> "$LOG"; echo "restarted"; exit 0
fi
FIRST=1; [ -f "$FAIL" ] && FIRST=0
date +%s > "$FAIL"
VERDICT="$(tail -n 40 "$LOG" | grep '^control-plane  :' | tail -n 1)"
echo "restart failed (exit $RC) ${VERDICT#control-plane  : }; see $LOG"
[ "$FIRST" = 1 ] && exit 1 || exit 2
EOF
chmod 755 "$DIR/keepalive.sh"

cat > "$DIR/muse-hook.sh" <<EOF
#!/usr/bin/env bash
# Muse hook: keeps $DIR running across VM swaps. Copy to ~/hooks/scripts/,
# register it with the hooks tool (poll 60 s), dry_run, then enable.
RT="\$(dirname "\$0")/../runtime/hatch_hook_runtime.sh"
[ -f "\$RT" ] || RT="\$HOME/hooks/runtime/hatch_hook_runtime.sh"
. "\$RT"
OUT="\$(DRY_RUN="\${HATCH_HOOK_DRY_RUN:-0}" bash "$DIR/keepalive.sh" 2>&1)"
RC=\$?
OUT="\$(printf '%s\\n' "\$OUT" | tail -n 1)"
if [ "\$RC" = 1 ]; then wake "muse-chatgpt: \$OUT"; else silent "muse-chatgpt: \$OUT"; fi
EOF
chmod 755 "$DIR/muse-hook.sh"

# ---------- tunnel-client ----------
detect_target() {
  local os arch
  case "$(uname -s)" in Linux) os=linux ;; Darwin) os=darwin ;; *) die "unsupported OS $(uname -s)" ;; esac
  case "$(uname -m)" in x86_64|amd64) arch=amd64 ;; aarch64|arm64) arch=arm64 ;; *) die "unsupported CPU $(uname -m)" ;; esac
  printf '%s-%s\n' "$os" "$arch"
}

sha256_of() { "$PY" -c 'import hashlib,sys;print(hashlib.sha256(open(sys.argv[1],"rb").read()).hexdigest())' "$1"; }

install_client() {
  local target stamp base asset tmp want got
  target="$(detect_target)"
  stamp="$CLIENT_VERSION-$target"
  if [ -n "${TUNNEL_CLIENT_BIN:-}" ]; then
    copy_in "$TUNNEL_CLIENT_BIN" "$DIR/bin/tunnel-client" 755
    printf 'local:%s\n' "$TUNNEL_CLIENT_BIN" > "$DIR/bin/tunnel-client.version"
    return 0
  fi
  if [ -x "$DIR/bin/tunnel-client" ] && [ "$(cat "$DIR/bin/tunnel-client.version" 2>/dev/null)" = "$stamp" ]; then
    return 0
  fi
  command -v curl >/dev/null || die "curl is required to download tunnel-client"
  base="${TUNNEL_CLIENT_BASE_URL:-https://github.com/openai/tunnel-client/releases/download}/$CLIENT_VERSION"
  asset="tunnel-client-$CLIENT_VERSION-$target.zip"
  tmp="$(mktemp -d "$DIR/bin/dl.XXXXXX")"
  say "downloading $asset"
  curl -fsSL -o "$tmp/$asset" "$base/$asset" || { rm -rf "$tmp"; die "download failed: $base/$asset"; }
  curl -fsSL -o "$tmp/SHA256SUMS.txt" "$base/SHA256SUMS.txt" || { rm -rf "$tmp"; die "download failed: $base/SHA256SUMS.txt"; }
  want="$(awk -v a="$asset" '$2==a || $2=="*"a {print $1; exit}' "$tmp/SHA256SUMS.txt")"
  got="$(sha256_of "$tmp/$asset")"
  if [ -z "$want" ] || [ "$want" != "$got" ]; then
    rm -rf "$tmp"
    die "checksum mismatch for $asset (expected ${want:-<not listed>}, got $got)"
  fi
  say "sha256 OK $asset"
  "$PY" - "$tmp/$asset" "$DIR/bin/tunnel-client.new" <<'PY'
import sys, zipfile, pathlib
z = zipfile.ZipFile(sys.argv[1])
name = next(n for n in z.namelist() if n.rsplit("/", 1)[-1] == "tunnel-client")
p = pathlib.Path(sys.argv[2]); p.write_bytes(z.read(name)); p.chmod(0o755)
PY
  mv -f "$DIR/bin/tunnel-client.new" "$DIR/bin/tunnel-client"
  printf '%s\n' "$stamp" > "$DIR/bin/tunnel-client.version"
  rm -rf "$tmp"
}
install_client
say "tunnel-client: $("$DIR/bin/tunnel-client" --version 2>&1 | head -1)"

# ---------- config writer ----------
save_conf() {
  cat > "$CONF.tmp" <<EOF
SAVED_TUNNEL_ID=$TUNNEL_ID
SAVED_MCP_PORT=${MCP_PORT:-$SAVED_MCP_PORT}
SAVED_HEALTH_PORT=${HEALTH_PORT:-$SAVED_HEALTH_PORT}
SAVED_NO_SYSTEMD=$NO_SYSTEMD
SAVED_CLIENT_VERSION=$CLIENT_VERSION
EOF
  chmod 600 "$CONF.tmp" && mv -f "$CONF.tmp" "$CONF"
}

report() {  # report VERDICT
  cat <<EOF

---------------- report ----------------
dir            : $DIR
mode           : ${RUN_MODE:-not started}
mcp            : 127.0.0.1:${MCP_PORT:-?}
tunnel health  : 127.0.0.1:${HEALTH_PORT:-?}
tunnel id      : $TUNNEL_ID
control-plane  : $1
restore / rotate key: [KEY_FILE=<new key file>] bash $DIR/restore.sh
----------------------------------------
EOF
}

# ---------- api key ----------
if [ -n "${KEY_FILE:-}" ]; then
  [ -f "$KEY_FILE" ] || die "KEY_FILE not found: $KEY_FILE"
  if ! same_file "$KEY_FILE" "$KEY_DST"; then
    "$PY" - "$KEY_FILE" "$KEY_DST.tmp" <<'PY' || die "KEY_FILE has no usable key (expected CONTROL_PLANE_API_KEY=sk-... or a bare sk-... line)"
import os, re, sys
key = None
for line in open(sys.argv[1], encoding="utf-8", errors="replace").read().replace("\r", "").splitlines():
    line = line.strip().strip('"').strip("'")
    if line.startswith("export "):
        line = line[7:].strip()
    if line.startswith("CONTROL_PLANE_API_KEY="):
        line = line.split("=", 1)[1].strip().strip('"').strip("'")
    if re.fullmatch(r"[A-Za-z0-9_\-]{20,}", line):
        key = line
        break
if not key:
    sys.exit(1)
fd = os.open(sys.argv[2], os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
os.write(fd, ("CONTROL_PLANE_API_KEY=%s\n" % key).encode())
os.close(fd)
PY
    mv -f "$KEY_DST.tmp" "$KEY_DST"
    chmod 600 "$KEY_DST"
    say "key installed at $KEY_DST (0600)"
    if [ "${CONSUME_KEY_FILE:-0}" = "1" ]; then
      "$PY" -c 'import os,sys;p=sys.argv[1];n=os.path.getsize(p);f=open(p,"r+b");f.write(b"\0"*n);f.flush();os.fsync(f.fileno());f.close();os.remove(p)' "$KEY_FILE"
      say "source key file overwritten and deleted"
    fi
  fi
fi
if [ ! -s "$KEY_DST" ]; then
  save_conf
  say "no API key yet. Next: KEY_FILE=<key file> bash $DIR/restore.sh"
  report "KEY MISSING"
  exit 3
fi

# ---------- stop our previous processes, then choose ports ----------
stop_all

choose_port() {  # choose_port EXPLICIT SAVED OTHER
  if [ -n "$1" ]; then port_free "$1" || die "port $1 is in use"; printf '%s\n' "$1"; return; fi
  if [ -n "$2" ] && [ "$2" != "$3" ] && port_free "$2"; then printf '%s\n' "$2"; return; fi
  local p; p="$(pick_port)"
  while [ "$p" = "$3" ]; do p="$(pick_port)"; done
  printf '%s\n' "$p"
}
MCP_PORT="$(choose_port "${MCP_PORT:-}" "$SAVED_MCP_PORT" "")"
HEALTH_PORT="$(choose_port "${HEALTH_PORT:-}" "$SAVED_HEALTH_PORT" "$MCP_PORT")"
say "ports: mcp=$MCP_PORT health=$HEALTH_PORT"
save_conf

# ---------- service.env (no secrets) ----------
OLD_PROXY="$(grep -E '^(HTTPS?_PROXY|NO_PROXY|https?_proxy|no_proxy)=' "$DIR/run/service.env" 2>/dev/null || true)"
{
  printf 'MCP_HOST=127.0.0.1\nMCP_PORT=%s\nMCP_PID_FILE=%s\n' "$MCP_PORT" "$DIR/run/mcp.pid"
  # HTTP(S)_PROXY only - ALL_PROXY made the poll stall in practice.
  NEW_PROXY=""
  for v in HTTP_PROXY HTTPS_PROXY NO_PROXY http_proxy https_proxy no_proxy; do
    val="${!v:-}"
    if [ -n "$val" ]; then printf '%s=%s\n' "$v" "$val"; NEW_PROXY=1; fi
  done
  [ -z "$NEW_PROXY" ] && [ -n "$OLD_PROXY" ] && printf '%s\n' "$OLD_PROXY"
} > "$DIR/run/service.env"
chmod 600 "$DIR/run/service.env"

TUNNEL_ARGS=(run
  --control-plane.tunnel-id "$TUNNEL_ID"
  --control-plane.api-key env:CONTROL_PLANE_API_KEY
  --mcp.server-url "url=http://127.0.0.1:$MCP_PORT/mcp"
  --health.listen-addr "127.0.0.1:$HEALTH_PORT"
  --pid.file "$DIR/run/tunnel.pid")

# ---------- units (always written, so restore works after a VM swap) ----------
cat > "$DIR/systemd/$UNIT_MCP" <<EOF
$MARKER
[Unit]
Description=Minimal MCP server for the Secure MCP Tunnel (muse-chatgpt-setup)
After=network-online.target

[Service]
Type=simple
WorkingDirectory=$DIR
EnvironmentFile=$DIR/run/service.env
Environment=PYTHONUNBUFFERED=1
ExecStart=$PY $DIR/muse-mcp.py
Restart=always
RestartSec=2

[Install]
WantedBy=multi-user.target
EOF

cat > "$DIR/systemd/$UNIT_TUN" <<EOF
$MARKER
[Unit]
Description=OpenAI Secure MCP Tunnel client (muse-chatgpt-setup)
After=network-online.target $UNIT_MCP
Wants=$UNIT_MCP

[Service]
Type=simple
WorkingDirectory=$DIR
EnvironmentFile=$DIR/run/service.env
EnvironmentFile=$KEY_DST
ExecStart=$DIR/bin/tunnel-client ${TUNNEL_ARGS[*]}
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF

# ---------- start: MCP first, wait for its port, then the tunnel ----------
RUN_MODE=nohup
if [ "$NO_SYSTEMD" != "1" ] && have_systemd; then RUN_MODE=systemd; fi

START_EPOCH="$(date +%s)"
if [ "$RUN_MODE" = systemd ]; then
  for u in "$UNIT_MCP" "$UNIT_TUN"; do
    if [ -f "/etc/systemd/system/$u" ] && ! unit_is_ours "/etc/systemd/system/$u"; then
      die "/etc/systemd/system/$u exists and was not created by this installer; set INSTANCE=<other name>"
    fi
    install -m 644 "$DIR/systemd/$u" "/etc/systemd/system/$u"
  done
  systemctl daemon-reload
  systemctl enable "$UNIT_MCP" "$UNIT_TUN" >/dev/null 2>&1 || true
  systemctl restart "$UNIT_MCP"
  wait_port "$MCP_PORT" 15 || { report "MCP FAILED TO START"; exit 4; }
  START_EPOCH="$(date +%s)"
  systemctl restart "$UNIT_TUN"
else
  SETSID=""; command -v setsid >/dev/null 2>&1 && SETSID=setsid
  [ -f "$DIR/logs/mcp.log" ] && mv -f "$DIR/logs/mcp.log" "$DIR/logs/mcp.prev.log"
  [ -f "$DIR/logs/tunnel.log" ] && mv -f "$DIR/logs/tunnel.log" "$DIR/logs/tunnel.prev.log"
  ( cd "$DIR" && set -a && . "$DIR/run/service.env" && set +a && PYTHONUNBUFFERED=1 \
      exec nohup $SETSID "$PY" "$DIR/muse-mcp.py" ) </dev/null >>"$DIR/logs/mcp.log" 2>&1 &
  echo $! > "$DIR/run/mcp.pid"
  wait_port "$MCP_PORT" 15 || { report "MCP FAILED TO START"; exit 4; }
  START_EPOCH="$(date +%s)"
  ( cd "$DIR" && set -a && . "$DIR/run/service.env" && . "$KEY_DST" && set +a && \
      exec nohup $SETSID "$DIR/bin/tunnel-client" "${TUNNEL_ARGS[@]}" ) </dev/null >>"$DIR/logs/tunnel.log" 2>&1 &
  TUN_SHELL_PID=$!
fi
say "started ($RUN_MODE): mcp then tunnel"

# ---------- verify ----------
# /healthz and /readyz are local only. The tunnel's own metric
# commands_poll_last_successful_timestamp_seconds (the same check as
# `tunnel-client health --require-control-plane-poll`) is set on the first
# successful poll of THIS process, whether or not an earlier poll failed.
poll_metric() {
  "$PY" - "$HEALTH_PORT" "$START_EPOCH" <<'PY'
import sys, urllib.request
port, start = sys.argv[1], float(sys.argv[2])
try:
    body = urllib.request.urlopen("http://127.0.0.1:%s/metrics" % port, timeout=2).read().decode()
except Exception:
    sys.exit(1)
name = "commands_poll_last_successful_timestamp_seconds"
for line in body.splitlines():
    line = line.strip()
    if line.startswith("#") or not (line == name or line.startswith(name + " ") or line.startswith(name + "{")):
        continue
    try:
        v = float(line.split()[-1])
    except ValueError:
        continue
    sys.exit(0 if v > 0 and v >= start - 5 else 1)
sys.exit(1)
PY
}

tunnel_log() {
  if [ "$RUN_MODE" = systemd ]; then
    journalctl -u "$UNIT_TUN" --since "@$START_EPOCH" --no-pager -o cat 2>/dev/null || true
  else
    cat "$DIR/logs/tunnel.log" 2>/dev/null || true
  fi
}

tunnel_alive() {
  if [ "$RUN_MODE" = systemd ]; then
    systemctl is-active --quiet "$UNIT_TUN"
  else
    ours_pid "$DIR/run/tunnel.pid" >/dev/null || kill -0 "${TUN_SHELL_PID:-0}" 2>/dev/null
  fi
}

redact() { sed -E 's/sk-[A-Za-z0-9_-]{6,}/sk-[redacted]/g' | cut -c1-240; }

VERIFY_TIMEOUT="${VERIFY_TIMEOUT:-90}"
say "waiting up to ${VERIFY_TIMEOUT}s for a successful control-plane poll"
VERDICT="PENDING"
DEADLINE=$(( $(date +%s) + VERIFY_TIMEOUT ))
while :; do
  if poll_metric; then VERDICT="OK"; break; fi
  LOGTXT="$(tunnel_log)"
  if printf '%s' "$LOGTXT" | grep -qE 'status_code=401|invalid_api_key|Incorrect API key'; then VERDICT="KEY REJECTED"; break; fi
  if printf '%s' "$LOGTXT" | grep -qE 'status_code=403'; then VERDICT="KEY FORBIDDEN"; break; fi
  if ! tunnel_alive; then sleep 1; tunnel_alive || { VERDICT="TUNNEL EXITED"; break; }; fi
  [ "$(date +%s)" -ge "$DEADLINE" ] && break
  sleep 1
done

say "healthz: $(curl -fsS "http://127.0.0.1:$HEALTH_PORT/healthz" 2>/dev/null || echo unavailable)"
say "readyz:  $(curl -fsS "http://127.0.0.1:$HEALTH_PORT/readyz" 2>/dev/null || echo unavailable)  (local only)"
say "mcp:     $(curl -fsS "http://127.0.0.1:$MCP_PORT/healthz" 2>/dev/null || echo unavailable)"

case "$VERDICT" in
  OK) say "control-plane: OK - a poll reached OpenAI" ;;
  PENDING)
    say "control-plane: PENDING - no successful poll yet. Usually the egress approval card"
    say "  for api.openai.com is waiting: choose 'always allow this site', then run"
    say "    bash $DIR/restore.sh"
    say "  Do not create the ChatGPT connector until this says OK."
    tunnel_log | grep -E 'poll (failed|timed out)' | tail -1 | redact | sed 's/^/  last poll error: /' || true ;;
  "KEY REJECTED") say "control-plane: KEY REJECTED - the key is wrong or revoked. Rotate: KEY_FILE=<new> bash $DIR/restore.sh" ;;
  "KEY FORBIDDEN") say "control-plane: KEY FORBIDDEN - the key lacks Tunnels Read+Use, or the tunnel is in another organization" ;;
  "TUNNEL EXITED") say "tunnel-client exited; last lines:"; tunnel_log | tail -5 | redact ;;
esac

report "$VERDICT"
case "$VERDICT" in
  OK) exit 0 ;;
  PENDING) exit 2 ;;
  KEY*) exit 3 ;;
  *) exit 4 ;;
esac
