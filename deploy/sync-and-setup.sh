#!/usr/bin/env bash
set -euo pipefail

# Sync server snapshot to /opt/*, write .env files (without Intervals keys),
# configure systemd and nginx on the target host.
# This script runs LOCALLY and connects to the remote host via SSH.
# It expects environment variables (recommended: load from deploy/.env.deploy)
# Requires local directory ./server-snapshot/{stas-auth-gateway,stas-db-bridge,mcp-bridge[,mcp]}

require() {
  local name="$1"; if [[ -z "${!name:-}" ]]; then echo "Missing required env: $name" >&2; exit 1; fi
}

# Required
require SSH_HOST
require TARGET_DOMAIN
require STAS_API_KEY
require MCP_API_KEY
require DB_HOST
require DB_PORT
require DB_NAME
require DB_USER
require DB_PASSWORD
require DB_SSL
# Optional SSH_PASS if you use password auth; otherwise rely on ssh agent/keys

if ! command -v ssh >/dev/null 2>&1; then echo "ssh is required" >&2; exit 1; fi

SSH_BASE=(ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o ConnectTimeout=10 "$SSH_HOST")
SCP_BASE=(scp -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null)

remote() { "${SSH_BASE[@]}" "$@"; }
rcat() { # rcat <remote_path> <local_file>
  local dst="$1"; local src="$2"; "${SCP_BASE[@]}" "$src" "$SSH_HOST:$dst"; }

echo "==> Ensuring base directories exist on remote"
remote "mkdir -p /opt/{stas-auth-gateway,stas-db-bridge,mcp-bridge,mcp} /etc/nginx/sites-available /etc/nginx/sites-enabled /var/log/intervals"

echo "==> Syncing local server-snapshot to remote /opt/*"
sync_dir() {
  local src="$1" dst="$2"
  if [[ -d "$src" ]]; then
    rsync -e "ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null" -a --delete --exclude ".git" --exclude "node_modules" --exclude "*.log" --exclude "logs" "$src/" "$SSH_HOST:$dst/"
  fi
}
sync_dir "server-snapshot/stas-auth-gateway" "/opt/stas-auth-gateway"
sync_dir "server-snapshot/stas-db-bridge" "/opt/stas-db-bridge"
sync_dir "server-snapshot/mcp-bridge" "/opt/mcp-bridge"
sync_dir "server-snapshot/mcp" "/opt/mcp"

# 3) Render .env files on remote from local environment
require_if_set() { :; }

# stas-db-bridge .env
if [[ -n "${DB_HOST:-}" ]]; then
  echo "==> Writing /opt/stas-db-bridge/.env"
  tmpfile=$(mktemp)
  cat >"$tmpfile" <<EOF
API_KEY=${STAS_API_KEY:-}
PORT=3336
DB_HOST=${DB_HOST:-}
DB_PORT=${DB_PORT:-5432}
DB_NAME=${DB_NAME:-}
DB_USER=${DB_USER:-}
DB_PASSWORD=${DB_PASSWORD:-}
DB_SSL=${DB_SSL:-false}
DEBUG=true
EOF
  rcat "/opt/stas-db-bridge/.env" "$tmpfile"; rm -f "$tmpfile"
fi

# mcp-bridge .env (no Intervals keys; EXTERNAL_API_KEY and DB_* only)
if [[ -n "${DB_HOST:-}" ]]; then
  echo "==> Writing /opt/mcp-bridge/.env"
  tmpfile=$(mktemp)
  cat >"$tmpfile" <<EOF
PORT=3334
DEBUG=true
EXTERNAL_API_KEY=${MCP_API_KEY:-}
DB_HOST=${DB_HOST:-}
DB_PORT=${DB_PORT:-}
DB_NAME=${DB_NAME:-}
DB_USER=${DB_USER:-}
DB_PASSWORD=${DB_PASSWORD:-}
DB_SSL=${DB_SSL:-}
EOF
  rcat "/opt/mcp-bridge/.env" "$tmpfile"; rm -f "$tmpfile"
fi

# mcp (SSE proxy) .env (no Intervals keys here per plan)
if [[ -d "server-snapshot/mcp" ]]; then
  echo "==> Writing /opt/mcp/.env"
  tmpfile=$(mktemp)
  cat >"$tmpfile" <<EOF
HOST=127.0.0.1
PORT=3333
DEBUG=true
EOF
  rcat "/opt/mcp/.env" "$tmpfile"; rm -f "$tmpfile"
fi

# stas-auth-gateway .env (basic, unified STAS_API_BASE)
if [[ -n "${STAS_API_KEY:-}" ]]; then
  echo "==> Writing /opt/stas-auth-gateway/.env"
  tmpfile=$(mktemp)
  cat >"$tmpfile" <<EOF
PORT=3337
NODE_ENV=production
STAS_API_BASE=https://${TARGET_DOMAIN:-intervals.stas.run}/api
STAS_API_KEY=${STAS_API_KEY:-}
DEBUG=true
EOF
  rcat "/opt/stas-auth-gateway/.env" "$tmpfile"; rm -f "$tmpfile"
fi

# 4) Systemd units
create_unit() {
  local name="$1"; local content="$2"; local tmpfile; tmpfile=$(mktemp); printf "%s" "$content" >"$tmpfile"; rcat "/etc/systemd/system/$name" "$tmpfile"; rm -f "$tmpfile"
}

echo "==> Installing systemd units"
create_unit "stas-db-bridge.service" "[Unit]\nDescription=STAS DB Bridge\nAfter=network.target\n\n[Service]\nType=simple\nWorkingDirectory=/opt/stas-db-bridge\nEnvironmentFile=/opt/stas-db-bridge/.env\nExecStart=/usr/bin/node /opt/stas-db-bridge/app.js\nRestart=always\nRestartSec=2\n\n[Install]\nWantedBy=multi-user.target\n"

create_unit "mcp-bridge.service" "[Unit]\nDescription=MCP Bridge (Intervals.icu HTTP proxy)\nAfter=network.target\n\n[Service]\nType=simple\nWorkingDirectory=/opt/mcp-bridge\nEnvironmentFile=/opt/mcp-bridge/.env\nExecStart=/usr/bin/node /opt/mcp-bridge/app.js\nRestart=always\nRestartSec=2\n\n[Install]\nWantedBy=multi-user.target\n"

create_unit "stas-auth-gateway.service" "[Unit]\nDescription=STAS Auth Gateway (OAuth + API proxy)\nAfter=network.target\n\n[Service]\nType=simple\nWorkingDirectory=/opt/stas-auth-gateway\nEnvironmentFile=/opt/stas-auth-gateway/.env\nExecStart=/usr/bin/node /opt/stas-auth-gateway/app.js\nRestart=always\nRestartSec=3\nUser=root\nGroup=root\nStandardOutput=journal\nStandardError=journal\n\n[Install]\nWantedBy=multi-user.target\n"

remote "systemctl daemon-reload"
remote "systemctl enable --now stas-db-bridge.service || true"
remote "systemctl enable --now mcp-bridge.service || true"
remote "systemctl enable --now stas-auth-gateway.service || true"

# Optional: SSE proxy unit if binary exists
remote "test -f /opt/mcp/dist/index.js && printf '%s' '[Unit]\nDescription=mcp-sse-proxy\nAfter=network.target\n\n[Service]\nType=simple\nWorkingDirectory=/opt/mcp\nEnvironmentFile=/opt/mcp/.env\nExecStart=/usr/bin/node /opt/mcp/dist/index.js\nRestart=always\nRestartSec=2\n\n[Install]\nWantedBy=multi-user.target\n' > /etc/systemd/system/mcp-sse-proxy.service || true"
remote "test -f /etc/systemd/system/mcp-sse-proxy.service && systemctl daemon-reload && systemctl enable --now mcp-sse-proxy || true"

# 5) Nginx vhost
if [[ -n "${TARGET_DOMAIN:-}" ]]; then
  echo "==> Installing nginx vhost for ${TARGET_DOMAIN}"
  tmpfile=$(mktemp)
  cat >"$tmpfile" <<EOF
server {
  listen 80;
  server_name ${TARGET_DOMAIN};
  return 301 https://\$host\$request_uri;
}

server {
  listen 443 ssl http2;
  server_name ${TARGET_DOMAIN};

  ssl_certificate     /etc/letsencrypt/live/${TARGET_DOMAIN}/fullchain.pem;
  ssl_certificate_key /etc/letsencrypt/live/${TARGET_DOMAIN}/privkey.pem;

  client_max_body_size 20m;

  proxy_set_header Host              \$host;
  proxy_set_header X-Real-IP         \$remote_addr;
  proxy_set_header X-Forwarded-For   \$proxy_add_x_forwarded_for;
  proxy_set_header X-Forwarded-Proto \$scheme;

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
    proxy_set_header X-API-Key \$http_x_api_key;
    proxy_pass http://127.0.0.1:3336/;
  }

  location /icu/ {
    proxy_http_version 1.1;
    proxy_set_header Connection "";
    proxy_set_header X-API-Key \$http_x_api_key;
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
EOF
  rcat "/etc/nginx/sites-available/${TARGET_DOMAIN}.conf" "$tmpfile"; rm -f "$tmpfile"
  remote "ln -sf /etc/nginx/sites-available/${TARGET_DOMAIN}.conf /etc/nginx/sites-enabled/${TARGET_DOMAIN}.conf && nginx -t && systemctl reload nginx"
fi

echo "==> Capture service status"
remote "journalctl -u stas-db-bridge -n 50 --no-pager || true"
remote "journalctl -u mcp-bridge -n 50 --no-pager || true"
remote "journalctl -u stas-auth-gateway -n 50 --no-pager || true"

# 6) Show commit hashes
remote "echo '== Commits ==' && for d in /opt/stas-auth-gateway /opt/stas-db-bridge /opt/mcp-bridge /opt/mcp; do echo \"$d:\"; cd \"$d\" && git log -n 1 --pretty=oneline || true; done"

echo "All done."
