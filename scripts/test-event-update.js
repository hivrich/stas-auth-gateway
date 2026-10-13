#!/usr/bin/env node
'use strict';

// PUT /gw/icu/events/:id и PUT /gw/icu/activities/:id/race: мок Intervals, без сети.
const assert = require('node:assert/strict');
const express = require('express');

process.env.STAS_KEY = process.env.STAS_KEY || 'test-stas-key';
process.env.STAS_BASE = process.env.STAS_BASE || 'http://stas.local.test';

const bearerUid = require('../routes/_bearer_uid');
const attachEventUpdate = require('../lib/attach_event_update');
const { classifyMcpScopeCategory } = require('../middleware/mcp_scope_guard').__testing;

const originalFetch = global.fetch;
let localOrigin = '';
const upstreamHits = [];
// События атлета токена; всё остальное для него «не существует» (как в Intervals).
const ownEvents = {
  '5001': { id: 5001, external_id: 'plan:2026-10-20:easy-run', start_date_local: '2026-10-20T00:00:00', category: 'WORKOUT', athlete_id: 'i15487' },
  '5002': { id: 5002, external_id: null, start_date_local: '2026-10-21T00:00:00', category: 'WORKOUT' },
};
const activities = {
  i100: { id: 'i100', icu_athlete_id: 'i15487', sub_type: 'NONE' },
  i101: { id: 'i101', icu_athlete_id: 'i99999', sub_type: 'NONE' },
  i102: { id: 'i102', sub_type: 'NONE' },
};
let eventGetStatus = null;
let eventPutStatus = null;

function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => 'application/json; charset=utf-8' },
    json: async () => body,
    text: async () => JSON.stringify(body),
    clone() { return this; },
  };
}

global.fetch = async (url, options = {}) => {
  const parsed = new URL(url.toString());
  if (parsed.origin === localOrigin) return originalFetch(url, options);

  const method = options.method || 'GET';
  upstreamHits.push({ url: parsed.toString(), path: parsed.pathname, method, headers: options.headers || {}, body: options.body });

  if (parsed.origin === 'http://stas.local.test' && parsed.pathname === '/api/db/ensure-intervals-user') {
    return jsonResponse({ ok: true });
  }
  if (parsed.origin !== 'https://intervals.icu') return jsonResponse({ error: 'unexpected_upstream' }, 500);

  if (parsed.pathname === '/api/v1/athlete/0') return jsonResponse({ id: '15487', name: 'Patrik' });

  let m = parsed.pathname.match(/^\/api\/v1\/athlete\/0\/events\/(\d+)$/);
  if (m) {
    const ev = ownEvents[m[1]];
    if (method === 'GET') {
      if (eventGetStatus) return jsonResponse({ error: 'x' }, eventGetStatus);
      return ev ? jsonResponse(ev) : jsonResponse({ error: 'not found' }, 404);
    }
    if (method === 'PUT') {
      if (eventPutStatus) return jsonResponse({ error: 'boom' }, eventPutStatus);
      return jsonResponse({ ...ev, ...JSON.parse(options.body) });
    }
  }

  m = parsed.pathname.match(/^\/api\/v1\/activity\/([^/]+)$/);
  if (m) {
    const act = activities[m[1]];
    if (method === 'GET') return act ? jsonResponse(act) : jsonResponse({ error: 'not found' }, 404);
    if (method === 'PUT') return jsonResponse({ ...act, ...JSON.parse(options.body) });
  }
  return jsonResponse({ error: 'unexpected_upstream', url: parsed.toString() }, 500);
};

function makeApp() {
  const app = express();
  app.use('/gw', bearerUid());
  attachEventUpdate(app);
  return app;
}

async function request(baseUrl, path, { method = 'PUT', json, headers = {} } = {}) {
  const response = await originalFetch(`${baseUrl}${path}`, {
    method,
    headers: {
      Authorization: 'Bearer intervals-access-token',
      Accept: 'application/json',
      ...(json === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...headers,
    },
    ...(json === undefined ? {} : { body: JSON.stringify(json) }),
  });
  return { status: response.status, body: await response.json() };
}

const puts = () => upstreamHits.filter(h => h.method === 'PUT');
function reset() {
  upstreamHits.length = 0;
  eventGetStatus = null;
  eventPutStatus = null;
}

async function main() {
  const app = makeApp();
  const live = await new Promise(resolve => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const address = live.address();
  const baseUrl = `http://${address.address}:${address.port}`;
  localOrigin = baseUrl;

  try {
    // --- События ---
    let r = await request(baseUrl, '/gw/icu/events/5001', { json: { start_date_local: '2026-10-22T00:00:00' } });
    assert.equal(r.status, 200);
    assert.equal(r.body.dry_run, true, 'dry_run is the default');
    assert.deepEqual(r.body.would_update, { start_date_local: '2026-10-22T00:00:00' });
    assert.equal(puts().length, 0, 'default dry_run must not write');
    console.log('ok - event dry_run by default does not write');

    reset();
    r = await request(baseUrl, '/gw/icu/events/5001?dry_run=false', {
      json: {
        start_date_local: '2026-10-22T00:00:00',
        name: 'Moved run',
        category: 'NOTE',
        external_id: 'hack:1',
        athlete_id: 'i99999',
        id: 1,
        dry_run: true,
      },
    });
    assert.equal(r.status, 200);
    assert.equal(r.body.ok, true);
    assert.equal(r.body.dry_run, false);
    assert.equal(r.body.updated, 1);
    assert.deepEqual(r.body.event, {
      id: '5001',
      external_id: 'plan:2026-10-20:easy-run',
      start_date_local: '2026-10-22T00:00:00',
      category: 'WORKOUT',
    });
    assert.equal(puts().length, 1);
    assert.equal(puts()[0].path, '/api/v1/athlete/0/events/5001');
    assert.deepEqual(JSON.parse(puts()[0].body), { start_date_local: '2026-10-22T00:00:00', name: 'Moved run' });
    assert.equal(upstreamHits.findIndex(h => h.method === 'GET' && h.path.endsWith('/events/5001')) < upstreamHits.indexOf(puts()[0]), true, 'GET precedes PUT');
    console.log('ok - real event update sends only allowed fields, GET before PUT');

    reset();
    r = await request(baseUrl, '/gw/icu/events/5001?dry_run=0', {
      json: { description: 'd', type: 'Run', moving_time: 3000, icu_training_load: 40, workout_doc: { steps: [] }, end_date_local: '2026-10-22T01:00:00', for_week: false },
    });
    assert.equal(r.status, 200);
    assert.deepEqual(Object.keys(JSON.parse(puts()[0].body)).sort(), [
      'description', 'end_date_local', 'for_week', 'icu_training_load', 'moving_time', 'type', 'workout_doc',
    ]);
    console.log('ok - all allowed event fields pass through (dry_run=0)');

    reset();
    r = await request(baseUrl, '/gw/icu/events/9999?dry_run=false', { json: { name: 'x' } });
    assert.equal(r.status, 404);
    assert.equal(r.body.error, 'not_found');
    assert.equal(puts().length, 0, 'foreign/missing event must not be written');
    r = await request(baseUrl, '/gw/icu/events/9999', { json: { name: 'x' } });
    assert.equal(r.status, 404);
    console.log('ok - missing or foreign event -> 404 and no PUT');

    reset();
    r = await request(baseUrl, '/gw/icu/events/abc?dry_run=false', { json: { name: 'x' } });
    assert.equal(r.status, 400);
    r = await request(baseUrl, '/gw/icu/events/12ab?dry_run=false', { json: { name: 'x' } });
    assert.equal(r.status, 400);
    r = await request(baseUrl, '/gw/icu/events/5001?dry_run=false', { json: { category: 'NOTE', external_id: 'x' } });
    assert.equal(r.status, 400, 'only forbidden fields -> empty after filter');
    r = await request(baseUrl, '/gw/icu/events/5001?dry_run=false', { json: {} });
    assert.equal(r.status, 400);
    r = await request(baseUrl, '/gw/icu/events/5001?dry_run=false', { json: { start_date_local: '2026-10-22' } });
    assert.equal(r.status, 400, 'bad date format');
    assert.equal(upstreamHits.filter(h => h.path.includes('/events/')).length, 0, 'validation errors must not reach Intervals');
    console.log('ok - non-digit id, empty/forbidden-only/invalid body -> 400 without upstream calls');

    reset();
    eventGetStatus = 401;
    r = await request(baseUrl, '/gw/icu/events/5001?dry_run=false', { json: { name: 'x' } });
    assert.equal(r.status, 401);
    assert.equal(r.body.error, 'auth_required');
    eventGetStatus = null;
    eventPutStatus = 500;
    r = await request(baseUrl, '/gw/icu/events/5001?dry_run=false', { json: { name: 'x' } });
    assert.equal(r.status, 502);
    assert.equal(r.body.error, 'upstream_error');
    assert.equal(r.body.status, 500);
    eventPutStatus = 403;
    r = await request(baseUrl, '/gw/icu/events/5001?dry_run=false', { json: { name: 'x' } });
    assert.equal(r.status, 401);
    eventPutStatus = 404;
    r = await request(baseUrl, '/gw/icu/events/5001?dry_run=false', { json: { name: 'x' } });
    assert.equal(r.status, 404);
    console.log('ok - Intervals errors map to auth_required / upstream_error(status) / not_found');

    // --- Активности ---
    reset();
    r = await request(baseUrl, '/gw/icu/activities/i100/race', { json: { race: true } });
    assert.equal(r.status, 200);
    assert.equal(r.body.dry_run, true);
    assert.deepEqual(r.body.would_update, { id: 'i100', sub_type: 'RACE' });
    assert.equal(puts().length, 0);
    console.log('ok - race dry_run by default does not write');

    reset();
    r = await request(baseUrl, '/gw/icu/activities/i100/race?dry_run=false', { json: { race: true } });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { ok: true, dry_run: false, activity: { id: 'i100', sub_type: 'RACE' } });
    assert.equal(puts().length, 1);
    assert.equal(puts()[0].path, '/api/v1/activity/i100');
    assert.deepEqual(JSON.parse(puts()[0].body), { sub_type: 'RACE' });
    r = await request(baseUrl, '/gw/icu/activities/i100/race?dry_run=false', { json: { race: false } });
    assert.equal(r.body.activity.sub_type, 'NONE');
    assert.deepEqual(JSON.parse(puts()[1].body), { sub_type: 'NONE' });
    console.log('ok - race true/false -> PUT sub_type RACE/NONE');

    reset();
    r = await request(baseUrl, '/gw/icu/activities/i101/race?dry_run=false', { json: { race: true } });
    assert.equal(r.status, 404);
    r = await request(baseUrl, '/gw/icu/activities/i102/race?dry_run=false', { json: { race: true } });
    assert.equal(r.status, 404, 'no owner field -> not own');
    r = await request(baseUrl, '/gw/icu/activities/i404/race?dry_run=false', { json: { race: true } });
    assert.equal(r.status, 404);
    assert.equal(puts().length, 0, 'foreign/missing activity must not be written');
    console.log('ok - foreign/ownerless/missing activity -> 404 and no PUT');

    reset();
    r = await request(baseUrl, '/gw/icu/activities/i100/race?dry_run=false', { json: { race: true, name: 'x' } });
    assert.equal(r.status, 400);
    r = await request(baseUrl, '/gw/icu/activities/i100/race?dry_run=false', { json: { name: 'x' } });
    assert.equal(r.status, 400);
    r = await request(baseUrl, '/gw/icu/activities/i100/race?dry_run=false', { json: { race: 'true' } });
    assert.equal(r.status, 400);
    r = await request(baseUrl, '/gw/icu/activities/i100/race?dry_run=false', { json: {} });
    assert.equal(r.status, 400);
    r = await request(baseUrl, '/gw/icu/activities/bad-id/race?dry_run=false', { json: { race: true } });
    assert.equal(r.status, 400);
    assert.equal(upstreamHits.filter(h => h.path.includes('/activity/')).length, 0, 'validation errors must not reach Intervals');
    console.log('ok - race bad body / bad id -> 400 without upstream calls');

    // Scope guard для MCP-токенов: событие -> CALENDAR, отметка старта -> ACTIVITY.
    assert.equal(classifyMcpScopeCategory('/gw/icu/events/5001'), 'CALENDAR');
    assert.equal(classifyMcpScopeCategory('/gw/icu/activities/i100/race'), 'ACTIVITY');
    assert.equal(classifyMcpScopeCategory('/gw/icu/activities/i100/race/'), 'ACTIVITY');
    console.log('ok - scope categories: event -> CALENDAR, race -> ACTIVITY');
  } finally {
    live.close();
    global.fetch = originalFetch;
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
