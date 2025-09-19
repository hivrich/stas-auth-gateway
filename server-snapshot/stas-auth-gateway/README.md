# STAS Auth Gateway

OAuth-protected gateway API for STAS DB and Intervals.icu integration with GPT Actions.

## Architecture

- **JWT-based authentication**: user_id and athlete_id extracted from OAuth tokens
- **No client-side user_id**: Server handles user identification internally  
- **OAuth 2.0 flow**: Authorization Code Grant for GPT Actions integration
- **Proxy endpoints**: STAS DB and Intervals.icu API access

## API Endpoints

### OAuth
- `GET /gw/oauth/authorize` - OAuth authorization page
- `POST /gw/oauth/token` - OAuth token exchange

### Diagnostics
- `GET /gw/api/me` - Get current user identity from JWT token

### STAS DB
- `GET /api/db/user_summary` - Get user training summary
- `GET /api/db/trainings` - Get user training sessions

### Intervals.icu
- `GET /icu/events` - Get planned workouts

## Deployment

### Prerequisites
- Node.js >= 18.0.0
- Nginx for reverse proxy
- systemd for service management

### Server Setup
```bash
# Install dependencies
npm install

# Start server
npm start
```

### Nginx Configuration
```nginx
server {
    listen 443 ssl http2;
    server_name intervals.stas.run;
    
    # SSL certificates...
    
    # OAuth endpoints
    location ^~ /gw/ {
        proxy_pass http://127.0.0.1:3338;
        # proxy headers...
    }
    
    # API endpoints  
    location / {
        proxy_pass http://127.0.0.1:3338;
        # proxy headers...
    }
}
```

### systemd Service
```ini
[Unit]
Description=STAS Auth Gateway
After=network.target

[Service]
WorkingDirectory=/root
ExecStart=/usr/bin/node /root/server.js
User=root
Group=root
Restart=always

[Install]
WantedBy=multi-user.target
```

## GPT Actions Setup

1. **API Schema**: Use `final_oauth_schema.json`
2. **OAuth Settings**:
   - Client ID: `chatgpt-actions`
   - Client Secret: `chatgpt-actions-secret-2024`
   - Authorization URL: `https://intervals.stas.run/gw/oauth/authorize`
   - Token URL: `https://intervals.stas.run/gw/oauth/token`

## Testing

```bash
# Test OAuth
curl https://intervals.stas.run/gw/oauth/authorize

# Test API with token
curl -H "Authorization: Bearer <token>" \
     https://intervals.stas.run/gw/api/me
```

## Security

- JWT tokens contain user_id, athlete_id
- Bearer token validation on all endpoints
- No sensitive data exposed to clients
- Server-side credential management

## Error Handling

- `401 unauthorized` - Invalid/missing token
- `404` - User not found in STAS
- `502` - Upstream API errors
- `400` - Invalid request parameters
