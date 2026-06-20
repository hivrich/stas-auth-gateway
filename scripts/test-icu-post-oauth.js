#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const express = require('express');

process.env.STAS_KEY = 'test-stas-key';
process.env.STAS_BASE = 'http://stas.local.test';

const bearerUid = require('../routes/_bearer_uid');
const attachIcuPostExact = require('../lib/icu_post_exact');

const originalFetch = global.fetch;
let localOrigin = '';
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
    clone() {
      return this;
    },
  };
}

global.fetch = async (url, options = {}) => {
  const parsed = new URL(url.toString());

  if (parsed.origin === localOrigin) {
    return originalFetch(url, options);
  }

  upstreamHits.push({
    url: parsed.toString(),
    method: options.method || 'GET',
    headers: options.headers || {},
    body: options.body,
  });

  if (parsed.origin === 'https://intervals.icu' && parsed.pathname === '/api/v1/athlete/0') {
    assert.equal(options.headers.Authorization, 'Bearer intervals-access-token');
    return jsonResponse({ id: '15487', name: 'Patrik Lindegardh' });
  }

  if (parsed.origin === 'http://stas.local.test' && parsed.pathname === '/api/db/ensure-intervals-user') {
    return jsonResponse({ ok: true });
  }

  if (parsed.origin === 'http://stas.local.test' && parsed.pathname === '/api/db/icu_creds') {
    return jsonResponse({ error: 'icu_creds_must_not_be_loaded_for_oauth_post' }, 500);
  }

  if (parsed.origin === 'https://intervals.icu' && parsed.pathname === '/api/v1/athlete/0/events') {
    assert.equal(options.headers.Authorization, 'Bearer intervals-access-token');
    if ((options.method || 'GET') === 'GET') {
      assert.equal(parsed.searchParams.get('external_id_prefix'), 'plan:');
      return jsonResponse([]);
    }

    assert.equal(options.method, 'POST');
    const body = JSON.parse(options.body || '{}');
    assert.equal(body.name, 'STAS oauth write test');
    assert.equal(body.external_id, 'plan:2026-06-22:oauth-write-test');
    return jsonResponse({ id: 123456, external_id: body.external_id, name: body.name }, 201);
  }

  return jsonResponse({ error: 'unexpected_upstream', url: parsed.toString() }, 500);
};

function makeApp() {
  const app = express();
  app.use('/gw', bearerUid());
  attachIcuPostExact(app);
  return app;
}

async function startServer(app) {
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server));
  });
}

async function request(baseUrl, path, options = {}) {
  const response = await originalFetch(`${baseUrl}${path}`, {
    method: options.method || 'GET',
    headers: {
      Authorization: 'Bearer intervals-access-token',
      'User-Agent': 'ChatGPT-User',
      Accept: 'application/json',
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
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
  localOrigin = baseUrl;

  try {
    const response = await request(
      baseUrl,
      '/gw/icu/events?dry_run=false&oldest=2026-06-22&newest=2026-06-23',
      {
        method: 'POST',
        body: {
          events: [{
            name: 'STAS oauth write test',
            start_date_local: '2026-06-22T09:00:00',
            end_date_local: '2026-06-22T09:30:00',
            category: 'WORKOUT',
            type: 'Run',
            external_id: 'plan:2026-06-22:oauth-write-test',
          }],
        },
      },
    );

    assert.equal(response.status, 200);
    assert.equal(response.body.ok, true);
    assert.equal(response.body.dry_run, false);
    assert.equal(response.body.created, 1);
    assert.equal(response.body.icu[0].external_id, 'plan:2026-06-22:oauth-write-test');

    const calendarHits = upstreamHits.filter((hit) => new URL(hit.url).pathname === '/api/v1/athlete/0/events');
    assert.equal(calendarHits.length, 2);
    assert.deepEqual(calendarHits.map((hit) => hit.method), ['GET', 'POST']);
    assert.equal(calendarHits.every((hit) => hit.headers.Authorization === 'Bearer intervals-access-token'), true);
    assert.equal(upstreamHits.some((hit) => new URL(hit.url).pathname === '/api/db/icu_creds'), false);

    console.log('ok - OAuth calendar POST uses Bearer auth for dedupe and write');
  } finally {
    server.close();
    global.fetch = originalFetch;
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
