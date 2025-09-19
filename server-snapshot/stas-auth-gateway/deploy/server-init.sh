#!/usr/bin/env bash
set -euo pipefail

# Установка пакетов
export DEBIAN_FRONTEND=noninteractive
echo "Обновление пакетов..."
apt-get update -y
apt-get install -y --no-install-recommends \
  curl jq rsync nginx ca-certificates \
  gnupg lsb-release postgresql-client nodejs npm

# Каталоги
echo "Создание каталогов..."
mkdir -p /opt/stas-auth-gateway /opt/stas-db-bridge /opt/mcp-bridge /opt/mcp
mkdir -p /etc/nginx/sites-{available,enabled} /var/log/intervals

# .env файлы
echo "Создание .env файлов..."

cat >/opt/stas-db-bridge/.env <<'ENV'
API_KEY=7ca1e3d9d8bb76a1297a9c7d9e39d5eaf4d0d6da249440eea43bb50ff0fddf27
PORT=3336
DB_HOST=94.241.141.239
DB_PORT=5432
DB_NAME=hivrich_db
DB_USER=limpid_beaker67
DB_PASSWORD=jup64918
DB_SSL=false
DEBUG=true
ENV

cat >/opt/mcp-bridge/.env <<'ENV'
PORT=3334
DEBUG=true
EXTERNAL_API_KEY=e63ad0c93b969a864f5f16addfdad55eaabee376f1641b64
DB_HOST=94.241.141.239
DB_PORT=5432
DB_NAME=hivrich_db
DB_USER=limpid_beaker67
DB_PASSWORD=jup64918
DB_SSL=false
ENV

cat >/opt/stas-auth-gateway/.env <<'ENV'
PORT=3337
STAS_API_BASE=https://intervals.stas.run/api
STAS_API_KEY=7ca1e3d9d8bb76a1297a9c7d9e39d5eaf4d0d6da249440eea43bb50ff0fddf27
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
