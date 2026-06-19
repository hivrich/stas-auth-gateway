const express    = require('express');
const bodyParser = require('body-parser');

const bearerUid   = require('./routes/_bearer_uid');
const legacyAliases = require('./routes/legacy_aliases');
const trainingsRouter = require('./routes/trainings');
const uidInjectDb = require('./routes/_uid_inject_db');
const dbProxy     = require('./routes/db_proxy');
const stas        = require('./routes/stas');
const icu         = require('./routes/icu');
const openapi     = require('./routes/openapi');
const oauth       = require('./routes/oauth');
const agent       = require('./routes/agent');
const agentReadOnlyGuard = require('./middleware/agent_read_only');
const {
  publicDiscoveryCors,
  securityHeaders,
  sensitiveOAuthCorsGuard,
  sensitiveOAuthRateLimit,
} = require('./middleware/security');
const { buildOAuthAuthorizationServerMetadata } = require('./lib/oauth-metadata');
const { buildStasSourceHeaders } = require('./lib/request-source');
const { getRequestUserId } = require('./lib/request-auth');

const PORT = process.env.PORT || 3337;

function createApp() {
  const app = express();
  app.set('trust proxy', 1);
  app.use(securityHeaders());
  app.use(publicDiscoveryCors());
  app.use(sensitiveOAuthCorsGuard());
  app.use(sensitiveOAuthRateLimit());

  const oauthPage = require("./middleware/oauth_page");
  app.use("/gw/oauth", oauthPage());
  const cookieParser = require("cookie-parser");
  app.use(cookieParser());

  app.use(bodyParser.json({ limit: '256kb' }));
  app.use(express.urlencoded({ extended: false }));

  app.get('/gw/healthz', (_req, res) => res.json({ ok: true, ts: new Date().toISOString() }));
  app.get('/gw/version', (_req, res) => res.json({ name: 'stas-auth-gateway', version: '1.0.0', ts: new Date().toISOString() }));

  app.get('/.well-known/oauth-authorization-server', (req, res) => {
    const origin = `${req.protocol}://${req.get('host')}`;
    res.json(buildOAuthAuthorizationServerMetadata(origin));
  });

  app.use('/gw', openapi);
  app.use('/gw', agent);
  app.use('/gw', bearerUid());
  app.use('/gw', agentReadOnlyGuard());
  require("./routes/icu_delete_exact_gw")(app);
  app.use('/gw', trainingsRouter);
  app.use('/gw', oauth);
  app.use('/gw', legacyAliases);

  app.get('/gw/api/me', (req, res) => {
    const uid = getRequestUserId(req);
    if (!uid) return res.status(401).json({ status: 401, error: 'missing_or_invalid_token' });
    res.json({ ok: true, user_id: String(uid), email: null });
  });

  app.post('/gw/strategy', async (req, res) => {
    try {
      const uid = getRequestUserId(req);
      if (!uid) return res.status(401).json({ status: 401, error: 'missing_or_invalid_token' });
      const STAS_BASE = process.env.STAS_BASE || 'http://127.0.0.1:3336';
      const STAS_KEY = process.env.STAS_KEY || '';
      const url = `${STAS_BASE}/api/db/strategy?user_id=${encodeURIComponent(uid)}`;
      const r = await fetch(url, {
        method: 'POST',
        headers: buildStasSourceHeaders(req, { 'X-API-Key': STAS_KEY, 'Content-Type': 'application/json' }),
        body: JSON.stringify(req.body),
      });
      const data = await r.json();
      res.status(r.status).json(data);
    } catch (e) {
      res.status(502).json({ error: 'bad_gateway' });
    }
  });

  app.use('/gw/api/db', uidInjectDb);
  app.use('/gw/api/db', dbProxy);
  app.use('/gw/api', stas);
  try {
    const attachIcuPostExact = require("./lib/icu_post_exact");
    if (typeof attachIcuPostExact === "function") attachIcuPostExact(app);
    else console.error("[icu][POST] attach function missing");
  } catch(e) { console.error("[icu][POST] attach failed:", e && e.message); }
  try { const attachDelete = require("./lib/attach_delete"); if (typeof attachDelete === "function") attachDelete(app); }
  catch(e){ console.error("[icu][DELETE] attach failed:", e && e.message); }
  app.use('/gw/icu', icu);

  app.use((req, res) => res.status(404).json({ error: 'not_found', path: req.path }));
  app.use((err, _req, res, _next) => {
    console.error('[ERR]', err && err.stack || err);
    res.status(500).json({ error: 'internal_error' });
  });

  return app;
}

function startServer(app = createApp(), port = PORT) {
  return app.listen(port, () => console.log(`Server running on port ${port}`));
}

if (require.main === module) {
  startServer();
}

module.exports = {
  createApp,
  startServer,
};
