#!/usr/bin/env bash
# Исправление nginx конфигурации
# Запусти на сервере: bash /root/fix-nginx.sh

echo "🔧 Исправление nginx конфигурации..."

# Создаем исправленную конфигурацию
cat > /etc/nginx/sites-available/intervals.stas.run.conf <<'NGINX'
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
    proxy_pass http://127.0.0.1:3337;
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
    proxy_pass http://127.0.0.1:3337/gw/healthz;
  }
}
NGINX

echo "✅ Конфигурация обновлена"

# Проверяем синтаксис
nginx -t
if [ $? -eq 0 ]; then
  echo "✅ Синтаксис nginx OK"
  # Перезагружаем nginx
  systemctl reload nginx
  echo "✅ Nginx перезагружен"
else
  echo "❌ Ошибка в nginx конфигурации"
  exit 1
fi

echo "🎉 Nginx исправлен!"
NGINX
