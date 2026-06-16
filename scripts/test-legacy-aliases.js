#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const express = require('express');

process.env.STAS_KEY = process.env.STAS_KEY || 'test-stas-key';
process.env.STAS_BASE = process.env.STAS_BASE || 'http://stas.local.test';

const bearerUid = require('../routes/_bearer_uid');
const legacyAliases = require('../routes/legacy_aliases');
const trainingsRouter = require('../routes/trainings');

const originalFetch = global.fetch;
const upstreamHits = [];

function makeLegacyToken(uid) {
  return `t_${Buffer.from(JSON.stringify({ uid })).toString('base64url')}`;
}

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
    headers: options.headers || {},
  });

  assert.equal(parsed.hostname, 'stas.local.test');
  assert.notEqual(parsed.port, '3338');

  if (parsed.pathname === '/api/db/user_summary') {
    assert.equal(parsed.searchParams.get('user_id'), '108');
    return jsonResponse({ profile: { name: 'Test' } });
  }

  if (parsed.pathname === '/api/db/trainings') {
    assert.equal(parsed.searchParams.get('user_id'), '108');
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

async function request(baseUrl, path) {
  const response = await originalFetch(`${baseUrl}${path}`, {
    headers: { Authorization: `Bearer ${makeLegacyToken('108')}` },
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
    let response = await request(baseUrl, '/gw/user_summary');
    assert.equal(response.status, 200);
    assert.deepEqual(response.body, { ok: true, user_summary: { profile: { name: 'Test' } } });

    response = await request(baseUrl, '/gw/trainings?limit=1&full=true');
    assert.equal(response.status, 200);
    assert.deepEqual(response.body, [{ id: 'train-1' }]);

    assert.equal(upstreamHits.length, 2);
    assert.equal(upstreamHits[0].headers['x-stas-source'], 'gpt');
    assert.equal(upstreamHits[1].headers['x-stas-source'], 'gpt');

    console.log('ok - legacy aliases use STAS_BASE directly');
  } finally {
    server.close();
    global.fetch = originalFetch;
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
