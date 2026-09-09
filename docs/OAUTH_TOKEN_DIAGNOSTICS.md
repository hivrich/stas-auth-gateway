# OAuth token stage diagnostics

Incident context: accepting CIMD metadata and redirecting an Intervals callback
does not prove that the downstream client posted to the token endpoint. The old
`[oauth][token][request]` event ran only after grant and client authentication,
so its absence could not distinguish no POST from an early rejection.

Each canonical `POST /gw/oauth/token` now emits:

- `[oauth][token][ingress]` before global rate limiting and body parsing;
- exactly one `[oauth][token][outcome]` on response finish or connection close.

Correlate these two events by their **server-generated random `request_id`**,
not by client-supplied IDs or credentials. The ID is not returned to clients and
is not shared across retries, callbacks or refreshes. Ask for one fresh attempt
and its approximate time; inspect a short log window. A safe callback-complete
event reports only code/state/issuer presence and a fixed destination category,
not a correlation derived from the code/state. Concurrent attempts may therefore
not be attributable to a specific callback or person.

No ingress in the inspected window means no canonical token POST was observed
by this gateway (or log delivery was unavailable); it does **not** establish a
client-side cause. Ingress without an outcome can mean a still-pending request,
process termination or unavailable log delivery. A normal finish or socket close
emits one outcome; process termination cannot guarantee log delivery.

## Reading an outcome

`stage` and `reason` are allowlisted categories defined in
`lib/oauth-token-diagnostics.js`. `grant` is `authorization_code`, `refresh_token`,
`agent`, `missing`, `unsupported` or `unknown`; `client_method` is a supported
authentication-method enum or `unknown`. Neither contains the submitted value.

| Stage | Meaning / representative reasons |
| --- | --- |
| ingress / parsing | Rate limit or body parser stopped the request (`rate_limited`, `body_rejected`). |
| grant / code | Missing code, unknown/expired/consumed code, unsupported grant, concurrent reservation, finalization failure. |
| client / binding | Client resolution/method/credentials/configuration or redirect/client/resource/PKCE binding failed. |
| assertion | Missing/type/malformed/algorithm/header/kid; issuer/subject/audience/time/JTI; unavailable/invalid JWKS, key selection or signature. |
| replay | Expired prepared assertion, duplicate JTI, or unavailable durable replay store. |
| upstream / issuance | Intervals rejection/network failure, user synchronization or token persistence failure. |
| agent / refresh / legacy | The existing corresponding token path rejected the request. |
| complete | `success`: the existing handler produced its success response. |

`status` is the actual HTTP status, or `0` for a prematurely closed connection;
`completion` distinguishes finish/close. Duration is bucketed (`lt_100ms`,
`lt_1s`, `lt_10s`, `gte_10s`), not an exact timing measurement. A stage indicates
the last check reached, not a new rejection policy. In particular, missing
`grant_type` remains accepted wherever the existing legacy/bridge path accepted
it. Parser errors retain their existing generic HTTP 500 response.

## Privacy and retention

The new events replace the older token request/issued/refreshed/error detail
events. They never include body/query/header values, IP, user agent, client ID,
resource/redirect URLs, state, code/verifier, assertion/header/claims, JTI or its
hash, JWK/JWKS, tokens, credentials, database URLs, upstream error text or user
identity. Token parser exceptions do not print their potentially body-bearing
stack; unrelated error logging is unchanged. A logging sink failure cannot
change authentication or the HTTP response.

Events use existing container stdout log rotation/retention. There is no new
database table, collector, timer, longer retention or additional outbound call.
Keep investigations to a short window; do not export raw access logs or expand
retention to correlate attempts. Do not enable verbose request logging. This
instrumentation alone does not fix or weaken authentication and requires the
normal review and separately authorized gateway release before production use.
