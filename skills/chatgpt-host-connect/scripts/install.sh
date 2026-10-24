#!/usr/bin/env bash
# Compatibility entry point: no Muse messages, hooks or nohup daemon.
set -euo pipefail
ROOT=$(cd "$(dirname "$0")" && pwd)
# Do not install dependencies without the same deployment authorization.
case " $* " in *' --allow-control '*) ;; *) echo 'Installation requires --allow-control' >&2; exit 1 ;; esac
source "$ROOT/bootstrap.sh"
prepare_python
exec "$HOST_SETUP_PYTHON" "$ROOT/host.py" install "$@"
