#!/usr/bin/env bash
set -euo pipefail

USER_ID=95192039
TARGET_DOMAIN='intervals.stas.run'
STAS_API_KEY='7ca1e3d9d8bb76a1297a9c7d9e39d5eaf4d0d6da249440eea43bb50ff0fddf27'
MCP_API_KEY='e63ad0c93b969a864f5f16addfdad55eaabee376f1641b64'

echo "=== Smoke тесты ==="

echo "# /gw/healthz"
curl -fsS "https://${TARGET_DOMAIN}/gw/healthz" | jq . || true

echo "# /api/db/user_summary?user_id=${USER_ID}"
curl -fsS -H "X-API-Key: ${STAS_API_KEY}" \
  "https://${TARGET_DOMAIN}/api/db/user_summary?user_id=${USER_ID}" | jq . || true

echo "# /icu/activities?days=7&user_id=${USER_ID}"
curl -fsS -H "X-API-Key: ${MCP_API_KEY}" \
  "https://${TARGET_DOMAIN}/icu/activities?days=7&user_id=${USER_ID}" | jq . | sed -n '1,120p' || true

echo "# /icu/events?category=WORKOUT&days=30&user_id=${USER_ID}"
curl -fsS -H "X-API-Key: ${MCP_API_KEY}" \
  "https://${TARGET_DOMAIN}/icu/events?category=WORKOUT&days=30&user_id=${USER_ID}" | jq . | sed -n '1,120p' || true

echo "=== ШАГ C ЗАВЕРШЕН ==="
