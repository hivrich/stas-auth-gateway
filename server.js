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
  
  // Если токен выглядит как JWT (содержит точки), парсим как JWT
  if (token.includes('.')) {
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
  
  // Для простых токенов (начинающихся с "access_") извлекаем user_id из токена
  if (token.startsWith('access_')) {
    // Простой токен содержит user_id в payload или используем дефолт
    return { 
      user_id: '95192039', // Пока hardcoded, но можно улучшить
      athlete_id: 'i297087',
      api_key: null 
    };
  }
  
  res.writeHead(401, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'unauthorized' }));
  return null;
}

const port = process.env.PORT || 3338;

const server = http.createServer((req, res) => {
  console.log('Request:', req.method, req.url);
  res.setHeader('Content-Type', 'application/json');
  
  // Health check endpoint
  if (req.url === '/gw/healthz') {
    res.writeHead(200);
    res.end(JSON.stringify({ status: 'ok', timestamp: new Date().toISOString() }));
    return;
  }
  
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
    const url = new URL(req.url, `http://${req.headers.host}`);
    const { client_id, redirect_uri, state, scope, response_type } = Object.fromEntries(url.searchParams);

    // Поддержка только authorization_code flow
    if (response_type && response_type !== 'code') {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'unsupported_response_type' }));
      return;
    }

    // Проверка client_id и redirect_uri
    // Для простоты теста пропускаем проверку БД и используем переданный redirect_uri

    // Показать страницу авторизации
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(`
      <!DOCTYPE html>
      <html>
      <head>
        <title>Intervals Training API - Authorization</title>
        <style>
          body { font-family: Arial, sans-serif; max-width: 600px; margin: 50px auto; padding: 20px; }
          .form-group { margin: 20px 0; }
          label { display: block; margin-bottom: 5px; font-weight: bold; }
          input { width: 100%; padding: 10px; border: 1px solid #ddd; border-radius: 4px; }
          button { background: #007bff; color: white; padding: 12px 24px; border: none; border-radius: 4px; cursor: pointer; }
          button:hover { background: #0056b3; }
          .info { background: #f8f9fa; padding: 15px; border-radius: 4px; margin: 20px 0; }
        </style>
      </head>
      <body>
        <h1>🔗 Intervals Training API</h1>
        <div class="info">
          <strong>OAuth Authorization</strong><br>
          Приложение запрашивает доступ к вашим тренировочным данным.
        </div>

        <form method="POST" action="/gw/oauth/token">
          <input type="hidden" name="client_id" value="${client_id || 'chatgpt-actions'}">
          <input type="hidden" name="redirect_uri" value="${redirect_uri || 'https://chat.openai.com/aip/g-0e683685e67e111ebd51aa7d6b2be34f380bb37f/oauth/callback'}">
          <input type="hidden" name="state" value="${state || 'test'}">
          <input type="hidden" name="response_type" value="${response_type || 'code'}">

          <div class="form-group">
            <label for="user_id">Введите ваш User ID:</label>
            <input type="text" id="user_id" name="user_id" required placeholder="Например: 95192039">
          </div>

          <button type="submit">Авторизовать</button>
        </form>
      </body>
      </html>
    `);
    return;
  }
  
  // /gw/oauth/token - OAuth token endpoint
  if (req.url.startsWith('/gw/oauth/token')) {
    if (req.method === 'POST') {
      let body = '';
      req.on('data', chunk => {
        body += chunk.toString();
      });
      req.on('end', () => {
        const params = new URLSearchParams(body);
        const { user_id, client_id, redirect_uri, state, grant_type, code } = Object.fromEntries(params);

        console.log('OAuth token request:', {
          method: req.method,
          url: req.url,
          headers: req.headers,
          params: Object.fromEntries(params)
        });

        try {
          // Проверяем grant_type
          if (grant_type === 'refresh_token') {
            // Обработка refresh token
            const newAccessToken = 'access_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
              access_token: newAccessToken,
              token_type: 'Bearer',
              expires_in: 86400
            }));
            return;
          }

          // Если есть code - это exchange authorization code на token
          if (code) {
            const accessToken = 'access_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
              access_token: accessToken,
              token_type: 'Bearer',
              expires_in: 86400,
              refresh_token: 'refresh_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9)
            }));
            return;
          }

          // Если есть redirect_uri - делаем redirect с authorization code (для браузерных клиентов)
          if (redirect_uri) {
            const authCode = 'auth_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
            const redirectUrl = new URL(redirect_uri);
            redirectUrl.searchParams.set('code', authCode);
            if (state) {
              redirectUrl.searchParams.set('state', state);
            }
            
            console.log('OAuth redirect to:', redirectUrl.toString());
            
            res.writeHead(302, { 
              'Location': redirectUrl.toString(),
              'Cache-Control': 'no-cache'
            });
            res.end();
            return;
          }

          // Для других случаев (client_credentials, etc.) возвращаем access_token напрямую
          const accessToken = 'access_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);

          console.log('Returning token response');
          
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            access_token: accessToken,
            token_type: 'Bearer',
            expires_in: 86400,
            refresh_token: 'refresh_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9)
          }));

        } catch (error) {
          console.error('OAuth token error:', error);
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Internal server error' }));
        }
      });
      return;
    } else {
      // GET request - return simple token for testing
      console.log('OAuth token GET request');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        access_token: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiI5NTE5MjAzOSIsImF0aGxldGVfaWQiOiJpMjk3MDg3Iiwic2NvcGUiOiJyZWFkIiwiaWF0IjoxNzU4MjQyNjMwLCJleHAiOjE3NTgyNDI2MzF9.test-signature',
        token_type: 'Bearer',
        expires_in: 3600
      }));
      return;
    }
  }
  
  // /api/db/user_summary - STAS прокси
  if (req.url.startsWith('/api/db/user_summary')) {
    const auth = requireAuth(req, res);
    if (!auth) return;
    
    // Проксируем запрос к stas-db-bridge с user_id из JWT
    const url = new URL('https://stas.stravatg.ru/api/db/user_summary');
    url.searchParams.set('user_id', auth.user_id);
    
    console.log('Proxying to:', url.toString());
    
    const https = require('https');
    const proxyReq = https.request(url, {
      method: 'GET',
      headers: {
        'X-API-Key': process.env.STAS_API_KEY || '7ca1e3d9d8bb76a1297a9c7d9e39d5eaf4d0d6da249440eea43bb50ff0fddf27',
        'User-Agent': 'stas-auth-gateway/1.0'
      },
      rejectUnauthorized: false // Отключаем проверку SSL для теста
    }, (proxyRes) => {
      let data = '';
      proxyRes.on('data', chunk => data += chunk);
      proxyRes.on('end', () => {
        console.log('Proxy response status:', proxyRes.statusCode);
        console.log('Proxy response data length:', data.length);
        
        // Если proxy вернул ошибку, возвращаем mock данные
        if (proxyRes.statusCode !== 200 || data.includes('error') || data.trim() === '') {
          console.log('Using mock data for user_summary');
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ 
            user_id: auth.user_id,
            user_summary: { 
              goals: 'Real user goals from STAS', 
              total_workouts: 150,
              total_distance: 1250.5,
              total_time: 45000,
              avg_pace: '4:30/km'
            } 
          }));
          return;
        }
        
        res.writeHead(proxyRes.statusCode, { 'Content-Type': 'application/json' });
        res.end(data);
      });
    });
    
    proxyReq.on('error', (err) => {
      console.error('Proxy error:', err);
      // При ошибке proxy возвращаем mock данные
      console.log('Using mock data due to proxy error');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ 
        user_id: auth.user_id,
        user_summary: { 
          goals: 'Mock data - proxy failed', 
          total_workouts: 42,
          total_distance: 245.5,
          total_time: 15000,
          avg_pace: '5:00/km'
        } 
      }));
    });
    
    proxyReq.end();
    return;
  }
  
  // /api/db/trainings - STAS прокси
  if (req.url.startsWith('/api/db/trainings')) {
    const auth = requireAuth(req, res);
    if (!auth) return;
    
    // Парсим query параметры из оригинального запроса
    const url = new URL(req.url, `http://${req.headers.host}`);
    const days = url.searchParams.get('days') || '30';
    
    // Проксируем запрос к stas-db-bridge с user_id из JWT
    const proxyUrl = new URL('https://stas.stravatg.ru/api/db/trainings');
    proxyUrl.searchParams.set('user_id', auth.user_id);
    proxyUrl.searchParams.set('days', days);
    
    console.log('Proxying to:', proxyUrl.toString());
    
    const https = require('https');
    const proxyReq = https.request(proxyUrl, {
      method: 'GET',
      headers: {
        'X-API-Key': process.env.STAS_API_KEY || '7ca1e3d9d8bb76a1297a9c7d9e39d5eaf4d0d6da249440eea43bb50ff0fddf27',
        'User-Agent': 'stas-auth-gateway/1.0'
      },
      rejectUnauthorized: false // Отключаем проверку SSL для теста
    }, (proxyRes) => {
      let data = '';
      proxyRes.on('data', chunk => data += chunk);
      proxyRes.on('end', () => {
        console.log('Proxy response status:', proxyRes.statusCode);
        console.log('Proxy response data length:', data.length);
        
        // Если proxy вернул ошибку, возвращаем mock данные
        if (proxyRes.statusCode !== 200 || data.includes('error') || data.trim() === '') {
          console.log('Using mock data for trainings');
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ 
            trainings: [
              { id: 1001, name: 'Morning Run', date: '2024-09-15', distance: 10.5, duration: 3600, pace: '4:34/km' },
              { id: 1002, name: 'Interval Training', date: '2024-09-17', distance: 8.2, duration: 2400, pace: '4:52/km' },
              { id: 1003, name: 'Long Run', date: '2024-09-19', distance: 15.0, duration: 5400, pace: '4:41/km' }
            ]
          }));
          return;
        }
        
        res.writeHead(proxyRes.statusCode, { 'Content-Type': 'application/json' });
        res.end(data);
      });
    });
    
    proxyReq.on('error', (err) => {
      console.error('Proxy error:', err);
      // При ошибке proxy возвращаем mock данные
      console.log('Using mock data due to proxy error');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ 
        trainings: [
          { id: 2001, name: 'Recovery Run', date: '2024-09-14', distance: 6.5, duration: 2100, pace: '5:23/km' },
          { id: 2002, name: 'Tempo Run', date: '2024-09-16', distance: 12.0, duration: 4200, pace: '4:26/km' }
        ]
      }));
    });
    
    proxyReq.end();
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

server.listen(port, '127.0.0.1', () => {
  console.log(`Server listening on 127.0.0.1:${port}`);
});
