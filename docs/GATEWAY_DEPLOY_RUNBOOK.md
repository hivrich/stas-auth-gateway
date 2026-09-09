# Gateway Deploy Runbook

This is the current production deploy path for `intervals.stas.run`.

## Active Production

Production runs from the `stas.run` Docker Compose stack:

- Host alias: `stas-prod` (SSH as `deploy`)
- Public host: `intervals.stas.run`
- Current public IP: `157.180.45.93` (Hetzner)
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

Canonical local source before a deploy:

```bash
/home/codex/codex-work/Projects/stas-auth-gateway-clean
```

It must be the clean, merged primary checkout on:

```bash
main
```

Never deploy from a feature worktree. Merge the reviewed change first, then
update the clean primary `main` checkout before starting this runbook.

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
- The app release containing `20260909_add_gateway_client_assertion_replay` and discovery forwarding has been deployed through its guarded app workflow. The gateway helper below must independently confirm the actual runtime database schema and privileges; a successful app release alone does not bypass this gate.
- Local validation passes.
- OAuth bridge accepts `S256` when PKCE is sent; no `plain` PKCE compatibility is enabled. The ChatGPT no-PKCE callback exception must stay covered by OAuth tests.
- `GATEWAY_BASE_URL` is set to the public canonical gateway URL, currently `https://intervals.stas.run`, so OAuth metadata never advertises the internal compose host.
- Legacy STAS-ID HTML and legacy token exchange flags are intentionally default-off.
- If Agent Auth is enabled, `AGENT_AUTH_TOKEN_SECRET` is set to a non-placeholder value of at least 32 characters.
- Production is confirmed to run one `bridge-api` process, or OAuth/Agent Auth state has shared storage. Current local state is in-memory.
- Docker context excludes `.env*`, `.git`, `.git/`, `.codex`, `node_modules`, stale schemas, and static legacy OAuth pages.
- `rsync --dry-run` has been reviewed, then a server-side backup has been created before the real sync.
- No deploy targets the old `/opt/stas-auth-gateway*` checkout or old host references.

## Safe Deploy

From the clean, merged primary `main` gateway checkout (never a feature worktree), sync the current repository contents to the production bridge source.
Do not sync local dependencies, git/Codex metadata, env files, private directories, keys, certs, logs, rendered secret dumps, or backups.

Create one shared exclude file before the dry-run and keep the same shell open through the backup and real sync.
The backup must use this same list; do not create a separate, narrower tar exclude list.

```bash
DEPLOY_EXCLUDES_FILE="$(mktemp)"
trap 'rm -f "$DEPLOY_EXCLUDES_FILE"' EXIT
cat > "$DEPLOY_EXCLUDES_FILE" <<'EOF'
node_modules/
.git
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
  ./ stas-prod:/opt/stas/bridge-api/
```

After the dry-run output is clean and deploy is explicitly approved, create the server backup before any real sync:

```bash
DEPLOY_EXCLUDES_B64="$(base64 < "$DEPLOY_EXCLUDES_FILE" | tr -d '\n')"
ssh stas-prod "DEPLOY_EXCLUDES_B64='$DEPLOY_EXCLUDES_B64' bash -s" <<'EOF'
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
  ./ stas-prod:/opt/stas/bridge-api/
```

After the separately approved app migration and the source sync above, use
the mandatory gateway release helper on the server. This replaces the old
direct `docker compose build` / `docker compose up` recipe; do not use those
commands independently for gateway releases.

```bash
cd /opt/stas
bash /opt/stas/bridge-api/scripts/deploy-prod-gateway.sh --apply
```

The helper holds the same deploy lock as the app release, builds the candidate,
pins its immutable image ID, and runs `check-oauth-replay-readiness.js` **inside
that candidate using the bridge-api Compose service environment and network**.
It uses the gateway's real `STAS_PGURL` role, not the database container owner.
The checker opens a read-only transaction and checks catalogs only: the replay
table/columns, primary key, expiry index, schema usage and SELECT/INSERT/DELETE/
UPDATE privileges (UPDATE is required for cleanup's row locking). It never
inserts/deletes a row or prints connection strings. Any missing schema,
permission or database failure stops before replacement; the old gateway keeps
running. This gate does not apply migrations or change grants/source/data.

Only after readiness passes does the helper recreate bridge-api with that same
image and configuration, verify the running image and public health, and run
the mandatory structured-JSON discovery check. The release succeeds only when:

- `https://intervals.stas.run/.well-known/oauth-authorization-server` and
  `https://stas.run/.well-known/oauth-authorization-server` both advertise
  `private_key_jwt` and exactly `["RS256"]` signing algorithms;
- `https://stas.run/.well-known/oauth-protected-resource/api/mcp` identifies
  `https://stas.run/api/mcp` and links to the correct authorization server.

The protected-resource document itself does not publish token authentication
methods; those belong to authorization-server metadata. Postchecks allow up to
360 seconds for existing discovery caches. Failure is nonzero and must be
investigated; the helper does not automatically roll back to an older gateway
that might ignore signed-client authentication. See the rollback restriction
in [PRIVATE_KEY_JWT.md](PRIVATE_KEY_JWT.md). Ordinary app deploys do not replace
gateway source or run this gateway release helper.

## Required Checks

For a connection that completes the callback but fails before token issuance,
use the privacy-safe token stages described in
[OAuth token diagnostics](OAUTH_TOKEN_DIAGNOSTICS.md). Do not enable body,
header, assertion or query logging to investigate an individual attempt.

Local checks before deploy:

```bash
npm run test:route-order
npm run test:oauth-release-safety
npm run test:oauth-token-diagnostics
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
- `openapi.actions.json` matches the reviewed contract and includes `/gw/api/db/activity_detail`.
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
