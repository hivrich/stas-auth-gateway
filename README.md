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

- PORT — порт шлюза. Source of truth для local/server-local и production: `3337`.
- STAS_BASE — http://127.0.0.1:3336 (DB-bridge)
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

## Systemd / Nginx

Production examples live in `deploy/`.
Production path remains `/opt/stas-auth-gateway`; service runs `/opt/stas-auth-gateway/server.js` with `PORT=3337`.
Nginx must pass `/gw/...` to Node without cutting the `/gw` prefix.

Secrets and certificates are not stored in git.
Use `deploy/.env.deploy.example` as a template, keep real values in ignored private files only.
