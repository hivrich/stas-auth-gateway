#!/bin/bash
# STAS Auth Gateway - Smoke Tests (Server Version)

HOST="https://intervals.stas.run"
BASE="http://127.0.0.1:3337"

echo "🧪 STAS Auth Gateway - Server Smoke Tests"
echo "========================================="

echo -e "\n1️⃣  Local Health Check:"
if curl -s "$BASE/gw/healthz" | grep -q "ok"; then
  echo "✅ PASS: $BASE/gw/healthz"
else
  echo "❌ FAIL: $BASE/gw/healthz"
fi

echo -e "\n2️⃣  OpenAPI Schema (local):"
if curl -s "$BASE/.well-known/openapi.json" | grep -q "openapi"; then
  echo "✅ PASS: $BASE/.well-known/openapi.json"
else
  echo "❌ FAIL: $BASE/.well-known/openapi.json"
fi

echo -e "\n3️⃣  Version Endpoint:"
if curl -s "$BASE/gw/version" | grep -q "version"; then
  echo "✅ PASS: $BASE/gw/version"
else
  echo "❌ FAIL: $BASE/gw/version"
fi

echo -e "\n4️⃣  Nginx Proxy Test:"
if curl -s "$HOST/gw/healthz" | grep -q "ok"; then
  echo "✅ PASS: $HOST/gw/healthz (external access)"
else
  echo "❌ FAIL: $HOST/gw/healthz (nginx not proxying)"
fi

echo -e "\n5️⃣  External OpenAPI:"
if curl -s "$HOST/.well-known/openapi.json" | grep -q "openapi"; then
  echo "✅ PASS: $HOST/.well-known/openapi.json (external access)"
else
  echo "❌ FAIL: $HOST/.well-known/openapi.json (nginx not serving static)"
fi

echo -e "\n🎯 SERVER SMOKE TESTS COMPLETE"
echo "================================"
EOF && chmod +x /opt/stas-auth-gateway/smoke.sh
