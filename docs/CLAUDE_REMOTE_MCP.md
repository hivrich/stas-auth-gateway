# Remote MCP OAuth in bridge

Статус контракта на `2026-09-01`: универсальная регистрация подготовлена в
source; production не меняется до отдельного deploy.

Этот файл фиксирует bridge-часть OAuth для удалённых MCP-клиентов. Старый
Claude client остаётся совместимым, но новые регистрации больше не привязаны к
Claude.

## Зачем это нужно

Совместимый удалённый MCP-клиент подключает STAS по URL:

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

- `POST /oauth/register` для универсальной Dynamic Client Registration;
- выдачу отдельного подписанного `client_id`, привязанного к точным callback;
- `GET /oauth/authorize` для проверки PKCE и показа экрана согласия;
- `POST /oauth/authorize` для подтверждённого редиректа в Intervals OAuth;
- `GET /oauth/callback` как общий callback от Intervals обратно в bridge;
- `POST /oauth/token` для обмена кода на токен;
- автоматическую подстановку серверных `INTERVALS_CLIENT_ID` и `INTERVALS_CLIENT_SECRET` для MCP-клиентов;
- автоматическую подстановку серверного `INTERVALS_CLIENT_ID` для GPT, если ChatGPT присылает пустой `client_id`;
- bridge-code flow для GPT: ChatGPT callback хранится в подписанном `state`, Intervals получает только `https://intervals.stas.run/gw/oauth/callback`, а bridge затем возвращает ChatGPT код вида `gpt_...`;
- обмен временного Intervals token на собственные короткоживущие STAS access/refresh tokens;
- локальную проверку, обновление и отзыв STAS-токенов без повторных запросов в Intervals.

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
- различение собственного MCP token, legacy STAS token и прямого Intervals token;
- запрос в `https://intervals.icu/api/v1/athlete/0`;
- вызов `POST ${STAS_BASE}/api/db/ensure-intervals-user`;
- кэширование распознанных direct Intervals token.

### `lib/request-source.js`

Отвечает за:

- различение источника `gpt | claude | mcp`;
- распознавание Claude по `client_id` и `redirect_uri`;
- проброс `x-stas-source` в STAS.

## Как проходит универсальный Remote MCP flow

1. Клиент добавляет MCP server `https://stas.run/api/mcp`.
2. При первом защищённом вызове STAS отвечает `401` и отдаёт `resource_metadata`.
3. Claude читает bridge metadata:
   - `/.well-known/oauth-authorization-server`
4. Клиент делает DCR:
   - `POST /gw/oauth/register`
5. Bridge выдаёт отдельный подписанный public `client_id`, связанный с точными
   `https` callback клиента.
6. Клиент вызывает:
   - `GET /gw/oauth/authorize`
7. Bridge проверяет `client_id`, точное совпадение callback и PKCE `S256`, затем
   показывает пользователю название и домен клиента.
8. Только после явного подтверждения bridge отправляет пользователя в Intervals OAuth.
9. После callback клиент вызывает:
   - `POST /gw/oauth/token`
10. Bridge повторно связывает code, `client_id`, callback и PKCE verifier.
11. Bridge получает Intervals access token и вызывает `resolveDirectIntervalsAuth(...)`.
12. Bridge синхронизирует пользователя в STAS через `ensure-intervals-user`.
13. Bridge выдаёт клиенту собственный STAS token, связанный с клиентом, ресурсом
    `https://stas.run/api/mcp` и выбранными правами. Intervals token остаётся
    только внутри STAS.
14. Дальнейшие MCP-запросы и обновление токена проверяются локально; повторного
    запроса в Intervals для проверки пользователя нет.

Также поддерживается Client ID Metadata Document: вместо DCR клиент может дать
HTTPS URL своего metadata-документа как `client_id`. Bridge загружает документ
без редиректов, только с публичного DNS-адреса, с ограничением времени и размера.

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

## Что важно для универсальной регистрации

- ручной `client_secret` от пользователя не нужен;
- `token_endpoint_auth_method` для DCR клиента = `none`;
- поддерживаются remote web и native clients с `authorization_code`, optional
  `refresh_token` и PKCE `S256`; loopback callback native-клиента может менять порт;
- web callback и claimed HTTPS callback native-клиента обязаны использовать
  публичный `https`; native loopback callback может использовать `http` на
  `127.0.0.0/8` или `::1` с динамическим портом;
- hostname `localhost`, private non-loopback адреса, логин, пароль и fragment в
  callback не допускаются;
- один client получает не более трёх callback, каждый не длиннее 512 символов;
- signed `client_id` переживает restart и не требует отдельной таблицы;
- пользователь видит client name и callback hostname до перехода в Intervals;
- legacy `claude-public-client` продолжает работать для старых подключений;
- ChatGPT Actions flow остаётся отдельным и не меняется.

Perplexity использует callback:

- `https://www.perplexity.ai/rest/connections/oauth_callback`

Любой другой remote MCP client проходит тот же общий путь без отдельного
исключения по названию продукта.

## Что важно для STAS

Bridge обязан пробрасывать источник новых универсальных MCP-подключений:

- `x-stas-source: mcp`

Это нужно, чтобы:

- не трогать GPT-метрики;
- писать общие MCP-события независимо от названия клиента;
- не обновлять `gptConnectedAt`.

## Живые признаки, что всё работает

В логах bridge должны появляться:

- `[oauth][register]`
- `[oauth][authorize]`
- `[oauth][token][request]`
- `[db_proxy][REQ]`
- `[db_proxy][RES]`

Логи содержат только хеш client id/name, домен callback и форму запроса. Коды,
токены, PKCE verifier, state, секреты и произвольные поля клиента не пишутся.

## Секреты и ротация

Для MCP access/refresh tokens ключ выбирается по порядку:
`MCP_OAUTH_TOKEN_SECRET`, затем `OAUTH_STATE_SECRET`, затем стабильный
`INTERVALS_CLIENT_SECRET`. Для production подходит только непустое значение
длиной от 32 символов без placeholder-маркеров. Отдельный
`MCP_OAUTH_TOKEN_SECRET` предпочтительнее, но fallback сохраняет совместимость
текущего production-конфига.

OAuth state и подписанные DCR client ids используют `OAUTH_STATE_SECRET`, а при
его отсутствии — `INTERVALS_CLIENT_SECRET`; `MCP_OAUTH_TOKEN_SECRET` на них не
влияет. Поэтому ротация отдельного `MCP_OAUTH_TOKEN_SECRET` инвалидирует только
MCP access/refresh tokens. Ротация `OAUTH_STATE_SECRET` также инвалидирует их,
только если он одновременно служит fallback для MCP-токенов, и всегда
инвалидирует незавершённый OAuth state и ранее выданные подписанные DCR client
ids. Ротация `INTERVALS_CLIENT_SECRET` имеет эти дополнительные последствия
только там, где отдельные секреты не заданы. Любую такую ротацию нужно проводить
как запланированное переподключение затронутых клиентов.

## Стоимость запросов к Intervals

- первое подключение: один token exchange и один запрос профиля спортсмена;
- обычная проверка STAS bearer, refresh и revoke: ноль запросов к Intervals;
- повторное использование OAuth code или refresh token отклоняется локально и
  не повторяет уже завершённый обмен.

Развёртывать нужно gateway первым. После него STAS discovery зеркалирует только
те возможности (refresh, CIMD и `iss`), которые уже подтвердил живой gateway;
при недоступном или старом gateway расширенные возможности не рекламируются.

## Production paths

Активный production для `intervals.stas.run` сейчас работает через Docker compose:

- compose project: `/opt/stas/docker-compose.yml`
- service: `bridge-api`
- container: `stas-bridge-api-1`
- source directory: `/opt/stas/bridge-api`

Основные gateway-файлы на активном production:

- `/opt/stas/bridge-api/routes/oauth.js`
- `/opt/stas/bridge-api/server.js`
- `/opt/stas/bridge-api/lib/request-auth.js`
- `/opt/stas/bridge-api/lib/request-source.js`
- `/opt/stas/bridge-api/openapi.actions.json`
- `/opt/stas/bridge-api/openapi.min.json`

Старый checkout `/opt/stas-auth-gateway` не является активным runtime, если запущен Docker-контейнер `stas-bridge-api-1`.
На 2026-06-16 он отключен переименованием в `/opt/stas-auth-gateway.legacy-disabled-20260616T213939Z`.

## Правило сопровождения

Этот bridge нельзя менять только на production.

Если в production правился MCP/GPT OAuth flow, задача не считается законченной, пока:

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
   - unique signed `client_id`
   - reject HTTP, localhost/private IP, credentials, fragments and unsupported auth methods

3. OAuth:
   - `GET /gw/oauth/authorize`
   - consent screen before Intervals for dynamically registered MCP clients
   - `GET /gw/oauth/callback`
   - `POST /gw/oauth/token`
   - exact client/callback binding and PKCE replay/mismatch rejection
   - `POST /gw/oauth/revoke`
   - для GPT Intervals authorize URL должен содержать `redirect_uri=https://intervals.stas.run/gw/oauth/callback`, а не ChatGPT callback

4. Sync в STAS:
   - `resolveDirectIntervalsAuth(...)`
   - `ensure-intervals-user`

5. Проброс источника:
   - `x-stas-source: claude`

## Что является source of truth

Для bridge-части Remote MCP OAuth source of truth:

1. этот файл
2. `routes/oauth.js`
3. `server.js`
4. `lib/request-auth.js`
5. `lib/request-source.js`
