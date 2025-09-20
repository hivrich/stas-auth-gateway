# STAS Auth Gateway

OAuth2 gateway for STAS training data with Intervals.icu integration.

## Features

- OAuth2 Authorization Code flow
- STAS DB Bridge integration
- Intervals.icu API proxy
- OpenAPI specification
- Nginx reverse proxy
- Production-ready deployment

## Endpoints

### OAuth2
- \`GET /gw/oauth/authorize\` - Authorization endpoint
- \`POST /gw/oauth/token\` - Token exchange

### STAS API
- \`GET /gw/api/db/trainings\` - Training data
- \`GET /gw/api/db/user_summary\` - User summary

### ICU API
- \`GET /gw/icu/events\` - Training plans

### System
- \`GET /gw/healthz\` - Health check
- \`GET /.well-known/openapi.json\` - OpenAPI spec

## Setup

1. Install dependencies: \`npm install\`
2. Start server: \`node server.js\`
3. Configure Nginx reverse proxy

## Environment

- Port: 3337
- OAuth Client: chatgpt-actions
- Scopes: read:workouts, read:summary, training:read, training:write

## Deployment

Production deployment with systemd and Nginx configured.
