# STAS Auth Gateway — Deploy Guide (Production)

Deployment artifacts for the STAS Auth Gateway (OAuth2 + API proxy to STAS/ICU).

## Paths on server
- `/opt/stas-auth-gateway` — working copy
- `/etc/systemd/system/stas-auth-gateway.service`
- `/etc/nginx/sites-enabled/intervals.stas.run.conf`

## .env (copy from .env.example and fill values)
Create `/opt/stas-auth-gateway/.env` with:

```
PORT=3337
NODE_ENV=production
STAS_API_BASE=https://stas.stravatg.ru
STAS_API_KEY=7ca1e3d9d8bb76a1297a9c7d9e39d5eaf4d0d6da249440eea43bb50ff0fddf27
ICU_API_BASE=https://intervals.icu/api/v1
OAUTH_CLIENT_ID=chatgpt-actions
OAUTH_CLIENT_SECRET=<PASTE_NEW_OAUTH_CLIENT_SECRET>
OAUTH_REDIRECTS=https://chat.openai.com/aip/*/oauth/callback
SESSION_SECRET=<openssl rand -base64 48>
JWT_SECRET=<openssl rand -base64 48>
CORS_ORIGINS=*
DEBUG=true
```

## Systemd
```
cp /path/to/repo/stas-auth-gateway/deploy/stas-auth-gateway.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now stas-auth-gateway
```

## Nginx vhost
```
cp /path/to/repo/stas-auth-gateway/deploy/intervals.stas.run.conf /etc/nginx/sites-enabled/
nginx -t && systemctl reload nginx
```

## OAuth client (PostgreSQL)
1) Generate secrets:
```
OAUTH_CLIENT_SECRET=$(openssl rand -hex 32); echo "$OAUTH_CLIENT_SECRET"
```
2) Upsert into DB (edit `oauth_upsert.sql` accordingly):
```
psql <connection-params> -f /path/to/repo/stas-auth-gateway/deploy/oauth_upsert.sql
```
3) After you know the exact redirect URI, run update:
```
UPDATE gw_oauth_clients
SET redirect_uri = 'https://chat.openai.com/aip/<G-REAL>/oauth/callback'
WHERE client_id = 'chatgpt-actions';
```

## Smoke tests
```
curl -sS http://127.0.0.1:3337/gw/healthz
CB='https://chat.openai.com/aip/<G-REAL>/oauth/callback'
ENC_CB=$(python3 - <<'PY';import urllib.parse,sys;print(urllib.parse.quote(sys.stdin.read().strip(),safe=''));PY <<< "$CB")
curl -is "https://intervals.stas.run/gw/oauth/authorize?response_type=code&client_id=chatgpt-actions&redirect_uri=$ENC_CB&scope=read%3Ame%20icu%20workouts%3Awrite&state=test&user_id=95192039" | sed -n '1,20p'
```

## Notes
- `proxy_pass` must end with trailing slash (`...:3337/`).
- `OAUTH_REDIRECTS` supports wildcard in app, but DB must store the exact URI received from ChatGPT.
- Secrets must not be committed; only stored in `.env` on the server.
