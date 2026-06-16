# Claude Remote MCP in bridge

Статус на `2026-04-17`: рабочее production-состояние.

Этот файл фиксирует именно bridge-часть Claude flow.

## Зачем это нужно

Claude подключает STAS как Remote MCP server по URL:

- `https://stas.run/api/mcp`

Но OAuth discovery и token flow идут через bridge:

- `https://intervals.stas.run/.well-known/oauth-authorization-server`
- `https://intervals.stas.run/gw/oauth/register`
- `https://intervals.stas.run/gw/oauth/authorize`
- `https://intervals.stas.run/gw/oauth/token`

## Какие файлы сейчас ключевые

- `routes/oauth.js`
- `server.js`
- `lib/request-auth.js`
- `lib/request-source.js`

## Что делает каждый файл

### `routes/oauth.js`

Отвечает за:

- `POST /oauth/register` для Dynamic Client Registration Claude;
- `GET /oauth/authorize` для редиректа в Intervals OAuth;
- `GET /oauth/callback` как общий callback от Intervals обратно в bridge;
- `POST /oauth/token` для обмена кода на токен;
- автоматическую подстановку серверных `INTERVALS_CLIENT_ID` и `INTERVALS_CLIENT_SECRET` для Claude;
- автоматическую подстановку серверного `INTERVALS_CLIENT_ID` для GPT, если ChatGPT присылает пустой `client_id`;
- bridge-code flow для GPT: ChatGPT callback хранится в подписанном `state`, Intervals получает только `https://intervals.stas.run/gw/oauth/callback`, а bridge затем возвращает ChatGPT код вида `gpt_...`;
- вызов `resolveDirectIntervalsAuth(...)` после получения Intervals access token.

### `server.js`

Отвечает за:

- `/.well-known/oauth-authorization-server`;
- публикацию `registration_endpoint`;
- публикацию `token_endpoint_auth_methods_supported`;
- проксирование bridge-ручек STAS и Intervals;
- `GET /gw/api/me`;
- `POST /gw/strategy`.

### `lib/request-auth.js`

Отвечает за:

- распознавание bearer token;
- различение legacy STAS token и прямого Intervals token;
- запрос в `https://intervals.icu/api/v1/athlete/0`;
- вызов `POST ${STAS_BASE}/api/db/ensure-intervals-user`;
- кэширование распознанных direct Intervals token.

### `lib/request-source.js`

Отвечает за:

- различение источника `gpt | claude`;
- распознавание Claude по `client_id` и `redirect_uri`;
- проброс `x-stas-source` в STAS.

## Как проходит Claude flow

1. Claude добавляет MCP server `https://stas.run/api/mcp`.
2. При первом защищённом вызове STAS отвечает `401` и отдаёт `resource_metadata`.
3. Claude читает bridge metadata:
   - `/.well-known/oauth-authorization-server`
4. Claude делает DCR:
   - `POST /gw/oauth/register`
5. Claude вызывает:
   - `GET /gw/oauth/authorize`
6. Bridge отправляет пользователя в Intervals OAuth.
7. После callback Claude вызывает:
   - `POST /gw/oauth/token`
8. Bridge получает Intervals access token.
9. Bridge вызывает `resolveDirectIntervalsAuth(...)`.
10. Bridge синхронизирует пользователя в STAS через `ensure-intervals-user`.
11. Дальше bridge уже может резолвить этого пользователя по direct Intervals bearer token.

## Как проходит GPT Actions flow

1. ChatGPT вызывает:
   - `GET /gw/oauth/authorize`
2. Bridge проверяет ChatGPT callback:
   - `https://chat.openai.com/aip/g-.../oauth/callback`
   - `https://chatgpt.com/aip/g-.../oauth/callback`
3. Bridge отправляет пользователя в Intervals OAuth, но с единым redirect:
   - `https://intervals.stas.run/gw/oauth/callback`
4. Intervals возвращает пользователя на:
   - `GET /gw/oauth/callback`
5. Bridge создаёт короткий bridge-code `gpt_...` и редиректит обратно в исходный ChatGPT callback.
6. ChatGPT вызывает:
   - `POST /gw/oauth/token`
7. Bridge меняет сохранённый Intervals code на Intervals access token, используя тот же redirect:
   - `https://intervals.stas.run/gw/oauth/callback`
8. Bridge вызывает `resolveDirectIntervalsAuth(...)`.
9. Дальше bridge резолвит пользователя по direct Intervals bearer token.

Для Intervals app `66` обязательно должен быть разрешён redirect URL:

- `https://intervals.stas.run/gw/oauth/callback`

Не нужно добавлять каждый новый ChatGPT `g-...` callback в Intervals app. Эти callback URL остаются только на стороне ChatGPT и bridge-state.

## Что важно для Claude

- ручной `client_secret` от пользователя не нужен;
- `token_endpoint_auth_method` для DCR клиента = `none`;
- callback URL разрешены только:
  - `https://claude.ai/api/mcp/auth_callback`
  - `https://claude.com/api/mcp/auth_callback`

## Что важно для STAS

Bridge обязан пробрасывать источник:

- `x-stas-source: claude`

Это нужно, чтобы:

- не трогать GPT-метрики;
- писать `claude_connected`;
- писать `claude_data_requested`;
- не обновлять `gptConnectedAt`.

## Живые признаки, что всё работает

В логах bridge должны появляться:

- `[oauth][register]`
- `[oauth][authorize]`
- `[oauth][token][request]`
- `[db_proxy][REQ]`
- `[db_proxy][RES]`

## Production paths

На production это лежит в:

- `/opt/stas-auth-gateway/routes/oauth.js`
- `/opt/stas-auth-gateway/server.js`
- `/opt/stas-auth-gateway/lib/request-auth.js`
- `/opt/stas-auth-gateway/lib/request-source.js`

## Правило сопровождения

Этот bridge нельзя менять только на production.

Если в production правился Claude/GPT OAuth flow, задача не считается законченной, пока:

- код не сохранён в этом репозитории;
- изменения не закоммичены;
- изменения не запушены в GitHub;
- связанная документация в `stas.run` не обновлена.

## Что обязательно проверять после будущих изменений

1. Metadata:
   - `/.well-known/oauth-authorization-server`
   - наличие `registration_endpoint`

2. DCR:
   - `POST /gw/oauth/register`

3. OAuth:
   - `GET /gw/oauth/authorize`
   - `GET /gw/oauth/callback`
   - `POST /gw/oauth/token`
   - для GPT Intervals authorize URL должен содержать `redirect_uri=https://intervals.stas.run/gw/oauth/callback`, а не ChatGPT callback

4. Sync в STAS:
   - `resolveDirectIntervalsAuth(...)`
   - `ensure-intervals-user`

5. Проброс источника:
   - `x-stas-source: claude`

## Что является source of truth

Для bridge-части Claude source of truth:

1. этот файл
2. `routes/oauth.js`
3. `server.js`
4. `lib/request-auth.js`
5. `lib/request-source.js`
