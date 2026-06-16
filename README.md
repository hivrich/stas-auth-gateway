# STAS Auth Gateway v2

Продовый мост между STAS, Intervals.icu, ChatGPT и Claude Remote MCP.

## Что сейчас делает мост

- отдаёт OAuth metadata для внешних клиентов;
- принимает OAuth от GPT и Claude;
- для Claude поддерживает Dynamic Client Registration;
- сам подставляет серверные Intervals credentials для Claude, без ручного `client id / secret` у пользователя;
- после успешного входа синхронизирует пользователя в STAS;
- проксирует чтение и запись данных между STAS и Intervals.

Короткая production-спека по Claude сохранена в:

- `docs/CLAUDE_REMOTE_MCP.md`

Правило сопровождения:

- нельзя оставлять рабочие изменения только на production;
- после любой правки bridge flow состояние должно быть сохранено в этом репозитории и запушено в GitHub.

## Env

- PORT — порт шлюза. Для production Docker Compose сейчас используется `3001`.
- STAS_BASE — адрес STAS app. В production Compose это `http://app:3000`.
- STAS_KEY или DB_BRIDGE_API_KEY — API-key для DB-bridge
- INTERVALS_API_BASE_URL — https://intervals.icu/api/v1
- INTERVALS_CLIENT_ID — OAuth client для Intervals
- INTERVALS_CLIENT_SECRET — OAuth secret для Intervals
- CLAUDE_OAUTH_CLIENT_ID — опциональный публичный client id для DCR ответа Claude

## Запуск

Mac path: `/Users/hivr/Projects/stas-auth-gateway`.
Server-local path: `/home/codex/codex-work/Projects/stas-auth-gateway`.

Приватный `.env` не хранится в git. Для запуска:

    set -a; source .env; set +a
    node server.js

Проверка:

    curl -sS http://127.0.0.1:3337/gw/healthz

Для локальной проверки нового `activity_detail` есть отдельный smoke-скрипт:

    GW_ACTIVITY_DETAIL_TOKEN=... GW_ACTIVITY_DETAIL_TRAINING_ID=... scripts/smoke-gw.sh

По умолчанию эта проверка пропускается, так что реальные production `user_id` не нужны.
Для быстрой проверки проксирования можно запустить:

    npm run test:db-proxy

OAuth flow нужно проверять отдельно после любой правки gateway-auth, OpenAPI Actions или деплоя bridge-api:

    npm run test:oauth
    scripts/smoke-oauth-gpt.sh

Ожидаемый контракт: GPT OAuth с Intervals scope сразу отдаёт `302` на `https://intervals.icu/oauth/authorize`, но внутри Intervals URL должен быть `redirect_uri=https://intervals.stas.run/gw/oauth/callback`, а не ChatGPT callback.
Legacy-страница ввода STAS ID не должна перехватывать этот сценарий.

## Production runtime

Active production for `intervals.stas.run` runs from `/opt/stas/docker-compose.yml`.
The gateway service is `bridge-api`, built from `/opt/stas/bridge-api`, exposed inside Docker on `PORT=3001`.
The older `/opt/stas-auth-gateway` checkout is not the active runtime when `stas-bridge-api-1` is running.
On 2026-06-16 it was disabled by renaming it to `/opt/stas-auth-gateway.legacy-disabled-20260616T213939Z`.

Current deploy instructions live in `docs/GATEWAY_DEPLOY_RUNBOOK.md`.

Secrets and certificates are not stored in git.
