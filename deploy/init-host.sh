#!/usr/bin/env bash
set -euo pipefail

# This script is intended to be executed ON THE TARGET HOST as root.
# Usage on remote: bash /root/init-host.sh
# If copying from your laptop: scp init-host.sh root@HOST:/root/ && ssh root@HOST 'bash /root/init-host.sh'

export DEBIAN_FRONTEND=noninteractive

# 1) Base packages
apt-get update
apt-get install -y curl git ufw nginx jq gnupg ca-certificates lsb-release postgresql-client

# 2) Node.js LTS + pm2 (optional)
if ! command -v node >/dev/null 2>&1; then
  curl -fsSL https://deb.nodesource.com/setup_lts.x | bash -
  apt-get install -y nodejs
fi
npm i -g pm2 || true

# 3) Project tree
mkdir -p /opt/{stas-auth-gateway,stas-db-bridge,mcp-bridge,mcp} /var/log/intervals
chown -R root:root /opt

# 4) Firewall (optional)
ufw allow 22/tcp || true
ufw allow 80,443/tcp || true
# ufw enable  # enable carefully

# 5) Nginx directories sanity
mkdir -p /etc/nginx/sites-available /etc/nginx/sites-enabled

# 6) Done
nginx -v || true
node -v || true
npm -v || true
