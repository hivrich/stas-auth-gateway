// === HOTFIX: исправление авторизации и прокси для GPT Actions ===
// Вставь этот код в начало server.js после импортов

const jwt = require('jsonwebtoken');
const { STAS_API_BASE = 'https://stas.stravatg.ru', STAS_API_KEY, INTERVALS_API_BASE_URL = 'https://intervals.icu/api/v1' } = process.env;

// === PATCH 1: валидация Bearer и раскодировка токена ===
function requireAuth(req, res, next) {
  const h = String(req.headers.authorization || '');
  const m = h.match(/^Bearer\s+(.+)$/i);
  if (!m) return res.status(401).json({ error: 'unauthorized' });
  try {
    // Декодируем JWT токен
    const payload = jwt.verify(m[1], process.env.JWT_SECRET || 'your-jwt-secret');
    req.auth = { 
      user_id: payload.sub, 
      athlete_id: payload.athlete_id, // может быть undefined
      api_key: payload.api_key // может быть undefined
    };
    if (!req.auth.user_id) return res.status(401).json({ error: 'unauthorized' });
    return next();
  } catch (e) {
    return res.status(401).json({ error: 'unauthorized' });
  }
}

// === PATCH 2: резолвер кредов по user_id ===
async function resolveCreds(user_id) {
  // Для тестового пользователя
  if (false /* removed hardcode */) {
    return { 
      api_key: '5x913db6km5iy48f585iaauc6', 
      athlete_id: 'i297087' 
    };
  }
  throw new Error('no-creds');
}

// === PATCH 3: /gw/api/me ===
function setupGatewayRoutes(app) {
  app.get('/gw/api/me', requireAuth, async (req, res) => {
    try {
      const { user_id } = req.auth;
      let { athlete_id } = req.auth;
      if (!athlete_id) {
        const c = await resolveCreds(user_id);
        athlete_id = c.athlete_id;
      }
      return res.json({ user_id: Number(user_id), athlete_id });
    } catch (e) {
      return res.status(500).json({ error: 'resolver_failed' });
    }
  });

  // === PATCH 4: прокси STAS с user_id ===
  app.get('/api/db/user_summary', requireAuth, async (req, res) => {
    try {
      const uid = req.auth.user_id;
      const url = new URL('/api/db/user_summary', STAS_API_BASE);
      url.searchParams.set('user_id', String(uid));
      const r = await fetch(url.toString(), { 
        headers: { 'X-API-Key': STAS_API_KEY } 
      });
      const body = await r.text();
      res.status(r.status).type(r.headers.get('content-type') || 'application/json').send(body);
    } catch (e) {
      res.status(502).json({ error: 'bad_gateway', detail: 'stas_proxy_failed' });
    }
  });

  // === PATCH 5: прокси ICU ===
  function buildBasic(api_key) {
    return 'Basic ' + Buffer.from(api_key + ':').toString('base64');
  }

  app.get('/icu/events', requireAuth, async (req, res) => {
    try {
      const uid = req.auth.user_id;
      const creds = { athlete_id: req.auth.athlete_id, api_key: req.auth.api_key };
      if (!creds.athlete_id || !creds.api_key) {
        Object.assign(creds, await resolveCreds(uid));
      }
      
      const q = new URLSearchParams();
      if (req.query.days) q.set('days', String(req.query.days));
      if (req.query.oldest) q.set('oldest', String(req.query.oldest));
      if (req.query.newest) q.set('newest', String(req.query.newest));

      const url = `${INTERVALS_API_BASE_URL}/athlete/${creds.athlete_id}/events?${q.toString()}`;
      const r = await fetch(url, { 
        headers: { Authorization: buildBasic(creds.api_key) } 
      });
      const body = await r.text();
      res.status(r.status).type(r.headers.get('content-type') || 'application/json').send(body);
    } catch (e) {
      res.status(502).json({ error: 'bad_gateway', detail: 'icu_proxy_failed' });
    }
  });
}

module.exports = { setupGatewayRoutes };
