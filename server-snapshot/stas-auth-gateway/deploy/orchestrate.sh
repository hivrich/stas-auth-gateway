#!/usr/bin/env bash
set -euo pipefail

# Orchestrates Steps A/B/C end-to-end using the server as source of truth.
# Prereqs (export in your shell or use deploy/.env.deploy):
#   SSH_HOST, SSH_PASS (optional), TARGET_DOMAIN,
#   STAS_API_KEY, MCP_API_KEY,
#   DB_HOST, DB_PORT, DB_NAME, DB_USER, DB_PASSWORD, DB_SSL,
#   USER_ID (for smoke)

require() { local n="$1"; [[ -n "${!n:-}" ]] || { echo "Missing env: $n" >&2; exit 1; }; }
require SSH_HOST; require TARGET_DOMAIN; require STAS_API_KEY; require MCP_API_KEY
require DB_HOST; require DB_PORT; require DB_NAME; require DB_USER; require DB_PASSWORD; require DB_SSL

# A) INIT HOST (on server)
cat > /tmp/init-host.sh <<'SH'
#!/usr/bin/env bash
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y --no-install-recommends curl jq rsync nginx ca-certificates gnupg lsb-release postgresql-client nodejs npm
mkdir -p /opt/stas-auth-gateway /opt/stas-db-bridge /opt/mcp-bridge /opt/mcp
systemctl daemon-reload
nginx -t >/dev/null 2>&1 || true
SH
chmod +x /tmp/init-host.sh
scp -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null /tmp/init-host.sh "$SSH_HOST:/root/init-host.sh"
ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null "$SSH_HOST" 'bash /root/init-host.sh'

# B1) SNAPSHOT from server -> local
mkdir -p server-snapshot
for d in stas-auth-gateway stas-db-bridge mcp-bridge mcp; do
  src="/opt/$d"; dst="server-snapshot/$d"; mkdir -p "$dst"
  rsync -e "ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null" -a --delete --exclude '.git' --exclude 'node_modules' --exclude '*.log' --exclude 'logs' \
    "$SSH_HOST:$src/" "$dst/" || true
done

# B2) SYNC back and configure using existing sync-and-setup.sh
bash "$(dirname "$0")/sync-and-setup.sh"

# C) SMOKE
export USER_ID=${USER_ID:-}
if [[ -n "${USER_ID}" ]]; then
  bash "$(dirname "$0")/smoke.sh"
else
  echo "USER_ID not set, skipping smoke. Export USER_ID and re-run deploy/smoke.sh" >&2
fi

echo "Orchestration complete."
