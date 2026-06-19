#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const express = require('express');

process.env.STAS_KEY = process.env.STAS_KEY || 'test-stas-key';
process.env.STAS_BASE = process.env.STAS_BASE || 'http://stas.local.test';

const { __testing: requestAuthTesting, getRequestUserId } = require('../lib/request-auth');
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
    assert.equal(parsed.searchParams.get('uid'), null);
    return jsonResponse({ ok: true, user_id: parsed.searchParams.get('user_id') });
  }

  if (parsed.origin === 'http://stas.local.test' && parsed.pathname === '/api/db/icu_creds') {
    return jsonResponse({ api_key: 'test-icu-key', athlete_id: 'i15487' });
  }

  if (parsed.origin === 'https://intervals.icu' && parsed.pathname === '/api/v1/athlete/0/events') {
    assert.equal(options.headers.Authorization, 'Bearer intervals-access-token');
    return jsonResponse([]);
  }

  if (parsed.origin === 'https://intervals.icu' && parsed.pathname === '/api/v1/athlete/i15487/events') {
    assert.match(options.headers.Authorization || '', /^Bearer |^Basic /);
    if (String(options.headers.Authorization || '').startsWith('Bearer ')) {
      return jsonResponse({ error: 'forbidden' }, 403);
    }
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
    const uid = getRequestUserId(req);
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
  const oldEnableLegacyTBearer = process.env.ENABLE_LEGACY_T_BEARER;
  const oldLegacyTBearerCompat = process.env.LEGACY_T_BEARER_COMPAT_ENABLED;
  delete process.env.ENABLE_LEGACY_T_BEARER;
  delete process.env.LEGACY_T_BEARER_COMPAT_ENABLED;
  requestAuthTesting.clearDirectTokenCache();

  const server = await startServer(makeApp());
  const address = server.address();
  const baseUrl = `http://${address.address}:${address.port}`;

  try {
    let response = await request(baseUrl, '/gw/api/me', makeLegacyToken('108'));
    assert.equal(response.status, 401);
    assert.equal(response.body.error, 'missing_or_invalid_token');
    assert.equal(upstreamHits.length, 0);

    response = await request(baseUrl, '/gw/api/me?user_id=999&uid=888');
    assert.equal(response.status, 401);
    assert.equal(response.body.error, 'missing_or_invalid_token');
    assert.equal(upstreamHits.length, 0);

    response = await request(baseUrl, '/gw/api/me', 'intervals-access-token');
    assert.equal(response.status, 200);
    assert.equal(response.body.user_id, '15487');
    assert.equal(response.body.auth_mode, 'intervals');

    response = await request(baseUrl, '/gw/api/me?user_id=999&uid=888', 'intervals-access-token');
    assert.equal(response.status, 200);
    assert.equal(response.body.user_id, '15487');
    assert.equal(response.body.auth_mode, 'intervals');
    const directCacheKeys = requestAuthTesting.getDirectTokenCacheKeys();
    assert.deepEqual(directCacheKeys, [requestAuthTesting.makeDirectTokenCacheKey('intervals-access-token')]);
    assert.equal(directCacheKeys.includes('intervals-access-token'), false);
    assert.match(directCacheKeys[0], /^sha256:[a-f0-9]{64}$/);

    const hitsBeforeLegacyFlag = upstreamHits.length;
    process.env.ENABLE_LEGACY_T_BEARER = '1';
    response = await request(baseUrl, '/gw/api/me', makeLegacyToken('108'));
    assert.equal(response.status, 401);
    assert.equal(response.body.error, 'missing_or_invalid_token');
    assert.equal(upstreamHits.length, hitsBeforeLegacyFlag);
    delete process.env.ENABLE_LEGACY_T_BEARER;

    process.env.LEGACY_T_BEARER_COMPAT_ENABLED = 'true';
    response = await request(baseUrl, '/gw/api/me', makeLegacyToken('108'));
    assert.equal(response.status, 401);
    assert.equal(response.body.error, 'missing_or_invalid_token');
    assert.equal(upstreamHits.length, hitsBeforeLegacyFlag);
    delete process.env.LEGACY_T_BEARER_COMPAT_ENABLED;

    response = await request(baseUrl, '/gw/api/db/activity_detail?training_id=train-1&user_id=999&uid=888', 'intervals-access-token');
    assert.equal(response.status, 200);
    assert.equal(response.body.user_id, '15487');

    response = await request(baseUrl, '/gw/icu/events?days=7', 'intervals-access-token');
    assert.equal(response.status, 200);
    assert.deepEqual(response.body, []);

    const ensureHit = upstreamHits.find((hit) => new URL(hit.url).pathname === '/api/db/ensure-intervals-user');
    assert.ok(ensureHit, 'expected ensure-intervals-user call for direct Intervals token');

    const directEventsHits = upstreamHits.filter((hit) => new URL(hit.url).pathname === '/api/v1/athlete/0/events');
    assert.equal(directEventsHits.length, 1);
    assert.equal(directEventsHits[0].headers.Authorization, 'Bearer intervals-access-token');

    const legacyCredentialHits = upstreamHits.filter((hit) => new URL(hit.url).pathname === '/api/db/icu_creds');
    assert.equal(legacyCredentialHits.length, 0);

    console.log('ok - bearer auth rejects unsigned legacy t_ tokens even when compat flags are enabled');
  } finally {
    server.close();
    global.fetch = originalFetch;
    if (oldEnableLegacyTBearer === undefined) delete process.env.ENABLE_LEGACY_T_BEARER;
    else process.env.ENABLE_LEGACY_T_BEARER = oldEnableLegacyTBearer;
    if (oldLegacyTBearerCompat === undefined) delete process.env.LEGACY_T_BEARER_COMPAT_ENABLED;
    else process.env.LEGACY_T_BEARER_COMPAT_ENABLED = oldLegacyTBearerCompat;
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
