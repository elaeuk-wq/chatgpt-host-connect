#!/usr/bin/env bash
# Offline test of scripts/install.sh in nohup mode with a mock tunnel-client.
# Usage: bash tests/test-install.sh [work-dir]
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
SRC="$HERE/../skills/muse-chatgpt-setup/scripts"
WORK="${1:-$(mktemp -d "${TMPDIR:-/tmp}/muse-install-test.XXXXXX")}"
mkdir -p "$WORK"
DIR="$WORK/inst"
MOCK="$HERE/mock-tunnel-client"
chmod +x "$MOCK"
TID="tunnel_test0123456789abcdef"
PASS=0 FAIL=0

ok()   { PASS=$((PASS+1)); echo "  PASS $*"; }
bad()  { FAIL=$((FAIL+1)); echo "  FAIL $*"; }
check(){ if eval "$2"; then ok "$1"; else bad "$1"; fi; }
keyfile() { printf 'CONTROL_PLANE_API_KEY=%s\n' "$2" > "$1"; chmod 600 "$1"; }
mode_of() { stat -f '%Lp' "$1" 2>/dev/null || stat -c '%a' "$1"; }
procs()  { ps -axo pid=,command= | grep -F "$DIR/" | grep -v grep | grep -cE 'mock|tunnel-client|muse-mcp.py' ; }
runinst(){ # runinst LOGNAME [env...] -- command...
  local name="$1"; shift
  env DIR="$DIR" NO_SYSTEMD=1 TUNNEL_CLIENT_BIN="$MOCK" VERIFY_TIMEOUT="${VT:-20}" "$@" > "$WORK/$name.out" 2>&1
  echo $? > "$WORK/$name.rc"
}
rc() { cat "$WORK/$1.rc"; }
fp() { "$(command -v python3)" -c 'import hashlib,sys;print(hashlib.sha256(sys.argv[1].encode()).hexdigest()[:8])' "$1"; }

cleanup() { [ -x "$DIR/restore.sh" ] && bash "$DIR/restore.sh" stop >/dev/null 2>&1; }
trap cleanup EXIT

KEY_GOOD="test-key-good-AAAAAAAAAAAAAAAAAAAA"
KEY_FLAKY="test-key-flaky-BBBBBBBBBBBBBBBBBBBB"
KEY_BAD="test-key-bad-CCCCCCCCCCCCCCCCCCCCCC"
KEY_PEND="test-key-pending-DDDDDDDDDDDDDDDDDD"

echo "work dir: $WORK"

echo "T1 no key on a fresh machine -> KEY MISSING, restore.sh already generated"
runinst t1 TUNNEL_ID="$TID" bash "$SRC/install.sh"
check "exit 3" '[ "$(rc t1)" = 3 ]'
check "report says KEY MISSING" 'grep -q "control-plane  : KEY MISSING" "$WORK/t1.out"'
check "restore.sh exists" '[ -x "$DIR/restore.sh" ]'
check "no processes started" '[ "$(procs)" = 0 ]'

echo "T2 key arrives later via restore.sh (first poll succeeds, no 'recovered' line)"
keyfile "$WORK/k-good" "$KEY_GOOD"
runinst t2 KEY_FILE="$WORK/k-good" CONSUME_KEY_FILE=1 bash "$DIR/restore.sh"
check "exit 0" '[ "$(rc t2)" = 0 ]'
check "verdict OK" 'grep -q "control-plane  : OK" "$WORK/t2.out"'
check "log has no 'poller recovered' (first-time success detected anyway)" '! grep -q "poller recovered" "$DIR/logs/tunnel.log"'
check "source key file consumed" '[ ! -e "$WORK/k-good" ]'
check "key file is 0600" '[ "$(mode_of "$DIR/run/control-plane.env")" = 600 ]'
check "run dir is 0700" '[ "$(mode_of "$DIR/run")" = 700 ]'
check "exactly 2 processes" '[ "$(procs)" = 2 ]'
check "key not in any process argv" '! ps -axo command= | grep -F "$KEY_GOOD" | grep -vq grep'
check "key not in output/logs/units" '! grep -rqF "$KEY_GOOD" "$WORK"/*.out "$DIR/logs" "$DIR/systemd" "$DIR/run/service.env" "$DIR/run/config.env"'
check "tunnel unit uses EnvironmentFile for the key" 'grep -q "^EnvironmentFile=$DIR/run/control-plane.env" "$DIR/systemd/muse-chatgpt-tunnel.service"'
check "unit has no env \$(cat" '! grep -q "cat " "$DIR/systemd/muse-chatgpt-tunnel.service"'
P1="$(grep '^SAVED_MCP_PORT=' "$DIR/run/config.env")"
OLDPIDS="$(cat "$DIR/run/mcp.pid" "$DIR/run/tunnel.pid" | tr '\n' ' ')"

echo "T3 re-run install.sh from inside \$DIR (old 'cp same file' crash)"
runinst t3 bash -c "cd '$DIR' && cp '$SRC/muse-mcp.py' ./muse-mcp.py && TUNNEL_ID=$TID bash install.sh"
check "exit 0" '[ "$(rc t3)" = 0 ]'
check "still exactly 2 processes (old ones stopped)" '[ "$(procs)" = 2 ]'
check "old pids gone" 'for p in $OLDPIDS; do kill -0 $p 2>/dev/null && exit 1; done; true'
check "ports kept" '[ "$(grep "^SAVED_MCP_PORT=" "$DIR/run/config.env")" = "$P1" ]'

echo "T4 plain restore.sh (VM restart)"
runinst t4 bash "$DIR/restore.sh"
check "exit 0" '[ "$(rc t4)" = 0 ]'
check "exactly 2 processes" '[ "$(procs)" = 2 ]'
check "previous log rotated, not re-read" '[ -f "$DIR/logs/tunnel.prev.log" ]'

echo "T5 key rotation through restore.sh (fail twice, then recover)"
keyfile "$WORK/k-flaky" "$KEY_FLAKY"
runinst t5 KEY_FILE="$WORK/k-flaky" CONSUME_KEY_FILE=1 bash "$DIR/restore.sh"
check "exit 0" '[ "$(rc t5)" = 0 ]'
check "running tunnel uses the new key" 'grep -q "key_fp=$(fp "$KEY_FLAKY")" "$DIR/logs/tunnel.log"'
check "'poller recovered' case judged OK" 'grep -q "poller recovered" "$DIR/logs/tunnel.log" && grep -q "control-plane  : OK" "$WORK/t5.out"'
check "exactly 2 processes" '[ "$(procs)" = 2 ]'

echo "T6 stale success in previous log must not count (pending key)"
keyfile "$WORK/k-pend" "$KEY_PEND"
VT=6 runinst t6 KEY_FILE="$WORK/k-pend" bash "$DIR/restore.sh"
check "exit 2 PENDING" '[ "$(rc t6)" = 2 ] && grep -q "control-plane  : PENDING" "$WORK/t6.out"'
check "prev log still holds the old 'recovered' line" 'grep -q "poller recovered" "$DIR/logs/tunnel.prev.log"'
check "key file without CONSUME is left in place" '[ -f "$WORK/k-pend" ]'

echo "T7 rejected key"
keyfile "$WORK/k-bad" "$KEY_BAD"
runinst t7 KEY_FILE="$WORK/k-bad" bash "$DIR/restore.sh"
check "exit 3 KEY REJECTED" '[ "$(rc t7)" = 3 ] && grep -q "control-plane  : KEY REJECTED" "$WORK/t7.out"'

echo "T8 bare-key file format + stop"
printf '%s\n' "$KEY_GOOD" > "$WORK/k-bare"
runinst t8 KEY_FILE="$WORK/k-bare" bash "$DIR/restore.sh"
check "exit 0" '[ "$(rc t8)" = 0 ]'
runinst t8b bash "$DIR/restore.sh" stop
check "stop leaves no processes" '[ "$(procs)" = 0 ]'

echo "T10 keepalive: leaves a stopped install alone, restarts after a VM swap, wakes once on failure"
HK="$WORK/hooks"; mkdir -p "$HK/runtime" "$HK/scripts"
cat > "$HK/runtime/hatch_hook_runtime.sh" <<'EOF'
silent() { printf 'HATCH_HOOK_RESULT:{"decision":"silent","reason":"%s"}\n' "$1"; }
wake()   { printf 'HATCH_HOOK_RESULT:{"decision":"wake","reason":"%s"}\n' "$1"; }
EOF
cp "$DIR/muse-hook.sh" "$HK/scripts/muse-chatgpt-keepalive.sh"
hook() { env NO_SYSTEMD=1 TUNNEL_CLIENT_BIN="$MOCK" VERIFY_TIMEOUT="${VT:-20}" "$@" bash "$HK/scripts/muse-chatgpt-keepalive.sh" 2>&1 | tail -n 1; }
check "stopped install: silent, nothing started" 'hook | grep -q "\"silent\".*stopped on purpose" && [ "$(procs)" = 0 ]'
runinst t10 bash "$DIR/restore.sh"
check "running: silent" 'hook | grep -q "\"silent\".*running"'
kill "$(cat "$DIR/run/mcp.pid")" "$(cat "$DIR/run/tunnel.pid")"; sleep 1
check "dry run after a swap only reports" 'hook HATCH_HOOK_DRY_RUN=1 | grep -q "would run restore.sh" && [ "$(procs)" = 0 ]'
check "after a swap: restarted, silent, 2 processes" 'hook | grep -q "\"silent\".*restarted" && [ "$(procs)" = 2 ]'
bash "$DIR/restore.sh" stop >/dev/null 2>&1; rm -f "$DIR/run/stopped"
printf 'CONTROL_PLANE_API_KEY=%s\n' "$KEY_BAD" > "$DIR/run/control-plane.env"
check "restart fails: wake once" 'hook | grep -q "\"wake\".*KEY REJECTED"'
check "still failing: silent, no retry storm" 'hook | grep -q "\"silent\".*still failing"'
check "keepalive output carries no key" '! grep -rqF "$KEY_BAD" "$DIR/logs/keepalive.log"'
bash "$DIR/restore.sh" stop >/dev/null 2>&1

echo "T9 download path: checksum verified against SHA256SUMS.txt (local mirror)"
MIR="$WORK/mirror/v9.9.9-test"; mkdir -p "$MIR" "$WORK/zipsrc"
cp "$MOCK" "$WORK/zipsrc/tunnel-client"
T="$(uname -s | tr A-Z a-z)-$(uname -m | sed 's/x86_64/amd64/;s/aarch64/arm64/')"
ASSET="tunnel-client-v9.9.9-test-$T.zip"
(cd "$WORK/zipsrc" && python3 -c 'import zipfile,sys;z=zipfile.ZipFile(sys.argv[1],"w");z.write("tunnel-client");z.close()' "$MIR/$ASSET")
SUM="$(python3 -c 'import hashlib,sys;print(hashlib.sha256(open(sys.argv[1],"rb").read()).hexdigest())' "$MIR/$ASSET")"
printf '%s  %s\n' "0000000000000000000000000000000000000000000000000000000000000000" "$ASSET" > "$MIR/SHA256SUMS.txt"
DIR2="$WORK/inst-dl"
env DIR="$DIR2" NO_SYSTEMD=1 TUNNEL_ID="$TID" TUNNEL_CLIENT_VERSION=v9.9.9-test TUNNEL_CLIENT_BASE_URL="file://$WORK/mirror" bash "$SRC/install.sh" > "$WORK/t9a.out" 2>&1
check "tampered checksum refused" 'grep -q "checksum mismatch" "$WORK/t9a.out" && [ ! -e "$DIR2/bin/tunnel-client" ]'
printf '%s  %s\n' "$SUM" "$ASSET" > "$MIR/SHA256SUMS.txt"
env DIR="$DIR2" NO_SYSTEMD=1 TUNNEL_ID="$TID" TUNNEL_CLIENT_VERSION=v9.9.9-test TUNNEL_CLIENT_BASE_URL="file://$WORK/mirror" bash "$SRC/install.sh" > "$WORK/t9b.out" 2>&1
check "correct checksum accepted, arch-specific asset used ($T)" 'grep -q "sha256 OK $ASSET" "$WORK/t9b.out" && [ -x "$DIR2/bin/tunnel-client" ]'

echo
echo "result: $PASS passed, $FAIL failed"
[ "$FAIL" = 0 ]
