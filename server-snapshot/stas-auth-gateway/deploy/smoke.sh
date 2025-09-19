#!/usr/bin/env bash
set -euo pipefail

: "${TARGET_DOMAIN:=intervals.stas.run}"

# Load optional keys from env if available
: "${STAS_API_KEY:=}"
: "${MCP_API_KEY:=}"

base="https://${TARGET_DOMAIN}"

echo "==> /gw/healthz"
curl -fsS "$base/gw/healthz" | cat

echo

echo "==> STAS API user_summary (requires STAS_API_KEY in env)"
if [[ -n "$STAS_API_KEY" ]]; then
  curl -fsS -H "X-API-Key: ${STAS_API_KEY}" \
    "$base/api/db/user_summary?user_id=${DEFAULT_USER_ID:-95192039}" | jq . | cat
else
  echo "Skipped: STAS_API_KEY not set" >&2
fi

echo

echo "==> MCP bridge activities (requires MCP_API_KEY in env)"
if [[ -n "$MCP_API_KEY" ]]; then
  curl -fsS -H "X-API-Key: ${MCP_API_KEY}" \
    "$base/icu/activities?days=7" | jq . | cat
else
  echo "Skipped: MCP_API_KEY not set" >&2
fi

echo

echo "==> SSE (5s)"
curl -fsS "$base/sse" --max-time 5 | head -n 5 | cat

echo
[32mAll smoke checks attempted.[0m
