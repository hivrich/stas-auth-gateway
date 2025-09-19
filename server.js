const http = require('http');

// JWT decode function
function decodeJWT(token) {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const payload = JSON.parse(Buffer.from(parts[1], 'base64').toString());
    return payload;
  } catch (e) {
    return null;
  }
}

// Auth middleware
function requireAuth(req, res) {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Bearer ')) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'unauthorized' }));
    return null;
  }
  
  const token = auth.slice(7);
  const payload = decodeJWT(token);
  if (!payload || !payload.sub) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'unauthorized' }));
    return null;
  }
  
  return { 
    user_id: payload.sub, 
    athlete_id: payload.athlete_id || null,
    api_key: payload.api_key || null 
  };
}

const server = http.createServer((req, res) => {
  console.log('Request:', req.method, req.url);
  res.setHeader('Content-Type', 'application/json');
  
  // /gw/api/me - диагностика токена
  if (req.url === '/gw/api/me') {
    const auth = requireAuth(req, res);
    if (!auth) return;
    
    res.writeHead(200);
    res.end(JSON.stringify({ 
      user_id: auth.user_id, 
      athlete_id: auth.athlete_id || 'i297087' 
    }));
    return;
  }
  
  // /gw/oauth/authorize - OAuth authorization endpoint
  if (req.url.startsWith('/gw/oauth/authorize')) {
    console.log('OAuth authorize request');
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(`
      <html>
        <body>
          <h1>STAS OAuth Authorization</h1>
          <p>Click to authorize GPT Actions:</p>
          <a href="/gw/oauth/token?code=test-code-123">Authorize</a>
        </body>
      </html>
    `);
    return;
  }
  
  // /gw/oauth/token - OAuth token endpoint
  if (req.url.startsWith('/gw/oauth/token')) {
    console.log('OAuth token request');
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      access_token: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiI5NTE5MjAzOSIsImF0aGxldGVfaWQiOiJpMjk3MDg3Iiwic2NvcGUiOiJyZWFkIiwiaWF0IjoxNzU4MjQyNjMwLCJleHAiOjE3NTgyNDI2MzF9.test-signature',
      token_type: 'Bearer',
      expires_in: 3600
    }));
    return;
  }
  
  // /api/db/user_summary - STAS прокси
  if (req.url.startsWith('/api/db/user_summary')) {
    const auth = requireAuth(req, res);
    if (!auth) return;
    
    res.writeHead(200);
    res.end(JSON.stringify({ 
      ok: true, 
      user_id: auth.user_id,
      user_summary: { 
        goals: 'Test goals', 
        total_workouts: 42,
        total_distance: 245.5
      } 
    }));
    return;
  }
  
  // /api/db/trainings - STAS прокси
  if (req.url.startsWith('/api/db/trainings')) {
    const auth = requireAuth(req, res);
    if (!auth) return;
    
    res.writeHead(200);
    res.end(JSON.stringify({ 
      ok: true,
      trainings: [
        { id: 1, name: 'Morning Run', date: '2024-01-01', distance: 10.5, duration: 3600 },
        { id: 2, name: 'Interval Training', date: '2024-01-02', distance: 8.2, duration: 2400 }
      ]
    }));
    return;
  }
  
  // /icu/events - ICU прокси
  if (req.url.startsWith('/icu/events')) {
    const auth = requireAuth(req, res);
    if (!auth) return;
    
    res.writeHead(200);
    res.end(JSON.stringify([
      { 
        id: 'test-event-1', 
        name: 'Long Run', 
        start_date: '2024-01-01T10:00:00Z',
        type: 'RUN',
        planned_distance: 20.0,
        planned_duration: 7200
      },
      {
        id: 'test-event-2',
        name: 'Intervals',
        start_date: '2024-01-03T14:00:00Z', 
        type: 'RUN',
        planned_distance: 8.0,
        planned_duration: 3600
      }
    ]));
    return;
  }
  
  // Default response
  res.writeHead(200);
  res.end(JSON.stringify({ ok: true, url: req.url }));
});

server.listen(3338, '127.0.0.1', () => {
  console.log('Server listening on 127.0.0.1:3338');
});
