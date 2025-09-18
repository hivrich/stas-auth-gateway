#!/usr/bin/env bash
# Скрипт тестирования развертывания
# ./deploy/test-endpoints.sh

echo "=== ТЕСТИРОВАНИЕ РАЗВЕРТЫВАНИЯ ==="
echo "Проверяем все эндпоинты..."
echo ""

# Цвета для вывода
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Функция для тестирования
test_endpoint() {
  local name="$1"
  local url="$2"
  local headers="$3"

  echo -n "$name: "

  if [ -n "$headers" ]; then
    response=$(curl -s -w "\n%{http_code}" "$headers" "$url" 2>/dev/null)
  else
    response=$(curl -s -w "\n%{http_code}" "$url" 2>/dev/null)
  fi

  http_code=$(echo "$response" | tail -n1)
  body=$(echo "$response" | head -n -1)

  case $http_code in
    200)
      echo -e "${GREEN}✅ OK (200)${NC}"
      if [ -n "$body" ] && [ "$body" != "null" ]; then
        echo "$body" | jq . 2>/dev/null | head -10 || echo "$body" | head -5
      fi
      ;;
    404)
      echo -e "${RED}❌ Not Found (404)${NC}"
      ;;
    502)
      echo -e "${RED}❌ Bad Gateway (502)${NC}"
      ;;
    500)
      echo -e "${RED}❌ Internal Error (500)${NC}"
      ;;
    *)
      echo -e "${YELLOW}⚠️  HTTP $http_code${NC}"
      if [ -n "$body" ]; then
        echo "$body" | head -3
      fi
      ;;
  esac
  echo ""
}

# API ключи
STAS_API_KEY="7ca1e3d9d8bb76a1297a9c7d9e39d5eaf4d0d6da249440eea43bb50ff0fddf27"
MCP_API_KEY="e63ad0c93b969a864f5f16addfdad55eaabee376f1641b64"
USER_ID="95192039"

echo "🔗 Базовый домен: https://intervals.stas.run"
echo "👤 Test user_id: $USER_ID"
echo ""

# Тестируем эндпоинты
test_endpoint "Gateway Health" "https://intervals.stas.run/gw/healthz" ""

test_endpoint "DB User Summary" \
  "https://intervals.stas.run/api/db/user_summary?user_id=$USER_ID" \
  "-H 'X-API-Key: $STAS_API_KEY'"

test_endpoint "Intervals Activities" \
  "https://intervals.stas.run/icu/activities?days=7&user_id=$USER_ID" \
  "-H 'X-API-Key: $MCP_API_KEY'"

test_endpoint "Intervals Events" \
  "https://intervals.stas.run/icu/events?category=WORKOUT&days=30&user_id=$USER_ID" \
  "-H 'X-API-Key: $MCP_API_KEY'"

echo "=== РЕЗУЛЬТАТЫ ТЕСТИРОВАНИЯ ==="
echo "✅ Если все тесты зеленые - развертывание успешно!"
echo "❌ Если есть красные - нужны исправления"
echo ""
echo "📋 Следующие шаги:"
echo "1. Агрегированный /healthz в gateway"
echo "2. Systemd для SSE proxy"
echo "3. Тестирование OAuth в GPT Actions"
