#!/usr/bin/env node
'use strict';

// PUT /gw/icu/events/:id и PUT /gw/icu/activities/:id/race: мок Intervals, без сети.
const assert = require('node:assert/strict');
const express = require('express');

process.env.STAS_KEY = process.env.STAS_KEY || 'test-stas-key';
process.env.STAS_BASE = process.env.STAS_BASE || 'http://stas.local.test';

const { createApp } = require('../server');
const bearerUid = require('../routes/_bearer_uid');
const attachEventUpdate = require('../lib/attach_event_update');
const { classifyMcpScopeCategory } = require('../middleware/mcp_scope_guard').__testing;
const requestAuthTesting = require('../lib/request-auth').__testing;

const originalFetch = global.fetch;
const localOrigins = new Set();
let ledgerMode = 'ok';
const upstreamHits = [];
// События атлета токена; всё остальное для него «не существует» (как в Intervals).
const ownEvents = {
  '5001': { id: 5001, external_id: 'plan:2026-10-20:easy-run', start_date_local: '2026-10-20T00:00:00', category: 'WORKOUT', athlete_id: 'i15487' },
  '5002': { id: 5002, external_id: null, start_date_local: '2026-10-21T00:00:00', category: 'WORKOUT', athlete_id: 'i15487' },
  // Чужое событие, которое Intervals почему-то отдаёт (общий доступ, тренер): писать нельзя.
  '5003': { id: 5003, external_id: null, start_date_local: '2026-10-22T00:00:00', category: 'WORKOUT', athlete_id: 'i99999' },
  // Без владельца в ответе: считаем не своим.
  '5004': { id: 5004, external_id: null, start_date_local: '2026-10-23T00:00:00', category: 'WORKOUT' },
};
const activities = {
  i100: { id: 'i100', icu_athlete_id: 'i15487', sub_type: 'NONE' },
  i101: { id: 'i101', icu_athlete_id: 'i99999', sub_type: 'NONE' },
  i102: { id: 'i102', sub_type: 'NONE' },
};
let eventGetStatus = null;
let eventPutStatus = null;
let retryAfterHeader = null;

function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get: (name) => (String(name).toLowerCase() === 'retry-after' ? retryAfterHeader : 'application/json; charset=utf-8'),
    },
    json: async () => body,
    text: async () => JSON.stringify(body),
    clone() { return this; },
  };
}

global.fetch = async (url, options = {}) => {
  const parsed = new URL(url.toString());
  if (localOrigins.has(parsed.origin)) return originalFetch(url, options);

  const method = options.method || 'GET';
  upstreamHits.push({ url: parsed.toString(), path: parsed.pathname, method, headers: options.headers || {}, body: options.body });

  if (parsed.origin === 'http://stas.local.test' && parsed.pathname === '/api/db/ensure-intervals-user') {
    return jsonResponse({ ok: true });
  }
  if (parsed.origin === 'http://stas.local.test' && parsed.pathname === '/api/db/intervals-attempts') {
    if (ledgerMode === 'throw') throw new Error('stas down');
    if (ledgerMode === 'hang') return new Promise(() => {});
    return jsonResponse({ ok: true }, 202);
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
  retryAfterHeader = null;
}

// Записи журнала попыток, отправленные шлюзом в STAS (fire-and-forget: ждём доставки мока).
const ledgerRecords = () => upstreamHits
  .filter(h => h.path === '/api/db/intervals-attempts')
  .map(h => ({ ...JSON.parse(h.body), _headers: h.headers }));
const settle = () => new Promise(resolve => setTimeout(resolve, 60));

async function main() {
  const app = makeApp();
  const live = await new Promise(resolve => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const address = live.address();
  const baseUrl = `http://${address.address}:${address.port}`;
  localOrigins.add(baseUrl);

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
    for (const eventId of ['5003', '5004']) {
      r = await request(baseUrl, `/gw/icu/events/${eventId}?dry_run=false`, { json: { name: 'x' } });
      assert.equal(r.status, 404, `event ${eventId} is not the token athlete's`);
      assert.deepEqual(r.body, { ok: false, error: 'not_found' });
      r = await request(baseUrl, `/gw/icu/events/${eventId}`, { json: { name: 'x' } });
      assert.equal(r.status, 404, 'dry_run must not reveal a foreign event either');
    }
    assert.equal(puts().length, 0, 'foreign event (athlete_id mismatch or missing) must not be written');
    console.log('ok - event with foreign or missing athlete_id -> 404, no PUT (also for dry_run)');

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

    reset();
    eventPutStatus = 429;
    retryAfterHeader = '7';
    r = await originalFetch(`${baseUrl}/gw/icu/events/5001?dry_run=false`, {
      method: 'PUT',
      headers: { Authorization: 'Bearer intervals-access-token', 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'x' }),
    });
    assert.equal(r.status, 429);
    assert.equal(r.headers.get('retry-after'), '7', 'Retry-After (seconds) is forwarded');
    assert.deepEqual(await r.json(), { ok: false, error: 'rate_limited', retry_after_ms: 7000 });
    retryAfterHeader = new Date(Date.now() + 30000).toUTCString();
    r = await originalFetch(`${baseUrl}/gw/icu/events/5001?dry_run=false`, {
      method: 'PUT',
      headers: { Authorization: 'Bearer intervals-access-token', 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'x' }),
    });
    assert.equal(r.status, 429);
    assert.equal(r.headers.get('retry-after'), retryAfterHeader, 'Retry-After (HTTP date) is forwarded');
    const dateBody = await r.json();
    assert.equal(dateBody.error, 'rate_limited');
    assert.ok(dateBody.retry_after_ms > 20000 && dateBody.retry_after_ms <= 30000, 'date -> ms');
    retryAfterHeader = null;
    r = await request(baseUrl, '/gw/icu/events/5001?dry_run=false', { json: { name: 'x' } });
    assert.equal(r.status, 429, '429 without a parseable Retry-After is still 429');
    assert.deepEqual(r.body, { ok: false, error: 'rate_limited' });
    // 429 на чтении события - тоже 429, не 502.
    reset();
    eventGetStatus = 429;
    retryAfterHeader = '3';
    r = await request(baseUrl, '/gw/icu/events/5001?dry_run=false', { json: { name: 'x' } });
    assert.equal(r.status, 429);
    assert.equal(r.body.retry_after_ms, 3000);
    assert.equal(puts().length, 0);
    console.log('ok - Intervals 429 -> 429 rate_limited with Retry-After and retry_after_ms');

    reset();
    for (const status of [400, 409, 422]) {
      eventPutStatus = status;
      r = await request(baseUrl, '/gw/icu/events/5001?dry_run=false', { json: { name: 'x' } });
      assert.equal(r.status, status, `Intervals ${status} must not turn into 502`);
      assert.deepEqual(r.body, { ok: false, error: 'rejected', status });
    }
    for (const status of [500, 502, 503]) {
      eventPutStatus = status;
      r = await request(baseUrl, '/gw/icu/events/5001?dry_run=false', { json: { name: 'x' } });
      assert.equal(r.status, 502, `Intervals ${status} stays 502`);
      assert.deepEqual(r.body, { ok: false, error: 'upstream_error', status });
    }
    console.log('ok - Intervals 400/409/422 -> same status rejected; 5xx -> 502');

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

    // --- Серверный вызов STAS (X-API-Key = STAS_KEY): без ensure-intervals-user ---
    const ensureHits = () => upstreamHits.filter(h => h.path === '/api/db/ensure-intervals-user').length;
    const athleteHits = () => upstreamHits.filter(h => h.path === '/api/v1/athlete/0').length;
    const serverKey = { 'X-API-Key': process.env.STAS_KEY };

    requestAuthTesting.clearDirectTokenCache();
    reset();
    r = await request(baseUrl, '/gw/icu/events/5001?dry_run=false', { json: { name: 'Server move' }, headers: serverKey });
    assert.equal(r.status, 200);
    assert.equal(r.body.updated, 1);
    assert.equal(puts().length, 1, 'server call writes the event');
    assert.equal(ensureHits(), 0, 'server call must not hit ensure-intervals-user');
    assert.equal(athleteHits(), 1, 'userId comes from /athlete/0');
    assert.equal(requestAuthTesting.getDirectTokenCacheKeys().length, 0, 'server call is not cached');
    console.log('ok - STAS key: write passes without ensure-intervals-user, not cached');

    reset();
    r = await request(baseUrl, '/gw/icu/events/5001?dry_run=false', { json: { name: 'x' }, headers: { 'X-API-Key': 'wrong-key' } });
    assert.equal(r.status, 200);
    assert.equal(ensureHits(), 1, 'wrong key behaves as no key');
    console.log('ok - wrong key -> ensure-intervals-user is called as before');

    requestAuthTesting.clearDirectTokenCache();
    reset();
    r = await request(baseUrl, '/gw/icu/events/5001?dry_run=false', { json: { name: 'x' } });
    assert.equal(r.status, 200);
    assert.equal(ensureHits(), 1, 'no key -> ensure-intervals-user as before');
    assert.equal(requestAuthTesting.getDirectTokenCacheKeys().length, 1, 'normal call is cached');
    console.log('ok - no key -> ensure-intervals-user is called and cached as before');

    // Пустой/не заданный STAS_KEY не совпадает ни с каким заголовком.
    const isServer = requestAuthTesting.isStasServerRequest;
    const savedKey = process.env.STAS_KEY;
    assert.equal(isServer({ headers: { 'x-api-key': savedKey } }), true);
    assert.equal(isServer({ headers: { 'x-api-key': `${savedKey}x` } }), false);
    assert.equal(isServer({ headers: {} }), false);
    process.env.STAS_KEY = '';
    assert.equal(isServer({ headers: { 'x-api-key': '' } }), false);
    assert.equal(isServer({ headers: { 'x-api-key': savedKey } }), false);
    delete process.env.STAS_KEY;
    assert.equal(isServer({ headers: { 'x-api-key': 'undefined' } }), false);
    process.env.STAS_KEY = savedKey;
    console.log('ok - empty or unset STAS_KEY never matches');

    // --- Лимит тела отметки старта: 16kb, а не общие 256kb ---
    const bigRace = { race: true, pad: 'x'.repeat(20000) };
    reset();
    r = await request(baseUrl, '/gw/icu/activities/i100/race?dry_run=false', { json: bigRace });
    assert.equal(r.status, 413, 'route-level parser alone rejects >16kb');
    assert.equal(upstreamHits.filter(h => h.path.includes('/activity/')).length, 0, 'oversized body never reaches the handler');

    const full = createApp().listen(0, '127.0.0.1');
    await new Promise(resolve => full.once('listening', resolve));
    const fullUrl = `http://127.0.0.1:${full.address().port}`;
    localOrigins.add(fullUrl);
    try {
      reset();
      r = await request(fullUrl, '/gw/icu/activities/i100/race?dry_run=false', { json: bigRace });
      assert.equal(r.status, 413, 'full app: global 256kb parser must not swallow the race body');
      assert.equal(upstreamHits.filter(h => h.path.includes('/activity/')).length, 0, 'oversized body never reaches the handler');
      r = await request(fullUrl, '/gw/icu/activities/i100/race?dry_run=false', { json: { race: true } });
      assert.equal(r.status, 200, 'small race body still works in the full app');
      assert.equal(puts().length, 1);
      // Остальные маршруты сохраняют лимит 256kb: тело ~20kb проходит.
      r = await request(fullUrl, '/gw/icu/events/5001?dry_run=false', { json: { description: 'd'.repeat(20000) } });
      assert.equal(r.status, 200, 'other routes keep the 256kb limit');
      console.log('ok - race body > 16kb -> 413 before the handler (route alone and full app); other routes keep 256kb');

      // --- Журнал попыток: поля контракта, источник site только с ключом STAS ---
      requestAuthTesting.clearDirectTokenCache();
      reset();
      const requestId = '11111111-2222-4333-8444-555555555555';
      r = await request(fullUrl, '/gw/icu/events/5001?dry_run=false&secret=1', {
        json: { name: 'Ledger move' },
        headers: { 'X-API-Key': process.env.STAS_KEY, 'x-stas-source': 'site', 'x-stas-attempt': '2', 'x-stas-request-id': requestId },
      });
      assert.equal(r.status, 200);
      await settle();
      let records = ledgerRecords();
      assert.equal(records.length, 3, 'athlete lookup + GET + PUT');
      const byKind = records.reduce((acc, rec) => ({ ...acc, [`${rec.attempt_kind}:${rec.method}`]: rec }), {});
      assert.deepEqual(Object.keys(byKind).sort(), ['athlete_lookup:GET', 'bearer:GET', 'bearer:PUT']);
      for (const rec of records) {
        assert.equal(rec.provider_athlete_id, '15487', 'digits without i, from /athlete/0 / request user');
        assert.equal(rec.initiator, 'site');
        assert.equal(rec.http_status, 200);
        assert.equal(rec.outcome, 'ok');
        assert.equal(rec.retry_after_ms, null);
        assert.equal(typeof rec.latency_ms, 'number');
        assert.ok(!Number.isNaN(Date.parse(rec.started_at)));
        assert.equal(rec.attempt_number, 2);
        assert.equal(rec._headers['X-API-Key'], process.env.STAS_KEY);
        assert.equal(rec._headers['Content-Type'], 'application/json');
        assert.equal(rec._headers['x-stas-request-id'], requestId);
      }
      assert.equal(byKind['athlete_lookup:GET'].path, '/api/v1/athlete/0');
      assert.equal(byKind['bearer:PUT'].path, '/api/v1/athlete/0/events/5001');
      assert.ok(records.every(rec => !rec.path.includes('?')));
      assert.deepEqual(Object.keys(records[0]).filter(k => k !== '_headers').sort(), [
        'attempt_kind', 'attempt_number', 'http_status', 'initiator', 'latency_ms', 'method', 'outcome',
        'path', 'provider_athlete_id', 'retry_after_ms', 'started_at',
      ]);
      console.log('ok - ledger: lookup + bearer attempts reported with contract fields, initiator site with STAS key');

      // 429 в журнале: http_error + retry_after_ms; без ключа STAS 'site' не принимается.
      requestAuthTesting.clearDirectTokenCache();
      reset();
      eventPutStatus = 429;
      retryAfterHeader = '4';
      r = await request(fullUrl, '/gw/icu/events/5001?dry_run=false', {
        json: { name: 'x' },
        headers: { 'x-stas-source': 'site', 'x-stas-attempt': '101' },
      });
      assert.equal(r.status, 429);
      await settle();
      records = ledgerRecords();
      assert.ok(records.length >= 3);
      assert.ok(records.every(rec => rec.initiator === 'gpt'), 'site without the STAS key falls back to gpt');
      assert.ok(records.every(rec => rec.attempt_number === null), 'x-stas-attempt > 100 is ignored');
      const put429 = records.find(rec => rec.method === 'PUT');
      assert.equal(put429.http_status, 429);
      assert.equal(put429.outcome, 'http_error');
      assert.equal(put429.retry_after_ms, 4000);
      console.log("ok - ledger: 429 reported with retry_after_ms; 'site' ignored without STAS key");

      // Сбой журнала не меняет ответ.
      for (const mode of ['throw', 'hang']) {
        requestAuthTesting.clearDirectTokenCache();
        reset();
        ledgerMode = mode;
        r = await request(fullUrl, '/gw/icu/events/5001?dry_run=false', { json: { name: 'x' } });
        assert.equal(r.status, 200, `ledger ${mode} must not affect the response`);
        assert.equal(r.body.updated, 1);
      }
      ledgerMode = 'ok';
      console.log('ok - ledger failure or hang does not change the response');
    } finally {
      full.close();
      ledgerMode = 'ok';
    }
  } finally {
    live.close();
    global.fetch = originalFetch;
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
