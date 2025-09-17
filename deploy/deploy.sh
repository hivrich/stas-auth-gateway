#!/usr/bin/env bash
set -euo pipefail

# STAS Auth Gateway deploy helper (run on target server as root or via sudo)
# - Assumes repository is already placed at /opt/stas-auth-gateway
# - Assumes .env is present at /opt/stas-auth-gateway/.env (secrets not in git)
# - Requires Node.js 22+ and systemd

APP_DIR="/opt/stas-auth-gateway"
SERVICE_UNIT="/etc/systemd/system/stas-auth-gateway.service"
OVERRIDE_DIR="/etc/systemd/system/stas-auth-gateway.service.d"
OVERRIDE_FILE="$OVERRIDE_DIR/override.conf"
NODE_BIN="/usr/bin/node"

if [[ ! -d "$APP_DIR" ]]; then
  echo "ERROR: $APP_DIR not found. Copy repo to $APP_DIR first." >&2
  exit 1
fi
if [[ ! -f "$APP_DIR/.env" ]]; then
  echo "ERROR: $APP_DIR/.env not found. Create it from .env.sample and fill secrets." >&2
  exit 1
fi

# Install service unit
install -m 0644 "$APP_DIR/deploy/stas-auth-gateway.service" "$SERVICE_UNIT"
mkdir -p "$OVERRIDE_DIR"
# Use override if present in repo
if [[ -f "$APP_DIR/deploy/systemd/override.conf" ]]; then
  install -m 0644 "$APP_DIR/deploy/systemd/override.conf" "$OVERRIDE_FILE"
fi

# Install dependencies
cd "$APP_DIR"
if command -v npm >/dev/null 2>&1; then
  npm ci --omit=dev || npm install --omit=dev
else
  echo "WARNING: npm not found; ensure Node 22+ and npm are installed. Skipping npm install."
fi

# Run DB migrations (requires DB_* env in .env)
if [[ -f "bin/migrate.js" ]]; then
  echo "Running migrations..."
  node bin/migrate.js || { echo "WARNING: migration failed; check DB connectivity and credentials" >&2; }
fi

# Reload systemd and restart service
systemctl daemon-reload
systemctl enable stas-auth-gateway.service
systemctl restart stas-auth-gateway.service
sleep 1
systemctl --no-pager status stas-auth-gateway.service || true

# Quick health check
HOST="${HOST:-127.0.0.1}"
PORT="${PORT:-3337}"
HEALTH_URL="http://$HOST:$PORT/healthz"

if command -v curl >/dev/null 2>&1; then
  echo "Health check: $HEALTH_URL"
  set +e
  curl -sSf "$HEALTH_URL" || true
  echo
  set -e
fi

echo "Deploy complete. Verify Nginx reverse proxy and OpenAPI: /gw/openapi.yaml"
