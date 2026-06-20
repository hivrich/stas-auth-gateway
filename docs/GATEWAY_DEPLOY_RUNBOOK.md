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

The old `/opt/stas-auth-gateway` checkout is not the active runtime while `stas-bridge-api-1` is running.
On 2026-06-16 it was disabled by renaming it to:

```bash
/opt/stas-auth-gateway.legacy-disabled-20260616T213939Z
```

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

`/opt/stas/bridge-api` is a deploy copy, not the source-of-truth git checkout.
Stale server-local `.git` metadata was archived on 2026-06-16 to:

```bash
/opt/stas/legacy-cleanup/bridge-api-git-metadata-20260616T215004Z
```

Canonical OpenAPI source in this gateway is `openapi.actions.json`.
`/gw/openapi.json` and `/gw/openapi.actions.json` must serve the same canonical JSON.
Stale `openapi.yaml`, `openapi.min.json`, and `openapi.min.yaml` variants must stay out of the Docker runtime context.

## Deploy Stops

Stop before any deploy unless all of these are true:

- User has explicitly approved the deploy.
- Local validation passes.
- OAuth bridge accepts `S256` when PKCE is sent; no `plain` PKCE compatibility is enabled. The ChatGPT no-PKCE callback exception must stay covered by OAuth tests.
- `GATEWAY_BASE_URL` is set to the public canonical gateway URL, currently `https://intervals.stas.run`, so OAuth metadata never advertises the internal compose host.
- Legacy STAS-ID HTML and legacy token exchange flags are intentionally default-off.
- If Agent Auth is enabled, `AGENT_AUTH_TOKEN_SECRET` is set to a non-placeholder value of at least 32 characters.
- Production is confirmed to run one `bridge-api` process, or OAuth/Agent Auth state has shared storage. Current local state is in-memory.
- Docker context excludes `.env*`, `.git`, `.codex`, `node_modules`, stale schemas, and static legacy OAuth pages.
- `rsync --dry-run` has been reviewed, then a server-side backup has been created before the real sync.
- No deploy targets the old `/opt/stas-auth-gateway*` checkout or old host references.

## Safe Deploy

From the local gateway repo, sync the current repository contents to the production bridge source.
Do not sync local dependencies, git/Codex metadata, env files, private directories, keys, certs, logs, rendered secret dumps, or backups.

Create one shared exclude file before the dry-run and keep the same shell open through the backup and real sync.
The backup must use this same list; do not create a separate, narrower tar exclude list.

```bash
DEPLOY_EXCLUDES_FILE="$(mktemp)"
trap 'rm -f "$DEPLOY_EXCLUDES_FILE"' EXIT
cat > "$DEPLOY_EXCLUDES_FILE" <<'EOF'
node_modules/
.git/
.codex/
.private/
.secrets/
private/
secrets/
keys/
certs/
.ssh/
.env*
*.env
*.key
*.pem
*.crt
*.cert
*.cer
*.p12
*.pfx
*.p8
*.jks
*.keystore
id_rsa
id_dsa
id_ecdsa
id_ed25519
*_rsa
*_dsa
*_ecdsa
*_ed25519
*.log
*.log.*
logs/
rendered-secret*
rendered-secrets/
secret-dump*
secret-dumps/
*.dump
*.sql
*.sql.gz
*.bak
*.backup
*.orig
backup/
backups/
EOF
```

First run the mandatory dry-run and review every created, updated, and deleted path:

```bash
rsync -azn --delete --itemize-changes --exclude-from="$DEPLOY_EXCLUDES_FILE" \
  ./ intervals-prod:/opt/stas/bridge-api/
```

After the dry-run output is clean and deploy is explicitly approved, create the server backup before any real sync:

```bash
DEPLOY_EXCLUDES_B64="$(base64 < "$DEPLOY_EXCLUDES_FILE" | tr -d '\n')"
ssh intervals-prod "DEPLOY_EXCLUDES_B64='$DEPLOY_EXCLUDES_B64' bash -s" <<'EOF'
set -euo pipefail
cd /opt/stas/bridge-api
backup="/opt/stas/legacy-cleanup/bridge-api-predeploy-$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$backup"
exclude_file="$(mktemp)"
trap 'rm -f "$exclude_file"' EXIT
printf '%s' "$DEPLOY_EXCLUDES_B64" | base64 -d > "$exclude_file"
tar -czf "$backup/source-before-deploy.tgz" \
  --exclude-from "$exclude_file" \
  .
echo "$backup"
EOF
```

Run the real sync only after the backup command has completed successfully:

```bash
rsync -az --delete --itemize-changes --exclude-from="$DEPLOY_EXCLUDES_FILE" \
  ./ intervals-prod:/opt/stas/bridge-api/
```

Then run the deploy commands on the server:

```bash
cd /opt/stas/bridge-api
chmod +x /opt/stas/bridge-api/scripts/smoke-oauth-gpt.sh

cd /opt/stas
docker compose build bridge-api
docker compose up -d bridge-api
```

## Required Checks

Local checks before deploy:

```bash
npm run test:route-order
npm run test:openapi-contract
npm run test:oauth
npm run test:icu-post
npm run test:bearer-auth
npm run test:db-proxy
npm run test:agent-auth
npm run test:legacy-aliases
npm run test:delete-safety
node --check server.js
node --check middleware/oauth_page.js
node --check middleware/security.js
node --check scripts/test-oauth-flow.js
git diff --check
docker build -t stas-auth-gateway-clean:codex-local .
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

Cleanup state from 2026-06-16:

- Old checkout disabled, not deleted: `/opt/stas-auth-gateway.legacy-disabled-20260616T213939Z`
- Old bridge source artifacts archived, not deleted: `/opt/stas/legacy-cleanup/bridge-api-artifacts-20260616T214204Z`

Keep those archives for rollback until a separate cleanup approval says they can be deleted.
