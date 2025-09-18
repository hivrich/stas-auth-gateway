#!/usr/bin/env bash
# Полный скрипт развертывания - запускай в терминале
# ./deploy/full-deploy.sh

set -euo pipefail

echo "=== ПОЛНЫЙ СКРИПТ РАЗВЕРТЫВАНИЯ ==="
echo "Этот скрипт выполнит все шаги A→B→C автоматически"

# Проверяем зависимости
echo "Проверка зависимостей..."
command -v ssh >/dev/null || { echo "❌ ssh не найден"; exit 1; }
command -v scp >/dev/null || { echo "❌ scp не найден"; exit 1; }
command -v rsync >/dev/null || { echo "❌ rsync не найден"; exit 1; }

# Параметры сервера
SERVER="root@109.172.46.200"
PROJECT_DIR="/Users/hivr/stas-auth-gateway"

# Проверяем наличие скриптов
echo "Проверка скриптов..."
for script in server-init-fixed.sh server-setup.sh server-smoke.sh; do
  [ -f "deploy/$script" ] || { echo "❌ deploy/$script не найден"; exit 1; }
done
echo "✅ Все скрипты найдены"

# Функция для выполнения команд на сервере
remote_exec() {
  echo "🔧 Выполняю: $*"
  ssh "$SERVER" "$*" 2>/dev/null
}

# Функция для копирования файлов
remote_copy() {
  local src="$1" dst="$2"
  echo "📁 Копирую $src → $SERVER:$dst"
  scp "$src" "$SERVER:$dst" >/dev/null 2>&1 || {
    echo "❌ Ошибка копирования $src"
    return 1
  }
}

echo ""
echo "=== ШАГ A: Инициализация сервера ==="

# Копируем и выполняем init скрипт
remote_copy "deploy/server-init-fixed.sh" "/root/server-init-fixed.sh"
remote_exec "chmod +x /root/server-init-fixed.sh"
remote_exec "bash /root/server-init-fixed.sh"

echo ""
echo "=== ШАГ B: Настройка systemd и Nginx ==="

# Копируем и выполняем setup скрипт
remote_copy "deploy/server-setup.sh" "/root/server-setup.sh"
remote_exec "chmod +x /root/server-setup.sh"
remote_exec "bash /root/server-setup.sh"

echo ""
echo "=== ШАГ C: Установка зависимостей ==="

# Устанавливаем npm зависимости
echo "🔧 Устанавливаю зависимости в mcp-bridge..."
remote_exec "cd /opt/mcp-bridge && npm install"

echo "🔧 Устанавливаю зависимости в stas-db-bridge..."
remote_exec "cd /opt/stas-db-bridge && npm install"

echo "🔧 Перезапускаю сервисы..."
remote_exec "systemctl restart stas-db-bridge mcp-bridge"

echo "🔧 Жду 5 секунд..."
sleep 5

echo ""
echo "=== ШАГ D: Проверка статуса сервисов ==="
remote_exec "systemctl status stas-db-bridge mcp-bridge stas-auth-gateway --no-pager -l | head -50"

echo ""
echo "=== ШАГ E: Smoke тесты ==="

# Копируем и выполняем smoke скрипт
remote_copy "deploy/server-smoke.sh" "/root/server-smoke.sh"
remote_exec "chmod +x /root/server-smoke.sh"
remote_exec "bash /root/server-smoke.sh"

echo ""
echo "=== ГОТОВО! ==="
echo "🎉 Развертывание завершено!"
echo "📊 Проверь логи выше на ошибки"
echo "🔗 Тестируй: https://intervals.stas.run/gw/healthz"
