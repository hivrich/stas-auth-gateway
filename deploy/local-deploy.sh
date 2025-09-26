#!/usr/bin/env bash
# Локальный скрипт для развертывания на сервере
# Запускать из корня репозитория: ./deploy/local-deploy.sh

set -euo pipefail

echo "=== Локальный скрипт развертывания ==="
echo "Этот скрипт создаст скрипты для сервера и попытается их выполнить"

# Проверяем наличие ключа
if [ ! -f ~/.ssh/id_ed25519_new ]; then
    echo "Создаю SSH ключ..."
    ssh-keygen -t ed25519 -f ~/.ssh/id_ed25519_new -C "windsurf-deploy" -N ""
fi

# Загружаем ключ в агент
echo "Загружаю ключ в SSH агент..."
eval "$(ssh-agent -s)"
ssh-add ~/.ssh/id_ed25519_new

# Создаем алиас
echo "Настраиваю SSH алиас..."
cat >> ~/.ssh/config <<'CFG'
Host intervals-prod
HostName 109.172.46.200
User root
IdentityFile ~/.ssh/id_ed25519_new
PreferredAuthentications publickey
PubkeyAuthentication yes
PasswordAuthentication no
StrictHostKeyChecking no
UserKnownHostsFile /dev/null
CFG

echo "=== ШАГ A: Создание скрипта инициализации ==="
cat > deploy/server-init.sh <<'SH'
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
SH

echo "=== ШАГ B: Создание скрипта настройки systemd/Nginx ==="
cat > deploy/server-setup.sh <<'SH'
#!/usr/bin/env bash
set -euo pipefail

echo "=== Настройка systemd юнитов ==="

# Функция создания юнита
unit() {
  cat <<U
[Unit]
Description=$1
After=network.target

[Service]
Type=simple
WorkingDirectory=$2
EnvironmentFile=$2/.env
ExecStart=$3
Restart=always
RestartSec=2

[Install]
WantedBy=multi-user.target
U
}

# stas-db-bridge
cat >/etc/systemd/system/stas-db-bridge.service <<U
$(unit "STAS DB Bridge" /opt/stas-db-bridge "/usr/bin/node /opt/stas-db-bridge/app.js")
U

# mcp-bridge
cat >/etc/systemd/system/mcp-bridge.service <<U
$(unit "MCP Bridge (Intervals.icu HTTP proxy)" /opt/mcp-bridge "/usr/bin/node /opt/mcp-bridge/app.js")
U

# stas-auth-gateway
cat >/etc/systemd/system/stas-auth-gateway.service <<U
$(unit "STAS Auth Gateway (OAuth + API proxy)" /opt/stas-auth-gateway "/usr/bin/node /opt/stas-auth-gateway/app.js")
U

# Опционально: mcp-sse-proxy (только если есть бинарь)
if [ -f /opt/mcp/dist/index.js ]; then
  cat >/etc/systemd/system/mcp-sse-proxy.service <<U
$(unit "MCP SSE Proxy" /opt/mcp "/usr/bin/node /opt/mcp/dist/index.js")
U
fi

echo "Перезагрузка systemd..."
systemctl daemon-reload

echo "Включение и запуск сервисов..."
systemctl enable --now stas-db-bridge mcp-bridge stas-auth-gateway || true
[ -f /etc/systemd/system/mcp-sse-proxy.service ] && systemctl enable --now mcp-sse-proxy || true

echo "=== Настройка Nginx ==="

cat >/etc/nginx/sites-available/intervals.stas.run.conf <<'NG'
server {
  listen 80;
  server_name intervals.stas.run;
  return 301 https://$host$request_uri;
}

server {
  listen 443 ssl http2;
  server_name intervals.stas.run;
  ssl_certificate     /etc/letsencrypt/live/intervals.stas.run/fullchain.pem;
  ssl_certificate_key /etc/letsencrypt/live/intervals.stas.run/privkey.pem;

  client_max_body_size 20m;
  proxy_set_header Host              $host;
  proxy_set_header X-Real-IP         $remote_addr;
  proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
  proxy_set_header X-Forwarded-Proto $scheme;

  location /gw/ {
    proxy_http_version 1.1;
    proxy_set_header Connection "";
    proxy_pass http://127.0.0.1:3337/;
  }
  location = /gw/healthz {
    proxy_pass http://127.0.0.1:3337/healthz;
  }

  location /api/ {
    proxy_http_version 1.1;
    proxy_set_header Connection "";
    proxy_set_header X-API-Key $http_x_api_key;
    proxy_pass http://127.0.0.1:3336/;
  }

  location /icu/ {
    proxy_http_version 1.1;
    proxy_set_header Connection "";
    proxy_set_header X-API-Key $http_x_api_key;
    proxy_pass http://127.0.0.1:3334/;
  }

  location /sse {
    proxy_http_version 1.1;
    proxy_set_header Connection "";
    proxy_set_header Cache-Control no-cache;
    proxy_buffering off;
    proxy_read_timeout 1h;
    proxy_pass http://127.0.0.1:3333/sse;
  }

  location = /healthz {
    proxy_pass http://127.0.0.1:3337/healthz;
  }
}
NG

# Включение сайта
ln -sf /etc/nginx/sites-available/intervals.stas.run.conf /etc/nginx/sites-enabled/intervals.stas.run.conf

# Тест и перезагрузка
nginx -t && systemctl reload nginx

echo "=== Проверка состояния ==="
systemctl --no-pager --full status stas-db-bridge mcp-bridge stas-auth-gateway | sed -n '1,200p' || true

echo "=== ШАГ B ЗАВЕРШЕН ==="
SH

echo "=== ШАГ C: Создание скрипта smoke-тестов ==="
cat > deploy/server-smoke.sh <<'SH'
#!/usr/bin/env bash
set -euo pipefail

USER_ID=95192039
TARGET_DOMAIN='intervals.stas.run'
STAS_API_KEY='7ca1e3d9d8bb76a1297a9c7d9e39d5eaf4d0d6da249440eea43bb50ff0fddf27'
MCP_API_KEY='e63ad0c93b969a864f5f16addfdad55eaabee376f1641b64'

echo "=== Smoke тесты ==="

echo "# /gw/healthz"
curl -fsS "https://${TARGET_DOMAIN}/gw/healthz" | jq . || true

echo "# /api/db/user_summary?user_id=${USER_ID}"
curl -fsS -H "X-API-Key: ${STAS_API_KEY}" \
  "https://${TARGET_DOMAIN}/api/db/user_summary?user_id=${USER_ID}" | jq . || true

echo "# /icu/activities?days=7&user_id=${USER_ID}"
curl -fsS -H "X-API-Key: ${MCP_API_KEY}" \
  "https://${TARGET_DOMAIN}/icu/activities?days=7&user_id=${USER_ID}" | jq . | sed -n '1,120p' || true

echo "# /icu/events?category=WORKOUT&days=30&user_id=${USER_ID}"
curl -fsS -H "X-API-Key: ${MCP_API_KEY}" \
  "https://${TARGET_DOMAIN}/icu/events?category=WORKOUT&days=30&user_id=${USER_ID}" | jq . | sed -n '1,120p' || true

echo "=== ШАГ C ЗАВЕРШЕН ==="
SH

echo "=== Попытка выполнения скриптов на сервере ==="

# Копируем скрипты на сервер
echo "Копируем скрипты на сервер..."
scp -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -i ~/.ssh/id_ed25519_new deploy/server-init.sh intervals-prod:/root/server-init.sh 2>/dev/null || echo "Ошибка копирования init.sh"
scp -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -i ~/.ssh/id_ed25519_new deploy/server-setup.sh intervals-prod:/root/server-setup.sh 2>/dev/null || echo "Ошибка копирования setup.sh"
scp -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -i ~/.ssh/id_ed25519_new deploy/server-smoke.sh intervals-prod:/root/server-smoke.sh 2>/dev/null || echo "Ошибка копирования smoke.sh"

# Делаем исполняемыми и запускаем
echo "Запускаем скрипты..."
ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -i ~/.ssh/id_ed25519_new intervals-prod "chmod +x /root/server-*.sh && echo '=== ШАГ A: Инициализация ===' && bash /root/server-init.sh" 2>/dev/null || echo "Ошибка выполнения init.sh"
ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -i ~/.ssh/id_ed25519_new intervals-prod "echo '=== ШАГ B: Настройка ===' && bash /root/server-setup.sh" 2>/dev/null || echo "Ошибка выполнения setup.sh"
ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -i ~/.ssh/id_ed25519_new intervals-prod "echo '=== ШАГ C: Smoke ===' && bash /root/server-smoke.sh" 2>/dev/null || echo "Ошибка выполнения smoke.sh"

echo "=== Скрипты созданы и попытка выполнения завершена ==="
echo "Если скрипты не выполнились, запусти их вручную на сервере:"
echo "1. scp deploy/server-init.sh root@109.172.46.200:/root/"
echo "2. ssh root@109.172.46.200 'chmod +x /root/server-init.sh && bash /root/server-init.sh'"
echo "3. Повторить для server-setup.sh и server-smoke.sh"
