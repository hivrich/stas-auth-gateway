#!/usr/bin/env bash
# МАСТЕР-СКРИПТ: полное развертывание и тестирование
# ./deploy/master-deploy.sh

set -euo pipefail

echo "🚀 МАСТЕР-СКРИПТ РАЗВЕРТЫВАНИЯ"
echo "=============================="
echo ""

# Шаг 1: Запуск полного развертывания
echo "📦 ШАГ 1: Запуск развертывания..."
if [ -f "deploy/full-deploy.sh" ]; then
  bash deploy/full-deploy.sh
else
  echo "❌ deploy/full-deploy.sh не найден"
  exit 1
fi

echo ""
echo "⏳ Ждем 10 секунд после развертывания..."
sleep 10

# Шаг 2: Тестирование эндпоинтов
echo ""
echo "🧪 ШАГ 2: Тестирование эндпоинтов..."
if [ -f "deploy/test-endpoints.sh" ]; then
  bash deploy/test-endpoints.sh
else
  echo "❌ deploy/test-endpoints.sh не найден"
  exit 1
fi

# Шаг 3: Проверка статуса сервисов
echo ""
echo "🔍 ШАГ 3: Финальная проверка сервисов..."
ssh root@109.172.46.200 'systemctl status stas-db-bridge mcp-bridge stas-auth-gateway --no-pager -l | head -30' 2>/dev/null || echo "⚠️ Не удалось проверить статус сервисов"

echo ""
echo "🎉 РАЗВЕРТЫВАНИЕ ЗАВЕРШЕНО!"
echo "=============================="
echo ""
echo "📋 Что проверить вручную:"
echo "• https://intervals.stas.run/gw/healthz"
echo "• Сервисы: systemctl status stas-db-bridge mcp-bridge stas-auth-gateway"
echo "• Логи: journalctl -u stas-db-bridge -n 10"
echo ""
echo "🔧 Если проблемы - проверь логи и .env файлы"
