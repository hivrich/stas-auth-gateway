#!/usr/bin/env bash
set -euo pipefail
BASE="${1:-http://127.0.0.1:3338/gw}"
UID="${2:-95192039}"
AT="t_$(printf '{"uid":"%s","ts":%s}' "$UID" "$(date +%s)" | openssl base64 -A | tr '+/' '-_' | tr -d '=')"
curl -fsS -H "Authorization: Bearer $AT" "$BASE/trainings?days=3&limit=3" | jq -e 'type=="array"'
curl -fsS -H "Authorization: Bearer $AT" "$BASE/api/db/user_summary" | jq -e '.ok==true'
curl -fsS -H "Authorization: Bearer $AT" "$BASE/icu/events?days=3" | jq -e 'type=="array"'
echo "[smoke_ok]"
