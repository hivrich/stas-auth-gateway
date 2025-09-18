#!/usr/bin/env bash
# ФИНАЛЬНЫЙ СКРИПТ: проверка и исправление всех проблем
# Запусти в терминале: ./deploy/final-check.sh

set -euo pipefail

echo "🚀 ФИНАЛЬНАЯ ПРОВЕРКА РАЗВЕРТЫВАНИЯ"
echo "===================================="

# Проверяем статус всех сервисов
echo ""
echo "📊 Статус сервисов:"
ssh root@109.172.46.200 'systemctl status stas-db-bridge mcp-bridge stas-auth-gateway nginx --no-pager | grep -E "(Active|Loaded)" | head -20' 2>/dev/null || echo "❌ Ошибка подключения"

# Проверяем nginx конфигурацию
echo ""
echo "🔧 Nginx конфигурация:"
ssh root@109.172.46.200 'grep -A10 "location /gw/" /etc/nginx/sites-available/intervals.stas.run.conf' 2>/dev/null || echo "❌ Ошибка чтения конфига"

# Проверяем маршруты в сервисах
echo ""
echo "🛣️  Маршруты в gateway:"
ssh root@109.172.46.200 'grep -n "app\.get.*healthz" /opt/stas-auth-gateway/server.js' 2>/dev/null || echo "❌ Маршрут не найден"

# Проверяем прямые запросы к сервисам
echo ""
echo "🔍 Прямые запросы к сервисам:"

echo "Gateway (прямой):"
ssh root@109.172.46.200 'curl -s http://127.0.0.1:3337/gw/healthz' 2>/dev/null || echo "❌ Gateway не отвечает"

echo "DB Bridge (прямой):"
ssh root@109.172.46.200 'curl -s http://127.0.0.1:3336/api/db/user_summary?user_id=95192039' 2>/dev/null || echo "❌ DB Bridge не отвечает"

echo "MCP Bridge (прямой):"
ssh root@109.172.46.200 'curl -s http://127.0.0.1:3334/activities?days=7&user_id=95192039' 2>/dev/null || echo "❌ MCP Bridge не отвечает"

# Исправляем если нужно
echo ""
echo "🔧 Исправления:"

# Перезапускаем сервисы если нужно
echo "Перезапуск сервисов..."
ssh root@109.172.46.200 'systemctl restart stas-db-bridge mcp-bridge stas-auth-gateway' 2>/dev/null || echo "❌ Ошибка перезапуска"

# Перезагружаем nginx
echo "Перезагрузка nginx..."
ssh root@109.172.46.200 'nginx -t && systemctl reload nginx' 2>/dev/null || echo "❌ Ошибка nginx"

# Финальное тестирование
echo ""
echo "🧪 ФИНАЛЬНОЕ ТЕСТИРОВАНИЕ:"

echo "1. Gateway Health:"
curl -s "https://intervals.stas.run/gw/healthz" | jq . 2>/dev/null || echo "❌ 404"

echo "2. DB User Summary:"
curl -s -H "X-API-Key: 7ca1e3d9d8bb76a1297a9c7d9e39d5eaf4d0d6da249440eea43bb50ff0fddf27" \
  "https://intervals.stas.run/api/db/user_summary?user_id=95192039" | jq . 2>/dev/null || echo "❌ 404"

echo "3. Intervals Activities:"
curl -s -H "X-API-Key: e63ad0c93b969a864f5f16addfdad55eaabee376f1641b64" \
  "https://intervals.stas.run/icu/activities?days=7&user_id=95192039" | jq . 2>/dev/null || echo "❌ 404"

echo "4. Intervals Events:"
curl -s -H "X-API-Key: e63ad0c93b969a864f5f16addfdad55eaabee376f1641b64" \
  "https://intervals.stas.run/icu/events?category=WORKOUT&days=30&user_id=95192039" | jq . 2>/dev/null || echo "❌ 404"

echo ""
echo "🎯 ЕСЛИ ВСЕ 4 ТЕСТА ПРОШЛИ - РАЗВЕРТЫВАНИЕ УСПЕШНО!"
echo "❌ ЕСЛИ ЕСТЬ ОШИБКИ - ПРИШЛИ ВЫВОД ДЛЯ ИСПРАВЛЕНИЯ"
