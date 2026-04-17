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

## Env

- PORT — порт шлюза (прод: 3338)
- STAS_BASE — http://127.0.0.1:3336 (DB-bridge)
- STAS_KEY или STAS_KEY_FILE — API-key для DB-bridge
- INTERVALS_API_BASE_URL — https://intervals.icu/api/v1
- INTERVALS_CLIENT_ID — OAuth client для Intervals
- INTERVALS_CLIENT_SECRET — OAuth secret для Intervals
- CLAUDE_OAUTH_CLIENT_ID — опциональный публичный client id для DCR ответа Claude

## Запуск

    env STAS_BASE="http://127.0.0.1:3336" STAS_KEY="***" INTERVALS_API_BASE_URL="https://intervals.icu/api/v1" PORT=3338 \
      node server.js

## Systemd / Nginx

Смотрите примеры в contrib/systemd/*.service.example и contrib/nginx/*.example.
Секреты/сертификаты не входят в репозиторий.
