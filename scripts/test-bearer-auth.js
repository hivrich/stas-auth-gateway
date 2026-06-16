#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const express = require('express');

process.env.STAS_KEY = process.env.STAS_KEY || 'test-stas-key';
process.env.STAS_BASE = process.env.STAS_BASE || 'http://stas.local.test';

const bearerUid = require('../routes/_bearer_uid');
const uidInjectDb = require('../routes/_uid_inject_db');
const dbProxy = require('../routes/db_proxy');
const icu = require('../routes/icu');

const originalFetch = global.fetch;
const upstreamHits = [];

function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get(name) {
        return String(name).toLowerCase() === 'content-type' ? 'application/json; charset=utf-8' : null;
      },
    },
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

global.fetch = async (url, options = {}) => {
  const parsed = new URL(url.toString());
  upstreamHits.push({
    url: parsed.toString(),
    method: options.method || 'GET',
    headers: options.headers || {},
    body: options.body,
  });

  if (parsed.origin === 'https://intervals.icu' && parsed.pathname === '/api/v1/athlete/0') {
    return jsonResponse({ id: '15487', name: 'Patrik Lindegardh' });
  }

  if (parsed.origin === 'http://stas.local.test' && parsed.pathname === '/api/db/ensure-intervals-user') {
    return jsonResponse({ ok: true });
  }

  if (parsed.origin === 'http://stas.local.test' && parsed.pathname === '/api/db/activity_detail') {
    return jsonResponse({ ok: true, user_id: parsed.searchParams.get('user_id') });
  }

  if (parsed.origin === 'http://stas.local.test' && parsed.pathname === '/api/db/icu_creds') {
    return jsonResponse({ api_key: 'test-icu-key', athlete_id: 'i15487' });
  }

  if (parsed.origin === 'https://intervals.icu' && parsed.pathname === '/api/v1/athlete/i15487/events') {
    return jsonResponse([]);
  }

  return jsonResponse({ error: 'unexpected_upstream', url: parsed.toString() }, 500);
};

function makeLegacyToken(uid) {
  return `t_${Buffer.from(JSON.stringify({ uid })).toString('base64url')}`;
}

function makeApp() {
  const app = express();
  app.use('/gw', bearerUid());
  app.get('/gw/api/me', (req, res) => {
    const uid = req.user_id || req.query.user_id;
    if (!uid) return res.status(401).json({ status: 401, error: 'missing_or_invalid_token' });
    res.json({ ok: true, user_id: String(uid), auth_mode: req.auth?.authMode || null });
  });
  app.use('/gw/api/db', uidInjectDb);
  app.use('/gw/api/db', dbProxy);
  app.use('/gw/icu', icu);
  return app;
}

async function startServer(app) {
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server));
  });
}

async function request(baseUrl, path, token) {
  const response = await originalFetch(`${baseUrl}${path}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  const text = await response.text();
  return {
    status: response.status,
    body: text ? JSON.parse(text) : null,
  };
}

async function main() {
  const server = await startServer(makeApp());
  const address = server.address();
  const baseUrl = `http://${address.address}:${address.port}`;

  try {
    let response = await request(baseUrl, '/gw/api/me', makeLegacyToken('108'));
    assert.equal(response.status, 200);
    assert.equal(response.body.user_id, '108');
    assert.equal(response.body.auth_mode, 'legacy');

    response = await request(baseUrl, '/gw/api/me', 'intervals-access-token');
    assert.equal(response.status, 200);
    assert.equal(response.body.user_id, '15487');
    assert.equal(response.body.auth_mode, 'intervals');

    response = await request(baseUrl, '/gw/api/db/activity_detail?training_id=train-1', 'intervals-access-token');
    assert.equal(response.status, 200);
    assert.equal(response.body.user_id, '15487');

    response = await request(baseUrl, '/gw/icu/events?days=7', 'intervals-access-token');
    assert.equal(response.status, 200);
    assert.deepEqual(response.body, []);

    const ensureHit = upstreamHits.find((hit) => new URL(hit.url).pathname === '/api/db/ensure-intervals-user');
    assert.ok(ensureHit, 'expected ensure-intervals-user call for direct Intervals token');

    console.log('ok - bearer auth accepts legacy and direct Intervals tokens');
  } finally {
    server.close();
    global.fetch = originalFetch;
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
