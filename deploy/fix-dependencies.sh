#!/usr/bin/env bash
# Скрипт исправления зависимостей
# Запусти на сервере: bash /root/fix-dependencies.sh

set -euo pipefail

echo "🔧 Исправление зависимостей mcp-bridge..."

# Переход в директорию
cd /opt/mcp-bridge

# Удаление старых зависимостей
echo "Удаляю старые зависимости..."
rm -rf node_modules package-lock.json

# Добавление axios в package.json
echo "Добавляю axios в package.json..."
# Создаем временный package.json с axios
cat > package.json << 'EOF'
{
  "name": "mcp-bridge",
  "private": true,
  "dependencies": {
    "axios": "^1.6.0",
    "express": "^4.19.2",
    "node-fetch": "^2.7.0",
    "pg": "^8.16.3"
  }
}
EOF

# Установка зависимостей
echo "Устанавливаю зависимости..."
npm install

# Проверка установки
echo "Проверяю установку axios..."
npm list axios

echo "✅ Зависимости исправлены!"

# Перезапуск сервиса
echo "Перезапускаю mcp-bridge..."
systemctl restart mcp-bridge

# Проверка статуса
echo "Проверяю статус..."
systemctl status mcp-bridge --no-pager | head -10
