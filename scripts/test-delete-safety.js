#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const express = require('express');

process.env.STAS_KEY = process.env.STAS_KEY || 'test-stas-key';
process.env.STAS_BASE = process.env.STAS_BASE || 'http://stas.local.test';

const bearerUid = require('../routes/_bearer_uid');
const icu = require('../routes/icu');
const attachDelete = require('../lib/attach_delete');

const originalFetch = global.fetch;
let localOrigin = '';
const upstreamHits = [];
const broadCalendar = [
  { id: 116577024, external_id: 'test:write-check:2026-06-18', name: 'STAS write test' },
  { id: 116274129, external_id: 'plan:2026-06-18:easy-run', name: 'Easy run' },
  { id: 116274131, external_id: 'plan:2026-06-18:strength', name: 'Strength' },
  { id: 116274133, external_id: 'plan:2026-06-19:easy-run', name: 'Easy run' },
];

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
    return jsonResponse({ id: '15487', name: 'Patrik Lindegardh' });
  }

  if (parsed.origin === 'http://stas.local.test' && parsed.pathname === '/api/db/ensure-intervals-user') {
    return jsonResponse({ ok: true });
  }

  if (parsed.origin === 'https://intervals.icu' && parsed.pathname === '/api/v1/athlete/0/events') {
    return jsonResponse(broadCalendar);
  }

  if (parsed.origin === 'https://intervals.icu' && parsed.pathname === '/api/v1/athlete/0/events/bulk-delete') {
    const body = JSON.parse(options.body || '[]');
    assert.deepEqual(body, [{ id: 116577024 }]);
    return jsonResponse({ deleted_ids: [116577024] });
  }

  return jsonResponse({ error: 'unexpected_upstream', url: parsed.toString() }, 500);
};

function makeApp() {
  const app = express();
  app.use('/gw', bearerUid());
  app.use('/gw/icu', icu);
  attachDelete(app);
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
      ...(options.headers || {}),
    },
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
  process.env.PORT = String(address.port);

  try {
    let response = await request(
      baseUrl,
      '/gw/icu/events?external_id_prefix=test%3A&oldest=2026-06-18&newest=2026-06-19&dry_run=true',
      { method: 'DELETE' },
    );
    assert.equal(response.status, 200);
    assert.equal(response.body.dry_run, true);
    assert.deepEqual(response.body.to_delete.ids, ['116577024']);

    response = await request(
      baseUrl,
      '/gw/icu/events?external_id=test%3Awrite-check%3A2026-06-18&oldest=2026-06-18&newest=2026-06-19&dry_run=true',
      { method: 'DELETE' },
    );
    assert.equal(response.status, 200);
    assert.deepEqual(response.body.to_delete.ids, ['116577024']);

    response = await request(
      baseUrl,
      '/gw/icu/events?external_id_prefix=test%3A&oldest=2026-06-18&newest=2026-06-19&dry_run=false',
      { method: 'DELETE' },
    );
    assert.equal(response.status, 200);
    assert.equal(response.body.deleted_count, 1);
    assert.deepEqual(response.body.deleted_ids, ['116577024']);

    const deleteHit = upstreamHits.find(hit => new URL(hit.url).pathname === '/api/v1/athlete/0/events/bulk-delete');
    assert.ok(deleteHit, 'expected bulk-delete call');

    console.log('ok - delete dry-run and real delete are filtered by external_id');
  } finally {
    server.close();
    global.fetch = originalFetch;
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
