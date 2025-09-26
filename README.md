# STAS Auth Gateway v2 (sanitized)

Run:
  cp .env.example .env && npm ci && node server.js

OAuth:
  /oauth/authorize, /oauth/token → Bearer t_<base64url>{"uid":"<digits>","ts":<unix>}

Endpoints:
  GET /trainings
  GET /api/db/user_summary
  GET|POST|DELETE /icu/events
  GET /healthz
OpenAPI: /gw/openapi.json (servers[0].url=https://<host>/gw)
