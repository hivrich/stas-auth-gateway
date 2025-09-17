# STAS Auth Gateway (Starter for Cursor)

Готовая структура проекта для переноса в Cursor.

## Быстрый старт (локально)

1) Установи Node.js 22 (через nvm)  
2) Создай `.env` и заполни значения:  
```

### Примечания

- Разрешены redirect_uri только на `chat.openai.com` и `chatgpt.com` с путями:
  - `/aip/api/callback`
  - `/aip/g-*/oauth/callback` (например, `/aip/g-abc123/oauth/callback`)
- Параметр `state` из `/oauth/authorize` автоматически прокидывается в редирект.
PORT=3337
JWT_SECRET=<set-strong-random>
REFRESH_PEPPER=<set-strong-random>
TOKEN_TTL_SECONDS=3600
REFRESH_TTL_SECONDS=2592000

DB_HOST=<host>
DB_PORT=5432
DB_NAME=<db>
DB_USER=<user>
DB_PASSWORD=<password>
DB_SSL=false

# Строгая валидация STAS (prod=true)
SKIP_STAS_VALIDATE=false
STAS_API_BASE=https://stas.stravatg.ru
STAS_API_KEY=<stas_key>

# MCP (Intervals.icu bridge)
MCP_API_BASE=https://mcp.stravatg.ru/api
MCP_API_KEY=<mcp_key>
# Health diagnostics (optional)
HEALTH_USER_ID=0
```
3) Установи зависимости:
```bash
npm install
```
4) Накати миграции:
```bash
npm run migrate
```
5) Запусти сервис:
```bash
npm run dev
```
6) Проверка:
```bash
curl -s http://127.0.0.1:3337/healthz | jq .
```

## OAuth

Сид клиента (ChatGPT Actions):
```bash
psql -h <DB_HOST> -U <DB_USER> -d <DB_NAME> -f bin/seed_client.sql
```

CLI-проверка потока:
```bash
# 1) AUTHORIZE -> code (302)
AUTH_URL='http://127.0.0.1:3337/oauth/authorize?client_id=chatgpt-actions&redirect_uri=https://chatgpt.com/aip/api/callback&scope=read:me%20icu%20workouts:write&user_id=<USER_ID>'
REDIR=$(curl -s -D - -o /dev/null "$AUTH_URL" | awk 'BEGIN{IGNORECASE=1} /^Location:/{print $2; exit}' | tr -d '\r')
CODE=$(printf '%s' "$REDIR" | sed -n 's/.*[?&]code=\([^&]*\).*/\1/p')

# 2) TOKEN (authorization_code)
CLIENT_SECRET='<paste_secret_from_seed>'
curl -sS --http1.1 -X POST http://127.0.0.1:3337/oauth/token \
  -u "chatgpt-actions:${CLIENT_SECRET}" -H 'Content-Type: application/x-www-form-urlencoded' \
  --data-urlencode grant_type=authorization_code --data-urlencode code="$CODE" \
  --data-urlencode redirect_uri=https://chatgpt.com/aip/api/callback | jq .

# 3) API
AT='<access_token>'
curl -sS http://127.0.0.1:3337/api/me -H "Authorization: Bearer $AT" | jq .
curl -sS 'http://127.0.0.1:3337/api/icu/activities?days=7' -H "Authorization: Bearer $AT" | jq .
```

## Маршруты

- `GET /healthz`
- `GET /oauth/authorize?client_id&redirect_uri&scope&user_id`
- `POST /oauth/token` (grant_type=authorization_code|refresh_token)
- `GET /api/me` (Bearer JWT)
- `ANY /^/api/icu/` (прокси в MCP, требует скоупы: icu для GET, workouts:write для POST/DELETE)

## Health

- `GET /healthz` всегда возвращает единый JSON объект `{ ok, time, stas?, env }`.
- В блоке `env` присутствуют небезопасные (не секретные) диагностические поля:
  - `skip_stas_validate` — флаг из `.env` (true/false)
  - `health_user_id` — значение `HEALTH_USER_ID` из `.env` (число или null)

## Тесты

Запуск минимальных тестов для проверки whitelist редиректов:

```bash
npm test
```

## Деплой (контур)

- Скопировать проект в `/opt/stas-auth-gateway`
- Положить `.env` (секреты не коммитим)
- Установить systemd-юнит из `deploy/stas-auth-gateway.service`
- Настроить nginx фрагмент из `deploy/nginx.conf`

Важное:
- `proxy_pass http://127.0.0.1:3337/;` с трейлинг‑слешем для `/gw/`.
- Проверить `/gw/healthz` возвращает 200.
