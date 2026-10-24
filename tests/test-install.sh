#!/usr/bin/env bash
# Isolated host installer tests; no real service/credentials/network changes.
set -euo pipefail
exec python3 "$(cd "$(dirname "$0")" && pwd)/test-host.py"
