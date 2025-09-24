'use strict';

const express = require('express');
const path = require('path');
const app = express();

app.disable('x-powered-by');
app.use(express.json({ limit: '256kb' }));
app.use(express.urlencoded({ extended: false }));

// Bearer -> user_id
app.use('/gw', require('./routes/_bearer_uid_oauth')());

// Debug
require('./routes/debug_gw')(app);
require('./routes/debug_stats_gw')(app);

// STAS proxy
require('./routes/stas_proxy_gw')(app);

// Intervals: GET plan + POST bulk
require('./routes/icu_get_plan_gw')(app);
require('./routes/icu_post_real_gw')(app);

// OAuth (authorize + token)
require('./routes/oauth_gw')(app);

// Static OpenAPI
app.get('/gw/openapi.yaml', (_req, res) => res.sendFile(path.join('/opt/stas-auth-gateway-v2/openapi.yaml')));
app.get('/gw/openapi.json', (_req, res) => res.sendFile(path.join('/opt/stas-auth-gateway-v2/openapi.json')));

// Health
app.get('/gw/healthz', (_req, res) => res.json({ ok: true, ts: new Date().toISOString() }));

const PORT = Number(process.env.PORT || 3340);
app.listen(PORT, () => console.log(`[v2] Server on ${PORT}`));
