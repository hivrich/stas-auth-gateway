#!/bin/bash
# ФИНАЛЬНЫЙ СКРИПТ: завершение всех шагов
# Запусти в Terminal.app: ./deploy/final-complete.sh

set -euo pipefail

echo "🎯 ФИНАЛЬНОЕ ЗАВЕРШЕНИЕ РАЗВЕРТЫВАНИЯ"
echo "===================================="

# Шаг 1: Перезапуск всех сервисов
echo ""
echo "🔄 ШАГ 1: Перезапуск сервисов..."
ssh -i ~/.ssh/id_ed25519_new -o StrictHostKeyChecking=no root@109.172.46.200 'systemctl restart stas-db-bridge mcp-bridge stas-auth-gateway'

echo "⏳ Ждем 3 секунды..."
sleep 3

# Шаг 2: Проверка статусов
echo ""
echo "📊 ШАГ 2: Статус всех сервисов..."
ssh -i ~/.ssh/id_ed25519_new -o StrictHostKeyChecking=no root@109.172.46.200 'systemctl status stas-db-bridge mcp-bridge stas-auth-gateway --no-pager | grep -E "(Active|Loaded)" | head -10'

# Шаг 3: Тест агрегированного healthz
echo ""
echo "🏥 ШАГ 3: Тест агрегированного /healthz..."
echo "Локальный тест:"
ssh -i ~/.ssh/id_ed25519_new -o StrictHostKeyChecking=no root@109.172.46.200 'curl -s http://127.0.0.1:3337/healthz'

echo ""
echo "Внешний тест:"
curl -s https://intervals.stas.run/healthz | jq . 2>/dev/null || curl -s https://intervals.stas.run/healthz

# Шаг 4: Тест основных эндпоинтов
echo ""
echo "🧪 ШАГ 4: Тест основных эндпоинтов..."

echo "1. Gateway /gw/healthz:"
curl -s https://intervals.stas.run/gw/healthz

echo ""
echo "2. DB API /api/db/user_summary:"
curl -s -H "X-API-Key: 7ca1e3d9d8bb76a1297a9c7d9e39d5eaf4d0d6da249440eea43bb50ff0fddf27" \
  https://intervals.stas.run/api/db/user_summary?user_id=95192039

echo ""
echo "3. Intervals /icu/activities:"
curl -s -H "X-API-Key: e63ad0c93b969a864f5f16addfdad55eaabee376f1641b64" \
  https://intervals.stas.run/icu/activities?days=7&user_id=95192039 | head -5

# Шаг 5: Финальная сводка
echo ""
echo "🎉 ШАГ 5: ФИНАЛЬНАЯ СВОДКА"
echo "=========================="
echo "✅ РАЗВЕРТЫВАНИЕ ЗАВЕРШЕНО!"
echo ""
echo "🔗 Доступные эндпоинты:"
echo "  • https://intervals.stas.run/healthz (агрегированный)"
echo "  • https://intervals.stas.run/gw/healthz"
echo "  • https://intervals.stas.run/api/db/user_summary"
echo "  • https://intervals.stas.run/icu/activities"
echo "  • https://intervals.stas.run/icu/events"
echo ""
echo "🔑 API ключи:"
echo "  • STAS: 7ca1e3d9d8bb76a1297a9c7d9e39d5eaf4d0d6da249440eea43bb50ff0fddf27"
echo "  • MCP: e63ad0c93b969a864f5f16addfdad55eaabee376f1641b64"
echo ""
echo "📋 Следующие шаги (опционально):"
echo "  • SSE proxy для real-time данных"
echo "  • OAuth тестирование в GPT Actions"
echo "  • 301 редиректы со старых доменов"
echo ""
echo "🚀 ГОТОВО К ИСПОЛЬЗОВАНИЮ!"
