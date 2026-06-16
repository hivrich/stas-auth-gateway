# Gateway Deploy Runbook

This is the current production deploy path for `intervals.stas.run`.

## Active Production

Production runs from the `stas.run` Docker Compose stack:

- Host alias: `intervals-prod`
- Public host: `intervals.stas.run`
- Current public IP: `162.248.162.6`
- Compose directory: `/opt/stas`
- Compose file: `/opt/stas/docker-compose.yml`
- Gateway source: `/opt/stas/bridge-api`
- Gateway service: `bridge-api`
- Gateway container: `stas-bridge-api-1`
- Gateway internal port: `3001`

The old `/opt/stas-auth-gateway` checkout can exist on the server, but it is not the active runtime while `stas-bridge-api-1` is running.

Do not deploy gateway changes to `109.172.46.200` for the current `intervals.stas.run` production host. That is an old host reference.

## Source Of Truth

Current local repo:

```bash
/home/codex/codex-work/Projects/stas-auth-gateway-clean
```

Current active branch after merge:

```bash
main
```

ChatGPT Actions schema source:

```bash
/home/codex/codex-work/Projects/stas.run/product/gpt-actions-current.json
```

Runtime gateway copy served by production:

```bash
/opt/stas/bridge-api/openapi.actions.json
```

These two Actions JSON files must stay equivalent when changing GPT Actions.

## Safe Deploy

From the local gateway repo:

```bash
tar -czf /tmp/stas-bridge-api-deploy.tgz \
  README.md \
  package.json \
  openapi.actions.json \
  openapi.min.json \
  routes/oauth.js \
  middleware/oauth_page.js \
  docs/CLAUDE_REMOTE_MCP.md \
  docs/GATEWAY_DEPLOY_RUNBOOK.md \
  scripts/smoke-oauth-gpt.sh \
  scripts/test-oauth-flow.js

scp /tmp/stas-bridge-api-deploy.tgz intervals-prod:/tmp/
```

On the server:

```bash
cd /opt/stas/bridge-api
backup="/opt/stas/bridge-api/.backup/deploy-$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$backup"

for f in \
  README.md \
  package.json \
  openapi.actions.json \
  openapi.min.json \
  routes/oauth.js \
  middleware/oauth_page.js \
  docs/CLAUDE_REMOTE_MCP.md \
  docs/GATEWAY_DEPLOY_RUNBOOK.md \
  scripts/smoke-oauth-gpt.sh \
  scripts/test-oauth-flow.js
do
  if [ -f "$f" ]; then
    mkdir -p "$backup/$(dirname "$f")"
    cp "$f" "$backup/$f"
  fi
done

tar -xzf /tmp/stas-bridge-api-deploy.tgz -C /opt/stas/bridge-api
chmod +x /opt/stas/bridge-api/scripts/smoke-oauth-gpt.sh
rm -f /tmp/stas-bridge-api-deploy.tgz

cd /opt/stas
docker compose up -d --build bridge-api
```

## Required Checks

Local checks before deploy:

```bash
npm run test:oauth
node --check routes/oauth.js
node --check middleware/oauth_page.js
node --check scripts/test-oauth-flow.js
```

Production checks after deploy:

```bash
curl -sS https://intervals.stas.run/gw/healthz

python3 - <<'PY'
import json, urllib.request
doc = json.load(urllib.request.urlopen("https://intervals.stas.run/gw/openapi.actions.json", timeout=10))
paths = doc.get("paths", {})
flow = doc["components"]["securitySchemes"]["oauth2"]["flows"]["authorizationCode"]
print("paths", len(paths))
print("has_activity_detail", "/gw/api/db/activity_detail" in paths)
print("authorizationUrl", flow["authorizationUrl"])
print("tokenUrl", flow["tokenUrl"])
PY

scripts/smoke-oauth-gpt.sh

curl -sS -o /tmp/activity_detail_status_body -w '%{http_code}\n' \
  'https://intervals.stas.run/gw/api/db/activity_detail?training_id=__smoke__'

ssh intervals-prod 'cd /opt/stas && docker compose ps bridge-api'
ssh intervals-prod 'cd /opt/stas && docker compose exec -T bridge-api npm run test:oauth'
```

Expected:

- `/gw/healthz` returns OK.
- `openapi.actions.json` has 13 paths and includes `/gw/api/db/activity_detail`.
- OAuth URLs are `https://intervals.stas.run/gw/oauth/authorize` and `https://intervals.stas.run/gw/oauth/token`.
- GPT OAuth smoke redirects to Intervals with `redirect_uri=https://intervals.stas.run/gw/oauth/callback`.
- `activity_detail` smoke returns `401` without a token, not `404`.
- `stas-bridge-api-1` is running.

## Cleanup Guardrails

Do not delete server directories or old checkouts during a normal deploy.

Destructive cleanup candidates, such as removing `/opt/stas-auth-gateway` or old backup/action schema files, require a separate explicit cleanup approval and a fresh backup.
