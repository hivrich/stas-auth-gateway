#!/usr/bin/env bash
set -euo pipefail

echo "=== Исправленная инициализация сервера ==="

# Установка пакетов (без проблемных nodejs/npm)
export DEBIAN_FRONTEND=noninteractive
echo "Обновление пакетов..."
apt-get update -y

echo "Установка базовых пакетов..."
apt-get install -y --no-install-recommends \
  curl jq rsync nginx ca-certificates \
  gnupg lsb-release postgresql-client

# Установка Node.js 20 из nodesource
echo "Установка Node.js 20..."
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt-get install -y nodejs

# Проверка установки
echo "Проверка версий:"
node --version
npm --version

# Создание каталогов
echo "Создание каталогов..."
mkdir -p /opt/stas-auth-gateway /opt/stas-db-bridge /opt/mcp-bridge /opt/mcp
mkdir -p /etc/nginx/sites-{available,enabled} /var/log/intervals

# Создание .env файлов
echo "Создание .env файлов..."

cat >/opt/stas-db-bridge/.env <<'ENV'
API_KEY=__SET_IN_ENV__
PORT=3336
DB_HOST=__SET_IN_ENV__
DB_PORT=5432
DB_NAME=__SET_IN_ENV__
DB_USER=__SET_IN_ENV__
DB_PASSWORD=__SET_IN_ENV__
DB_SSL=false
DEBUG=true
ENV

cat >/opt/mcp-bridge/.env <<'ENV'
PORT=3334
DEBUG=true
EXTERNAL_API_KEY=__SET_IN_ENV__
DB_HOST=__SET_IN_ENV__
DB_PORT=5432
DB_NAME=__SET_IN_ENV__
DB_USER=__SET_IN_ENV__
DB_PASSWORD=__SET_IN_ENV__
DB_SSL=false
ENV

cat >/opt/stas-auth-gateway/.env <<'ENV'
PORT=3337
STAS_BASE=http://127.0.0.1:3336
STAS_INTERNAL_BASE_URL=http://127.0.0.1:3336
STAS_KEY=__SET_IN_ENV__
DB_BRIDGE_API_KEY=__SET_IN_ENV__
STAS_API_KEY=__SET_IN_ENV__
INTERVALS_API_BASE_URL=https://intervals.icu/api/v1
ICU_API_BASE_URL=https://intervals.icu/api/v1
ICU_BASE_URL=https://intervals.icu/api/v1
DEBUG=true
ENV

cat >/opt/mcp/.env <<'ENV'
HOST=127.0.0.1
PORT=3333
DEBUG=true
ENV

echo "Проверка systemd..."
systemctl daemon-reload || true

echo "Проверка nginx..."
nginx -t >/dev/null 2>&1 || echo "Nginx config test failed (expected)"

echo "=== ШАГ A ЗАВЕРШЕН ==="
