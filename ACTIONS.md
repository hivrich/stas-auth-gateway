# ChatGPT Actions wiring

OpenAPI URL:
  https://intervals.stas.run/gw/openapi.json

Auth: OAuth 2 (Authorization Code)
  Authorization URL: https://intervals.stas.run/gw/oauth/authorize
  Token URL:         https://intervals.stas.run/gw/oauth/token
  Scopes:            read:me icu workouts:write
Access Token format:
  Bearer t_<base64url>{"uid":"<digits>","ts":<unix>}
Endpoints used by the Action:
  GET /trainings
  GET /api/db/user_summary
  GET /icu/events
  POST /icu/events?dry_run=true
  DELETE /icu/events?dry_run=true
