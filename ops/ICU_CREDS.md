# ICU creds: source of truth

## Где хранятся креды
Source of truth: `public.user` (поля `athlete_id`, `api_key`).

`stas-db-bridge` отдаёт их через:
- `GET /api/db/icu_creds?user_id=<uid>`

`stas-auth-gateway` использует эти креды для прокси ICU через:
- `GET /gw/icu/events?days=N`
(UID берётся строго из Bearer-токена и прокидывается внутрь как `user_id`.)

## Депрекейтед
`public.gw_user_creds` больше не используется для ICU и должен быть пустым/необязательным.

## Smoke checks
- `curl -sS http://127.0.0.1:3336/healthz`
- `curl -sS "http://127.0.0.1:3336/api/db/icu_creds?user_id=<uid>" | head`
- `curl -sS -H "Authorization: Bearer <token>" "http://127.0.0.1:3338/gw/icu/events?days=1" | head`
