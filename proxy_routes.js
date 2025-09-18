// Финальный прокси с правильным порядком middleware
const fetch = require('node-fetch');

function setupProxyRoutes(app) {
  // Прокси /api/* на stas-db-bridge (без аутентификации для совместимости)
  app.use('/api', async (req, res) => {
    try {
      const apiKey = process.env.STAS_API_KEY || '7ca1e3d9d8bb76a1297a9c7d9e39d5eaf4d0d6da249440eea43bb50ff0fddf27';
      const targetUrl = `http://127.0.0.1:3336${req.originalUrl}`;
      
      console.error(`[GW PROXY] STAS: ${req.method} ${req.originalUrl} -> ${targetUrl}`);
      
      const response = await fetch(targetUrl, {
        method: req.method,
        headers: {
          'X-API-Key': apiKey,
          'Content-Type': req.headers['content-type'] || 'application/json',
          ...req.headers
        },
        body: req.method !== 'GET' ? JSON.stringify(req.body) : undefined
      });

      const data = await response.text();
      
      console.error(`[GW PROXY] STAS Response: ${response.status}`);
      
      res.status(response.status).send(data);
    } catch (error) {
      console.error('[GW PROXY] STAS Error:', error.message);
      res.status(500).json({ error: 'STAS proxy error', details: error.message });
    }
  });

  // Прокси /icu/* на mcp-bridge (без аутентификации для совместимости)
  app.use('/icu', async (req, res) => {
    try {
      const apiKey = process.env.MCP_API_KEY || 'e63ad0c93b969a864f5f16addfdad55eaabee376f1641b64';
      const targetUrl = `http://127.0.0.1:3334${req.originalUrl}`;
      
      console.error(`[GW PROXY] ICU: ${req.method} ${req.originalUrl} -> ${targetUrl}`);
      
      const response = await fetch(targetUrl, {
        method: req.method,
        headers: {
          'X-API-Key': apiKey,
          'Content-Type': req.headers['content-type'] || 'application/json',
          ...req.headers
        },
        body: req.method !== 'GET' ? JSON.stringify(req.body) : undefined
      });

      const data = await response.text();
      
      console.error(`[GW PROXY] ICU Response: ${response.status}`);
      
      res.status(response.status).send(data);
    } catch (error) {
      console.error('[GW PROXY] ICU Error:', error.message);
      res.status(500).json({ error: 'ICU proxy error', details: error.message });
    }
  });
}

module.exports = { setupProxyRoutes };
