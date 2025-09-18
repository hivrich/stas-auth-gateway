#!/usr/bin/env bash
# Исправление всех проблем: зависимости + маршруты + сервисы
# Запусти на сервере: bash /root/final-fix.sh

echo "🔧 ФИНАЛЬНОЕ ИСПРАВЛЕНИЕ ВСЕХ ПРОБЛЕМ..."

# 1. Установи зависимости для stas-auth-gateway
echo "📦 Устанавливаю зависимости для stas-auth-gateway..."
cd /opt/stas-auth-gateway
npm install axios express cors dotenv
cd /

# 2. Исправь маршрут для stas-db-bridge в nginx
echo "🔧 Исправляю nginx конфигурацию для db-bridge..."
sed -i 's|proxy_pass http://127.0.0.1:3336/;|proxy_pass http://127.0.0.1:3336/api/;|g' /etc/nginx/sites-available/intervals.stas.run.conf

# 3. Проверь и перезагрузи nginx
echo "🔄 Перезагружаю nginx..."
nginx -t && systemctl reload nginx

# 4. Перезапусти все сервисы
echo "🔄 Перезапускаю сервисы..."
systemctl restart stas-db-bridge
systemctl restart mcp-bridge
systemctl restart stas-auth-gateway

# 5. Подожди 3 секунды
sleep 3

# 6. Проверь статусы
echo "📊 Статус сервисов:"
systemctl status stas-db-bridge mcp-bridge stas-auth-gateway --no-pager | grep -E "(Active|Loaded)" | head -10

echo ""
echo "✅ ИСПРАВЛЕНИЯ ЗАВЕРШЕНЫ!"
echo ""
echo "🧪 Теперь тестируй:"
echo "curl -s 'https://intervals.stas.run/gw/healthz'"
echo "curl -s -H 'X-API-Key: 7ca1e3d9d8bb76a1297a9c7d9e39d5eaf4d0d6da249440eea43bb50ff0fddf27' 'https://intervals.stas.run/api/db/user_summary?user_id=95192039'"
