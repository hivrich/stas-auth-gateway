#!/usr/bin/env bash
set -euo pipefail
URL="http://127.0.0.1:${PORT:-3340}/gw/debug/echo_auth"
curl -sS "$URL" -H "Authorization: Bearer invalid" >/dev/null || exit 1
exit 0
