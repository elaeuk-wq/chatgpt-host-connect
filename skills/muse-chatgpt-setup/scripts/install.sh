#!/usr/bin/env bash
# Greenfield installer: OpenAI Secure MCP Tunnel + a minimal MCP server.
#
# Assumes NOTHING exists: no tunnel client, no MCP server, no systemd units,
# no previous run. Installs into a single self-contained directory and never
# touches services it did not create.
#
# Usage (on the target VM):
#   TUNNEL_ID=tunnel_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx \
#   KEY_FILE=/path/to/control-plane.env \
#   bash install.sh
#
# Optional:
#   DIR=~/muse-chatgpt          install root (default)
#   MCP_PORT=, HEALTH_PORT=      default: auto-pick free ports
#   NO_SYSTEMD=1                force the nohup fallback
#   MCP_SRC=/path/to/muse-mcp.py  default: ./muse-mcp.py next to this script
#
# Prints a report. Never prints the API key.

set -euo pipefail

: "${TUNNEL_ID:?set TUNNEL_ID=tunnel_...}"
DIR="${DIR:-$HOME/muse-chatgpt}"
UNIT_MCP="muse-mcp.service"
UNIT_TUN="muse-tunnel.service"
CLIENT_VERSION="v0.0.11"

say() { printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"; }
die() { say "ERROR: $*"; exit 1; }

# ---------- prerequisites ----------
command -v curl >/dev/null || die "curl is required"
command -v python3 >/dev/null || die "python3 is required"
[ -n "${TUNNEL_ID:-}" ] || die "TUNNEL_ID is required"
[ -n "${KEY_FILE:-}" ] || die "KEY_FILE is required (a file containing CONTROL_PLANE_API_KEY=...)"

MCP_SRC="${MCP_SRC:-$(cd "$(dirname "$0")" && pwd)/muse-mcp.py}"
[ -f "$MCP_SRC" ] || die "muse-mcp.py not found at $MCP_SRC"

mkdir -p "$DIR"/{bin,run,systemd,logs}
chmod 700 "$DIR"
cp "$MCP_SRC" "$DIR/muse-mcp.py"

# ---------- api key ----------
KEYLINE="$(tr -d '\r' < "$KEY_FILE" | grep -E '^CONTROL_PLANE_API_KEY=' | head -1 || true)"
[ -n "$KEYLINE" ] || die "KEY_FILE does not contain CONTROL_PLANE_API_KEY=..."
umask 077
printf '%s\n' "$KEYLINE" > "$DIR/run/control-plane.env"
chmod 600 "$DIR/run/control-plane.env"
unset KEYLINE
say "wrote $DIR/run/control-plane.env (0600)"

# ---------- ports ----------
pick_port() {
  python3 - <<'PY'
import socket
s = socket.socket(); s.bind(("127.0.0.1", 0)); print(s.getsockname()[1]); s.close()
PY
}
MCP_PORT="${MCP_PORT:-$(pick_port)}"
HEALTH_PORT="${HEALTH_PORT:-$(pick_port)}"
say "ports: mcp=$MCP_PORT health=$HEALTH_PORT"

# ---------- tunnel client ----------
if [ ! -x "$DIR/bin/tunnel-client" ]; then
  say "downloading tunnel-client $CLIENT_VERSION"
  ZIP="$DIR/bin/tunnel-client-${CLIENT_VERSION}-linux-amd64.zip"
  URL="https://github.com/openai/tunnel-client/releases/download/${CLIENT_VERSION}/tunnel-client-${CLIENT_VERSION}-linux-amd64.zip"
  curl -fsSL -o "$ZIP" "$URL" || die "download failed: $URL"
  python3 - "$ZIP" "$DIR/bin/tunnel-client" <<'PY'
import sys, zipfile, pathlib
z = zipfile.ZipFile(sys.argv[1])
name = next(n for n in z.namelist() if n.endswith("tunnel-client") and not n.endswith("/"))
p = pathlib.Path(sys.argv[2]); p.write_bytes(z.read(name)); p.chmod(0o755)
PY
  rm -f "$ZIP"
fi
say "tunnel-client: $("$DIR/bin/tunnel-client" --version 2>&1 | head -1)"

# ---------- env file for units ----------
cat > "$DIR/run/service.env" <<EOF
MCP_HOST=127.0.0.1
MCP_PORT=$MCP_PORT
CONTROL_PLANE_TUNNEL_ID=$TUNNEL_ID
CONTROL_PLANE_API_KEY_FILE=$DIR/run/control-plane.env
HEALTH_PORT=$HEALTH_PORT
EOF
chmod 600 "$DIR/run/service.env"

# ---------- units ----------
cat > "$DIR/systemd/$UNIT_MCP" <<EOF
[Unit]
Description=Minimal MCP server for Secure MCP Tunnel (muse-chatgpt-setup)
After=network-online.target

[Service]
Type=simple
WorkingDirectory=$DIR
EnvironmentFile=$DIR/run/service.env
Environment=PYTHONUNBUFFERED=1
ExecStart=/usr/bin/python3 $DIR/muse-mcp.py
Restart=always
RestartSec=2

[Install]
WantedBy=multi-user.target
EOF

cat > "$DIR/systemd/$UNIT_TUN" <<EOF
[Unit]
Description=OpenAI Secure MCP Tunnel client (muse-chatgpt-setup)
After=network-online.target $UNIT_MCP
Wants=$UNIT_MCP

[Service]
Type=simple
WorkingDirectory=$DIR
EnvironmentFile=$DIR/run/service.env
ExecStart=/bin/bash -c 'env \$(cat \$CONTROL_PLANE_API_KEY_FILE) exec $DIR/bin/tunnel-client run --control-plane.tunnel-id \$CONTROL_PLANE_TUNNEL_ID --control-plane.api-key env:CONTROL_PLANE_API_KEY --mcp.server-url url=http://127.0.0.1:\$MCP_PORT/mcp --health.listen-addr 127.0.0.1:\$HEALTH_PORT --pid.file $DIR/run/tunnel.pid'
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF

# ---------- restore.sh (survives VM replacement) ----------
cat > "$DIR/restore.sh" <<'EOF'
#!/usr/bin/env bash
# Re-install the systemd units and restart in the correct order.
# Safe to run after the VM is rebuilt (only $HOME survives).
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
say() { printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"; }

if [ "$(id -u)" = "0" ] && [ -d /etc/systemd/system ]; then
  install -m 644 "$DIR/systemd/muse-mcp.service" /etc/systemd/system/
  install -m 644 "$DIR/systemd/muse-tunnel.service" /etc/systemd/system/
  systemctl daemon-reload
  systemctl enable muse-mcp.service muse-tunnel.service >/dev/null 2>&1 || true
  # ORDER MATTERS: mcp first, wait for its port, then the tunnel.
  systemctl restart muse-mcp.service
  . "$DIR/run/service.env"
  for i in $(seq 1 30); do
    if python3 -c "import socket,sys;s=socket.socket();s.settimeout(1);sys.exit(0 if s.connect_ex(('127.0.0.1',$MCP_PORT))==0 else 1)"; then break; fi
    sleep 0.5
  done
  systemctl restart muse-tunnel.service
  say "restored: muse-mcp.service + muse-tunnel.service"
else
  say "no systemd: start manually -> python3 $DIR/muse-mcp.py & then tunnel-client run ..."
fi
EOF
chmod 755 "$DIR/restore.sh"

# ---------- start ----------
wait_port() {
  python3 - "$1" <<'PY'
import socket, sys, time
port = int(sys.argv[1])
for _ in range(60):
    s = socket.socket(); s.settimeout(1)
    if s.connect_ex(("127.0.0.1", port)) == 0: sys.exit(0)
    s.close(); time.sleep(0.5)
sys.exit(1)
PY
}

USE_SYSTEMD=0
if [ "${NO_SYSTEMD:-0}" != "1" ] && [ "$(id -u)" = "0" ] && [ -d /etc/systemd/system ] && command -v systemctl >/dev/null; then
  install -m 644 "$DIR/systemd/$UNIT_MCP" "/etc/systemd/system/$UNIT_MCP"
  install -m 644 "$DIR/systemd/$UNIT_TUN" "/etc/systemd/system/$UNIT_TUN"
  systemctl daemon-reload
  systemctl enable "$UNIT_MCP" "$UNIT_TUN" >/dev/null 2>&1 || true
  systemctl restart "$UNIT_MCP"
  wait_port "$MCP_PORT" || say "WARN: mcp port not accepting yet"
  systemctl restart "$UNIT_TUN"
  USE_SYSTEMD=1
else
  ( cd "$DIR" && set -a && . "$DIR/run/service.env" && set +a && exec nohup python3 muse-mcp.py >> logs/mcp.log 2>&1 ) &
  echo $! > "$DIR/run/mcp.pid"
  wait_port "$MCP_PORT" || say "WARN: mcp port not accepting yet"
  ( cd "$DIR" && set -a && . run/control-plane.env && set +a && exec nohup ./bin/tunnel-client run \
      --control-plane.tunnel-id "$TUNNEL_ID" \
      --control-plane.api-key env:CONTROL_PLANE_API_KEY \
      --mcp.server-url "url=http://127.0.0.1:$MCP_PORT/mcp" \
      --health.listen-addr "127.0.0.1:$HEALTH_PORT" \
      --pid.file "$DIR/run/tunnel.pid" >> logs/tunnel.log 2>&1 ) &
  echo $! > "$DIR/run/tunnel.pid.nohup"
fi

# ---------- verify ----------
say "waiting for tunnel readiness"
OK=0
for i in $(seq 1 40); do
  if curl -fsS "http://127.0.0.1:$HEALTH_PORT/readyz" >/tmp/_ready.$$ 2>/dev/null; then OK=1; break; fi
  sleep 1
done
say "healthz: $(curl -fsS "http://127.0.0.1:$HEALTH_PORT/healthz" 2>/dev/null || echo unavailable)"
say "readyz:  $(cat /tmp/_ready.$$ 2>/dev/null || echo unavailable)"
rm -f /tmp/_ready.$$
say "mcp:     $(curl -fsS "http://127.0.0.1:$MCP_PORT/healthz" 2>/dev/null || echo unavailable)"

cat <<EOF

---------------- report ----------------
dir            : $DIR
mode           : $([ "$USE_SYSTEMD" = 1 ] && echo systemd || echo nohup)
mcp            : 127.0.0.1:$MCP_PORT
tunnel health  : 127.0.0.1:$HEALTH_PORT
tunnel id      : $TUNNEL_ID
ready          : $([ "$OK" = 1 ] && echo yes || echo NO)
restore after VM rebuild: bash $DIR/restore.sh
----------------------------------------
EOF
