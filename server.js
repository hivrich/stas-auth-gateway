// STAS Auth Gateway - minimal scaffold
// Endpoints:
//  - GET   /gw/healthz
//  - GET   /gw/oauth/authorize  (redirect with ?code=...&state=...)
//  - POST  /gw/oauth/token      (exchange code -> access_token)
// Note: Proxy routes to STAS/ICU can be added later.

const express = require('express');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const { Pool } = require('pg');
const fetch = require('node-fetch');
const { validateUserId } = require('./user_id_middleware');
const { setupProxyRoutes } = require('./proxy_routes');
const { setupGPTTokenEndpoint } = require('./gpt_actions_token');
const { fixOAuthTokenEndpoint } = require('./fix_oauth_for_gpt');
const { setupGatewayRoutes } = require('./gateway_patch');

const PORT = Number(process.env.PORT || 3337);
const NODE_ENV = process.env.NODE_ENV || 'production';

const STAS_API_BASE = process.env.STAS_API_BASE || 'https://stas.stravatg.ru';
const STAS_API_KEY = process.env.STAS_API_KEY || '';
const ICU_API_BASE = process.env.ICU_API_BASE || 'https://intervals.icu/api/v1';

const OAUTH_CLIENT_ID = process.env.OAUTH_CLIENT_ID || 'chatgpt-actions';
const OAUTH_CLIENT_SECRET = process.env.OAUTH_CLIENT_SECRET || '';
const OAUTH_REDIRECTS = (process.env.OAUTH_REDIRECTS || '').split(',').map(s => s.trim()).filter(Boolean);

const SESSION_SECRET = process.env.SESSION_SECRET || 'dev_session_secret_change_me';
const JWT_SECRET = process.env.JWT_SECRET || 'dev_jwt_secret_change_me';

const CORS_ORIGINS = (process.env.CORS_ORIGINS || '*').split(',').map(s => s.trim()).filter(Boolean);
const DEBUG = /^true$/i.test(process.env.DEBUG || 'false');

const ACCESS_TTL_SEC = parseInt(process.env.ACCESS_TTL_SEC || '3600', 10);
const REFRESH_TTL_SEC = parseInt(process.env.REFRESH_TTL_SEC || '2592000', 10); // 30 days

// Service URLs
const DB_BRIDGE_URL = process.env.DB_BRIDGE_URL || 'http://127.0.0.1:3336';
const MCP_BRIDGE_URL = process.env.MCP_BRIDGE_URL || 'http://127.0.0.1:3334';

const pool = new Pool({
  host: process.env.PGHOST || '94.241.141.239',
  port: Number(process.env.PGPORT || 5432),
  database: process.env.PGDATABASE || 'hivrich_db',
  user: process.env.PGUSER || 'limpid_beaker67',
  password: process.env.PGPASSWORD || 'jup64918',
  ssl: (/^true$/i).test(process.env.PGSSL || 'false') ? { rejectUnauthorized: false } : undefined,
});

const app = express();
app.use(express.json());
app.use(cors({ origin: (origin, cb) => cb(null, true), credentials: true }));

// Setup proxy routes for /api and /icu
// setupProxyRoutes(app); // ЗАКОММЕНТИРОВАЛ - используем новые маршруты

// Setup GPT Actions token endpoint
setupGPTTokenEndpoint(app);

// Fix OAuth token endpoint for GPT Actions
fixOAuthTokenEndpoint(app);

// Setup gateway routes with proper auth (ДОЛЖНЫ БЫТЬ ПЕРВЫМИ!)
setupGatewayRoutes(app);

// Тестовый маршрут для проверки (добавлен ПЕРЕД app.listen)
app.get('/test', (req, res) => {
  res.json({ ok: true, message: 'Gateway works', timestamp: new Date().toISOString() });
});

// Прямой маршрут для /gw/api/me
app.get('/gw/api/me', (req, res) => {
  const auth = req.headers.authorization;
  res.json({ 
    ok: true, 
    auth_header: auth ? 'present' : 'missing',
    user_id: 95192039, 
    athlete_id: 'i297087',
    timestamp: new Date().toISOString()
  });
});

app.listen(PORT, () => {
  console.log(`Gateway listening on 127.0.0.1:${PORT}`);
});

// Middleware for JWT authentication
function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1]; // Bearer TOKEN

  if (!token) {
    return res.status(401).json({ error: 'Access token required' });
  }

  try {
    const payload = jwt.verify(token, SESSION_SECRET);
    if (payload.typ !== 'access') {
      throw new Error('invalid_token_type');
    }
    req.user = payload;
    next();
  } catch (err) {
    log('JWT verification failed:', err.message);
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

function wildcardMatch(pattern, str) {
  // Simple wildcard match supporting a single * segment
  if (!pattern) return false;
  if (pattern === '*') return true;
  const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp('^' + esc(pattern).replace(/\\\*/g, '.*') + '$');
  return re.test(str);
}

function isRedirectAllowed(uri) {
  if (OAUTH_REDIRECTS.length === 0) return false;
  return OAUTH_REDIRECTS.some(p => wildcardMatch(p, uri));
}

async function getClientById(client_id) {
  const sql = 'select client_id, client_secret, redirect_uri from gw_oauth_clients where client_id=$1 limit 1';
  const r = await pool.query(sql, [client_id]);
  if (r.rows.length === 0) return null;
  return r.rows[0];
}

// Health check with detailed status
app.get('/gw/healthz', async (req, res) => {
  const testUserId = req.query.test_user_id ? parseInt(req.query.test_user_id) : 95192039;
  
  try {
    // Test STAS API
    let stasStatus = 'unknown';
    try {
      const stasResponse = await fetch(`${STAS_API_BASE}/api/db/user_summary?user_id=${testUserId}`, {
        headers: { 'X-API-Key': STAS_API_KEY }
      });
      stasStatus = stasResponse.status === 200 ? 'ok' : 
                   stasResponse.status === 404 ? 'user_not_found' : 'error';
    } catch (e) {
      stasStatus = 'connection_error';
    }

    // Test ICU API
    let icuStatus = 'unknown';
    try {
      const icuResponse = await fetch(`${ICU_API_BASE}/athlete/${testUserId}/events?oldest=2024-01-01`, {
        headers: { 'Authorization': `Bearer test` }
      });
      icuStatus = icuResponse.status === 200 ? 'ok' : 
                  icuResponse.status === 401 ? 'unauthorized' : 'error';
    } catch (e) {
      icuStatus = 'connection_error';
    }

    res.json({ 
      ok: true, 
      stas: !!STAS_API_BASE, 
      icu: !!ICU_API_BASE, 
      client: OAUTH_CLIENT_ID,
      services: {
        stas_api: stasStatus,
        icu_api: icuStatus
      },
      test_user_id: testUserId
    });
  } catch (err) {
    res.status(500).json({ error: 'Health check failed', details: err.message });
  }
});

// OAuth 2.0 Authorization Endpoint (Authorization Code Grant)
app.get('/gw/oauth/authorize', (req, res) => {
  const { response_type, client_id, redirect_uri, scope = '', state = '', user_id = '' } = req.query;

  if (response_type !== 'code') return res.status(400).json({ error: 'unsupported_response_type' });
  if (client_id !== OAUTH_CLIENT_ID) return res.status(401).json({ error: 'invalid_client' });
  if (!redirect_uri || !isRedirectAllowed(String(redirect_uri))) return res.status(400).json({ error: 'invalid_redirect_uri' });

  // Create short-lived authorization code as a signed JWT
  const now = Math.floor(Date.now() / 1000);
  const code = jwt.sign({
    sub: String(user_id || 'unknown'),
    aud: OAUTH_CLIENT_ID,
    scope: String(scope),
    iat: now,
    exp: now + 300, // 5 min
    typ: 'auth_code'
  }, JWT_SECRET);

  const url = new URL(String(redirect_uri));
  url.searchParams.set('code', code);
  if (state) url.searchParams.set('state', String(state));

  log('authorize ok -> redirect', url.toString());
  res.redirect(url.toString());
});

// OAuth 2.0 Token Endpoint
app.post('/gw/oauth/token', async (req, res) => {
  const { grant_type, code, redirect_uri, client_id, client_secret } = req.body || {};

  if (grant_type !== 'authorization_code') return res.status(400).json({ error: 'unsupported_grant_type' });
  if (client_id !== OAUTH_CLIENT_ID) return res.status(401).json({ error: 'invalid_client' });

  try {
    const clientRow = await getClientById(String(client_id));
    if (!clientRow) return res.status(401).json({ error: 'invalid_client' });

    // Strict checks: client_secret and redirect_uri must match DB, byte-for-byte
    if (!client_secret || client_secret !== clientRow.client_secret) {
      return res.status(401).json({ error: 'invalid_client' });
    }
    if (!redirect_uri || String(redirect_uri) !== String(clientRow.redirect_uri)) {
      return res.status(400).json({ error: 'invalid_redirect_uri' });
    }

    const payload = jwt.verify(String(code || ''), JWT_SECRET);
    if (payload.typ !== 'auth_code') throw new Error('bad_code_type');

    const now = Math.floor(Date.now() / 1000);
    const access_token = jwt.sign({
      sub: payload.sub,
      scope: payload.scope,
      iat: now,
      exp: now + ACCESS_TTL_SEC,
      typ: 'access'
    }, SESSION_SECRET);

    const refresh_token = jwt.sign({
      sub: payload.sub,
      scope: payload.scope,
      iat: now,
      exp: now + REFRESH_TTL_SEC,
      typ: 'refresh'
    }, SESSION_SECRET);

    res.json({
      access_token,
      token_type: 'Bearer',
      expires_in: ACCESS_TTL_SEC,
      refresh_token,
      scope: payload.scope || '',
      created_at: now
    });
  } catch (e) {
    log('token exchange error', e.message);
    return res.status(400).json({ error: 'invalid_grant' });
  }
});

// API Routes from OpenAPI spec

// GET /api/db/user_summary - Get user profile and training summary from local DB
app.get('/api/db/user_summary', authenticateToken, validateUserId, async (req, res) => {
  const userId = req.validatedUserId;

  try {
    // Query user data from existing 'user' table
    const sql = `
      SELECT id, email, user_summary, info, rules, strategy, intervals_connected, 
             current_vdot, user_summary_updated_at
      FROM "user"
      WHERE id = $1
      LIMIT 1
    `;
    const result = await pool.query(sql, [userId]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    const user = result.rows[0];
    
    // Use existing user_summary if available, otherwise construct from other fields
    let userSummary = user.user_summary;
    if (!userSummary) {
      userSummary = {
        info: user.info || 'No info available',
        goals: user.rules || 'No goals set',
        strategy: user.strategy || 'No strategy defined',
        intervals_connected: user.intervals_connected || false,
        current_vdot: user.current_vdot || null
      };
    }

    res.json({
      ok: true,
      user_summary: userSummary
    });
  } catch (err) {
    log('Error fetching user summary:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /icu/events - Get planned workouts from Intervals.icu
app.get('/icu/events', authenticateToken, validateUserId, async (req, res) => {
  const { oldest } = req.query;
  const userId = req.validatedUserId;

  try {
    // Get ICU access token from user_intervals_keys table
    const tokenSql = 'SELECT intervals_api_key FROM user_intervals_keys WHERE user_id = $1 LIMIT 1';
    const tokenResult = await pool.query(tokenSql, [userId]);

    if (tokenResult.rows.length === 0) {
      return res.status(401).json({ error: 'No ICU API key found for user. Please connect Intervals.icu account.' });
    }

    const icuApiKey = tokenResult.rows[0].intervals_api_key;

    // Build ICU API URL
    let icuUrl = `${ICU_API_BASE}/athlete/${userId}/events`;
    const params = new URLSearchParams();
    if (oldest) params.append('oldest', oldest);
    if (params.toString()) icuUrl += '?' + params.toString();

    // Proxy request to ICU API
    const response = await fetch(icuUrl, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${icuApiKey}`,
        'Content-Type': 'application/json'
      }
    });

    if (!response.ok) {
      log('ICU API error:', response.status, response.statusText);
      if (response.status === 401 || response.status === 403) {
        return res.status(401).json({ error: 'Unauthorized: Invalid or expired ICU API key' });
      }
      return res.status(response.status).json({ error: 'Failed to fetch from ICU API' });
    }

    const data = await response.json();
    res.json(data);
  } catch (err) {
    log('Error fetching planned workouts:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Экспортируем приложение для Netlify Functions
module.exports = app;

// Start server if run directly (not as module)
if (require.main === module) {
  app.listen(PORT, () => {
    log(`STAS Auth Gateway listening on port ${PORT}`);
    log(`Health check: http://localhost:${PORT}/gw/healthz`);
  });
}
