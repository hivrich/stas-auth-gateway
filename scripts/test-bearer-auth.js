#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const express = require('express');

process.env.STAS_KEY = process.env.STAS_KEY || 'test-stas-key';
process.env.STAS_BASE = process.env.STAS_BASE || 'http://stas.local.test';

const { __testing: requestAuthTesting, getRequestUserId, resolveDirectIntervalsAuth } = require('../lib/request-auth');
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
    const bearer = String(options.headers?.Authorization || '');
    if (bearer === 'Bearer limited-token') return jsonResponse({ error: 'slow down' }, 429);
    if (bearer === 'Bearer other-athlete-token') return jsonResponse({ id: '777', name: 'Other Athlete' });
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

    // Кэш поиска атлета только для серверных вызовов STAS (stasServerCall)
    requestAuthTesting.clearDirectTokenCache();
    const hitsOf = (name) => upstreamHits.filter((hit) => new URL(hit.url).pathname === name).length;
    const lookups = () => hitsOf('/api/v1/athlete/0');
    const ensures = () => hitsOf('/api/db/ensure-intervals-user');
    const serverCall = (token, extra = {}) => resolveDirectIntervalsAuth(token, { source: 'site', stasServerCall: true, ...extra });
    const userCall = (token, extra = {}) => resolveDirectIntervalsAuth(token, { source: 'gpt', ...extra });
    const lookups0 = lookups();
    const ensures0 = ensures();

    // два серверных вызова с одним токеном: один поиск, одинаковая форма ответа, ensure не вызывается
    let first = await serverCall('server-token');
    let second = await serverCall('server-token');
    assert.equal(lookups() - lookups0, 1, 'second server call is served from the cache');
    assert.equal(ensures() - ensures0, 0, 'server calls never ensure the user');
    assert.deepEqual(second, first);
    assert.deepEqual(first, { userId: '15487', athleteId: undefined, authMode: 'intervals', intervalsToken: 'server-token', source: 'site' });
    assert.deepEqual(requestAuthTesting.getDirectTokenCacheKeys(), [], 'server path never writes directTokenCache');

    // не-серверный вызов с тем же токеном: свой поиск и ensure-intervals-user
    const userAuth = await userCall('server-token');
    assert.equal(lookups() - lookups0, 2, 'non-server call does its own lookup');
    assert.equal(ensures() - ensures0, 1, 'non-server call ensures the user');
    assert.equal(userAuth.userId, '15487');
    assert.equal(requestAuthTesting.getDirectTokenCacheKeys().length, 1);

    // не-серверный вызов первым, затем серверный: серверный кэш не заполнялся, свой поиск
    requestAuthTesting.clearDirectTokenCache();
    const base1 = lookups();
    await userCall('user-first-token');
    assert.equal(lookups() - base1, 1);
    assert.equal(requestAuthTesting.getDirectTokenCacheKeys().length, 1, 'the non-server call filled directTokenCache');
    const base2 = lookups();
    await serverCall('user-first-token');
    assert.equal(lookups() - base2, 0, 'server call after a non-server one reuses the directTokenCache entry (read only)');
    assert.equal(requestAuthTesting.getDirectTokenCacheKeys().length, 1, 'the server call did not add directTokenCache entries');

    // 429 на поиске не кэшируется (и без rateLimitError тоже)
    const base3 = lookups();
    await assert.rejects(serverCall('limited-token', { rateLimitError: true }), (error) => error.status === 429);
    assert.equal(await serverCall('limited-token'), null);
    await assert.rejects(serverCall('limited-token', { rateLimitError: true }), (error) => error.status === 429);
    assert.equal(lookups() - base3, 3, 'failed lookups are never cached');

    // разные токены не делят записи
    const base4 = lookups();
    const mine = await serverCall('server-token-a');
    const theirs = await serverCall('other-athlete-token');
    assert.equal(mine.userId, '15487');
    assert.equal(theirs.userId, '777');
    assert.equal(lookups() - base4, 2);
    assert.equal((await serverCall('other-athlete-token')).userId, '777');
    assert.equal(lookups() - base4, 2);
    console.log('ok - athlete lookup cache is used and filled only by trusted server calls');
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
