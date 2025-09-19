// Финальный прокси с правильным порядком middleware
const fetch = require('node-fetch');
const jwt = require('jsonwebtoken');

function setupProxyRoutes(app) {
  // Middleware для проверки токена и извлечения user_id
  function authenticateTokenMiddleware(req, res, next) {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];

    console.log('Auth middleware: checking token', !!token);

    if (!token) {
      console.log('Auth middleware: no token provided');
      return res.status(401).json({ error: 'Access token required' });
    }

    try {
      const payload = jwt.verify(token, process.env.JWT_SECRET || 'your-jwt-secret');
      req.auth = payload;
      req.uid = payload.sub; // user_id из токена
      console.log('Auth middleware: token valid, user_id:', req.uid);
      next();
    } catch (err) {
      console.error('Token verification failed:', err.message);
      return res.status(403).json({ error: 'Invalid token' });
    }
  }

  // Прокси /api/* на stas-db-bridge с user_id из токена
  app.use('/api', authenticateTokenMiddleware, async (req, res) => {
    try {
      const uid = req.uid;
      const apiKey = process.env.STAS_API_KEY || '7ca1e3d9d8bb76a1297a9c7d9e39d5eaf4d0d6da249440eea43bb50ff0fddf27';
      
      // Добавляем user_id к URL
      const url = new URL(`http://127.0.0.1:3336${req.originalUrl}`);
      url.searchParams.set('user_id', String(uid));
      
      console.log(`[GW PROXY] STAS: ${req.method} ${url.toString()}`);
      
      const response = await fetch(url.toString(), {
        method: req.method,
        headers: {
          'X-API-Key': apiKey,
          'Content-Type': req.headers['content-type'] || 'application/json',
          ...req.headers
        },
        body: req.method !== 'GET' ? JSON.stringify(req.body) : undefined
      });

      const data = await response.text();
      
      console.log(`[GW PROXY] STAS Response: ${response.status}`);
      
      res.status(response.status).send(data);
    } catch (error) {
      console.error('STAS proxy error:', error.message);
      res.status(500).json({ error: 'STAS proxy error', details: error.message });
    }
  });

  // Прокси /icu/* на mcp-bridge с user_id из токена
  app.use('/icu', authenticateTokenMiddleware, async (req, res) => {
    try {
      const uid = req.uid;
      const apiKey = process.env.MCP_API_KEY || 'e63ad0c93b969a864f5f16addfdad55eaabee376f1641b64';
      
      // Добавляем user_id к URL
      const url = new URL(`http://127.0.0.1:3334${req.originalUrl}`);
      url.searchParams.set('user_id', String(uid));
      
      console.log(`[GW PROXY] ICU: ${req.method} ${url.toString()}`);
      
      const response = await fetch(url.toString(), {
        method: req.method,
        headers: {
          'X-API-Key': apiKey,
          'Content-Type': req.headers['content-type'] || 'application/json',
          ...req.headers
        },
        body: req.method !== 'GET' ? JSON.stringify(req.body) : undefined
      });

      const data = await response.text();
      
      console.log(`[GW PROXY] ICU Response: ${response.status}`);
      
      res.status(response.status).send(data);
    } catch (error) {
      console.error('ICU proxy error:', error.message);
      res.status(500).json({ error: 'ICU proxy error', details: error.message });
    }
  });
}

module.exports = { setupProxyRoutes };
