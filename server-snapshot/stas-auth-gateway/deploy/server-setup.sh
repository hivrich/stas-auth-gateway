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
