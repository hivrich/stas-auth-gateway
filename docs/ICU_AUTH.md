Intervals.icu Basic Auth in Gateway
===================================

Requirement:
Use HTTP Basic auth with username = API_KEY and password = <icu_api_key> when proxying to Intervals.icu.

Direct test example:
  curl -u "API_KEY:<icu_api_key>" "https://intervals.icu/api/v1/athlete/<athlete_id>/events?oldest=YYYY-MM-DD&newest=YYYY-MM-DD"

Gateway path:
  GET /gw/icu/events?user_id=<uid>&oldest=YYYY-MM-DD&newest=YYYY-MM-DD

Notes:
  - Creds source: STAS gw_user_creds (user_id -> icu_api_key, icu_athlete_id)
  - Proxy builds header: Authorization: Basic base64("API_KEY:<key>")
  - Uses Node global fetch (Node 18+)
  - Logs mask the api key (prefix only)

Troubleshooting:
  - If direct ICU returns 200 but gateway returns 403 — ensure gateway uses API_KEY:<key> (not <key>:<key>)
  - Verify creds endpoint:
      curl -H "X-API-Key: <stas_key>" "http://127.0.0.1:3336/api/db/icu_creds?user_id=<uid>"

Quick self-test:
  gw-icu-selftest 95192039
