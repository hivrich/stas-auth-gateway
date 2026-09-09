# CIMD private_key_jwt

The gateway accepts key-authenticated CIMD clients without provider-specific
hostnames or callbacks. DCR secret/public clients, public CIMD clients, and
Agent Auth keep their existing paths. This implements the client-authentication
profile of [RFC 7523](https://www.rfc-editor.org/rfc/rfc7523), not the separate
JWT bearer authorization grant.

## Contract

- CIMD declares `token_endpoint_auth_method: private_key_jwt` and exactly one
  of `jwks`/`jwks_uri`; the optional signing algorithm defaults to `RS256`.
- Accept only public 2048–4096-bit RSA signing keys (at most eight). Private
  key fields, symmetric keys, unsuitable key usage, duplicate kids, and
  ambiguous key selection are rejected. A single-key set permits an omitted
  JWT `kid`; multiple keys require an exact `kid` match.
- Key fetch uses HTTPS public DNS targets, DNS-pinned connections, TLS
  hostname verification, no redirects, a 5-second total network deadline,
  JSON/JWK-set JSON content type, and a 64-KiB streamed-body cap. No URL or
  key supplied in a JWT header can change the trusted key source.
- JWKS success cache lasts five minutes; unknown kids/signature failures may
  refresh no more than once per source per minute. Concurrent loads share
  one request. At most 16 loads and 256 live source entries are allowed;
  overflow fails closed without evicting a live cooldown. Key rotation can
  therefore need up to one minute before a retry succeeds.
- Requests include exact `client_id`, the standard JWT bearer
  `client_assertion_type`, and `client_assertion`, with no mixed secret/HTTP
  authentication. Require `iss = sub = client_id`, and audience equal to the
  canonical `${GATEWAY_BASE_URL}/gw/oauth/token` (also for revocation).
  Require integer `iat`/`exp`, a nonempty JTI, at most five-minute lifetime,
  and at most 30 seconds of clock skew; check `nbf` when supplied.
- After signature verification, one atomic PostgreSQL insert consumes the
  SHA-256 hash of `[client_id, jti]`. Only that hash and expiry are stored.
  Reuse fails across requests, endpoints, processes, and restarts. Each
  attempt deletes at most 100 expired records using the expiry index. No
  new timer/worker is needed; at idle, expired hashes remain until the next
  verified attempt. Store outages and a missing table fail closed.
- New key-authenticated access/refresh tokens pin their authentication
  method in a server-signed claim. Rotation preserves the claim; a CIMD
  document changing to `none` cannot downgrade those tokens. Existing
  public tokens do not acquire extra metadata requests.

Authorization redirect, PKCE and resource binding remain enforced. Failures
return the existing non-diagnostic `invalid_client` OAuth response. Assertions,
public-key material, and raw JTIs are not logged.

For authorization-code exchange, the gateway first peeks at the code, checks
all grant bindings, and verifies the assertion without consuming anything.
It then exclusively reserves the in-memory code for at most ten seconds,
consumes the durable assertion marker, and synchronously finalizes the code
before starting the upstream exchange. Concurrent losers consume neither.
Definite JWKS/replay-store failures release the code so the same correct pair
can be retried after recovery (JWKS retries respect the one-minute cooldown).
This is not a PostgreSQL/in-memory distributed transaction: an ambiguous
database commit, process crash, expired reservation, or upstream exchange
failure can still require a fresh assertion/login. Those cases fail closed;
no assertion marker is deleted to permit replay and a stale reservation
cannot start an upstream exchange.

## Release order and rollback

Production deploy still requires a separate explicit owner command.

1. Merge the reviewed app change containing Prisma migration
   `20260909_add_gateway_client_assertion_replay` and discovery forwarding.
   The migration creates only `gw_oauth_client_assertions`; existing app and
   gateway versions remain compatible. The app advertises RS256 only after
   the actual gateway advertises it.
2. Use the app's documented guarded deploy and preflight to apply this
   migration before activating the new gateway image; do not invent
   credentials or change grants as an implicit part of a release.
3. Release the reviewed gateway using the mandatory executable helper in the
   [canonical runbook](GATEWAY_DEPLOY_RUNBOOK.md#safe-deploy). Before replacing
   the running image it checks the actual gateway database role and replay
   schema in a read-only candidate-image container; after public health it
   checks both public AS documents and protected-resource linkage. A failed
   readiness gate prevents replacement; a failed postcheck prevents success.
   The ordinary app deploy does not itself replace gateway source.
4. Check both public discovery endpoints advertise `private_key_jwt` and
   `token_endpoint_auth_signing_alg_values_supported: ["RS256"]`; app metadata
   caches gateway capabilities for 30 seconds and public metadata for five
   minutes. Then perform a fresh ChatGPT connection through Intervals.

Keep the table and replay hashes during rollback. **Do not roll back to an
older gateway after issuing private-key tokens without disabling/revoking
those token grants first**: old versions interpret URL-client refresh and
revocation as public (`none`). Prefer a forward fix or disable the affected
flow while retaining this version's authentication checks. The additive app
migration itself never needs destructive rollback.

The rest of the gateway still has single-process OAuth/Agent Auth state;
durable assertion replay does not authorize a multi-replica rollout.

## Local predeploy evidence

- `npm run test:private-key-jwt`: generated local RSA keys, hostile claims,
  replay, JWKS network safety, cache/rotation/concurrency/capacity bounds.
- `npm run test:oauth`: mocked Intervals full authorize → code → refresh →
  revoke flow, missing assertions, downgrade, PKCE/redirect/resource failures,
  existing Claude/Codex/public/DCR/confidential/Agent Auth regressions.
- Against a **new disposable local** PostgreSQL database `oauth_replay_test`,
  run `OAUTH_REPLAY_TEST_DATABASE_URL=postgresql://postgres@127.0.0.1:PORT/oauth_replay_test
  node scripts/test-private-key-jwt-pg.js /absolute/path/to/app/prisma/migrations/20260909_add_gateway_client_assertion_replay/migration.sql`.
  This applies the real migration and proves one winner in 12 concurrent
  validators, restart replay rejection, bounded cleanup, and DB failure.
  Never point it at an application database or use `STAS_PGURL` for this test.
- Run all gateway package test scripts, `node --check` on changed JS,
  `git diff --check`, and build the Docker image; use
  `STAS_PRODUCT_ACTIONS_SCHEMA` to select the matching current app worktree
  for OpenAPI parity when the main app checkout is older.

These tests use local fixtures rather than ChatGPT private keys or a live
Intervals grant. Actual ChatGPT login, Grok, and Perplexity remain post-release
user checks.
