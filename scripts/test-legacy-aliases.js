#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const express = require('express');

process.env.STAS_KEY = process.env.STAS_KEY || 'test-stas-key';
process.env.STAS_BASE = process.env.STAS_BASE || 'http://stas.local.test';
process.env.ENABLE_LEGACY_T_BEARER = '1';

const bearerUid = require('../routes/_bearer_uid');
const legacyAliases = require('../routes/legacy_aliases');
const trainingsRouter = require('../routes/trainings');

const originalFetch = global.fetch;
const upstreamHits = [];
const DIRECT_INTERVALS_TOKEN = 'legacy-aliases-intervals-token';

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
    assert.equal(options.headers.Authorization, `Bearer ${DIRECT_INTERVALS_TOKEN}`);
    return jsonResponse({ id: '108', name: 'Alias Runner' });
  }

  assert.equal(parsed.hostname, 'stas.local.test');
  assert.notEqual(parsed.port, '3338');

  if (parsed.pathname === '/api/db/ensure-intervals-user') {
    const body = JSON.parse(options.body);
    assert.equal(body.intervalsAthleteId, '108');
    assert.equal(body.intervalsAccessToken, DIRECT_INTERVALS_TOKEN);
    return jsonResponse({ ok: true, user_id: '108' });
  }

  if (parsed.pathname === '/api/db/user_summary') {
    assert.equal(parsed.searchParams.get('user_id'), '108');
    assert.equal(parsed.searchParams.get('uid'), null);
    return jsonResponse({ profile: { name: 'Test' } });
  }

  if (parsed.pathname === '/api/db/trainings') {
    assert.equal(parsed.searchParams.get('user_id'), '108');
    assert.equal(parsed.searchParams.get('uid'), null);
    assert.equal(parsed.searchParams.get('limit'), '1');
    return jsonResponse([{ id: 'train-1' }]);
  }

  return jsonResponse({ error: 'unexpected_upstream', url: parsed.toString() }, 500);
};

function makeApp() {
  const app = express();
  app.use('/gw', bearerUid());
  app.use('/gw', trainingsRouter);
  app.use('/gw', legacyAliases);
  return app;
}

async function startServer(app) {
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server));
  });
}

async function request(baseUrl, path, token = DIRECT_INTERVALS_TOKEN) {
  const response = await originalFetch(`${baseUrl}${path}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  return {
    status: response.status,
    body: await response.json(),
  };
}

async function main() {
  const server = await startServer(makeApp());
  const address = server.address();
  const baseUrl = `http://${address.address}:${address.port}`;

  try {
    let response = await request(baseUrl, '/gw/user_summary?user_id=999&uid=888');
    assert.equal(response.status, 200);
    assert.deepEqual(response.body, { ok: true, user_summary: { profile: { name: 'Test' } } });

    response = await request(baseUrl, '/gw/trainings?limit=1&full=true&user_id=999&uid=888');
    assert.equal(response.status, 200);
    assert.deepEqual(response.body, [{ id: 'train-1' }]);

    const dbHits = upstreamHits.filter((hit) => {
      const url = new URL(hit.url);
      return url.origin === 'http://stas.local.test'
        && ['/api/db/user_summary', '/api/db/trainings'].includes(url.pathname);
    });
    assert.equal(dbHits.length, 2);
    assert.equal(dbHits[0].headers['x-stas-source'], 'gpt');
    assert.equal(dbHits[1].headers['x-stas-source'], 'gpt');

    const hitsBeforeMissingToken = upstreamHits.length;
    response = await request(baseUrl, '/gw/user_summary?user_id=999', null);
    assert.equal(response.status, 401);
    assert.equal(response.body.error, 'missing_or_invalid_token');
    assert.equal(upstreamHits.length, hitsBeforeMissingToken);

    console.log('ok - legacy aliases use STAS_BASE directly with authenticated bearer auth');
  } finally {
    server.close();
    global.fetch = originalFetch;
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
