#!/usr/bin/env bash
set -euo pipefail

BASE_URL="${GW_BASE_URL:-http://127.0.0.1:${PORT:-3340}}"

curl -sS "${BASE_URL}/gw/debug/echo_auth" -H "Authorization: Bearer invalid" >/dev/null || exit 1

# Optional local-only-by-default check for /gw/api/db/activity_detail.
# No user_id is required; the gateway infers it from the Bearer token.
# Enable explicitly:
#   GW_ACTIVITY_DETAIL_TOKEN=... GW_ACTIVITY_DETAIL_TRAINING_ID=... scripts/smoke-gw.sh
if [[ -n "${GW_ACTIVITY_DETAIL_TOKEN:-}" && -n "${GW_ACTIVITY_DETAIL_TRAINING_ID:-}" ]]; then
  encoded_training_id="$(node -e "process.stdout.write(encodeURIComponent(process.argv[1]))" "$GW_ACTIVITY_DETAIL_TRAINING_ID")"
  curl -sS \
    "${BASE_URL}/gw/api/db/activity_detail?training_id=${encoded_training_id}" \
    -H "Authorization: Bearer ${GW_ACTIVITY_DETAIL_TOKEN}" \
    >/dev/null
else
  echo "Skipping optional activity_detail smoke; set GW_ACTIVITY_DETAIL_TOKEN and GW_ACTIVITY_DETAIL_TRAINING_ID to enable." >&2
fi

exit 0
