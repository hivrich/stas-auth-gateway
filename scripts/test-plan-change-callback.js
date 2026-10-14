#!/usr/bin/env node
'use strict';

// Отчёт шлюза в STAS (POST /api/db/plan_changes) после успешной настоящей записи событий:
// POST /gw/icu/events, DELETE /gw/icu/events, PUT /gw/icu/events/:id. Intervals и STAS мокаются.
const assert = require('node:assert/strict');
const express = require('express');

process.env.NODE_ENV = 'test';
process.env.STAS_KEY = 'test-stas-key';
process.env.STAS_BASE = 'http://stas.local.test';

const { requestIdIngress } = require('../lib/request-id');
const bearerUid = require('../routes/_bearer_uid');
const attachIcuPostExact = require('../lib/icu_post_exact');
const attachDelete = require('../lib/attach_delete');
const attachEventUpdate = require('../lib/attach_event_update');
const icuRouter = require('../routes/icu');
const { resolvePlanChangeActor } = require('../lib/plan-change-actor');
const callback = require('../lib/plan-change-callback');

const originalFetch = global.fetch;
const REQUEST_ID = '11111111-2222-4333-8444-555555555555';
let localOrigin = '';
let store = [];
let nextId = 3000;
let icuHits = [];
let stasCalls = []; // запросы к /api/db/plan_changes
let stasMode = 'ok'; // 'ok' | 'throw' | 'hang' | 'status500'
let icuFail = null; // статус ошибки Intervals на запись
let deleteResponse = null; // переопределение ответа bulk-delete

function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (n) => (String(n).toLowerCase() === 'content-type' ? 'application/json' : null) },
    json: async () => body,
    text: async () => JSON.stringify(body),
    clone() { return this; },
  };
}

global.fetch = async (url, options = {}) => {
  const parsed = new URL(url.toString());
  if (parsed.origin === localOrigin) return originalFetch(url, options);
  const method = options.method || 'GET';

  if (parsed.origin === 'http://stas.local.test') {
    if (parsed.pathname === '/api/db/plan_changes') {
      stasCalls.push({ headers: options.headers || {}, body: JSON.parse(options.body), method });
      if (stasMode === 'throw') throw new Error('stas down');
      if (stasMode === 'hang') {
        return new Promise((resolve, reject) => {
          options.signal?.addEventListener('abort', () => reject(options.signal.reason));
        });
      }
      if (stasMode === 'status500') return jsonResponse({ error: 'boom' }, 500);
      return jsonResponse({ ok: true });
    }
    if (parsed.pathname === '/api/db/ensure-intervals-user') return jsonResponse({ ok: true });
    if (parsed.pathname === '/api/db/icu_creds') return jsonResponse({ api_key: 'stored-key', athlete_id: '0' });
    return jsonResponse({ ok: true });
  }
  if (parsed.origin !== 'https://intervals.icu') return jsonResponse({ error: 'unexpected_upstream' }, 500);

  if (parsed.pathname === '/api/v1/athlete/0') return jsonResponse({ id: '15487', name: 'Test Athlete' });
  const base = '/api/v1/athlete/0/events';
  icuHits.push({ method, path: parsed.pathname, body: options.body ? JSON.parse(options.body) : undefined });

  if (parsed.pathname === base && method === 'GET') {
    const prefix = parsed.searchParams.get('external_id_prefix');
    const ext = parsed.searchParams.get('external_id');
    return jsonResponse(store.filter((e) => (!prefix || (e.external_id || '').startsWith(prefix)) && (!ext || e.external_id === ext)));
  }
  if (parsed.pathname === `${base}/bulk` && method === 'POST') {
    if (icuFail) return jsonResponse({ error: 'icu says no' }, icuFail);
    const out = JSON.parse(options.body).map((incoming) => {
      const found = store.find((e) => e.external_id && e.external_id === incoming.external_id);
      if (found) {
        Object.assign(found, incoming, { updated: '2026-10-14T10:00:00.000+00:00' });
        return { ...found };
      }
      const ev = { id: nextId++, athlete_id: 'i15487', updated: '2026-10-14T10:00:00.000+00:00', ...incoming };
      store.push(ev);
      return { ...ev };
    });
    return jsonResponse(out);
  }
  if (parsed.pathname === base && method === 'POST') {
    if (icuFail) return jsonResponse({ error: 'icu says no' }, icuFail);
    const ev = { id: nextId++, athlete_id: 'i15487', updated: '2026-10-14T10:00:00.000+00:00', ...JSON.parse(options.body) };
    store.push(ev);
    return jsonResponse(ev, 201);
  }
  if (parsed.pathname === `${base}/bulk-delete` && method === 'PUT') {
    if (icuFail) return jsonResponse({ error: 'icu says no' }, icuFail);
    if (deleteResponse) return jsonResponse(deleteResponse);
    const ids = JSON.parse(options.body).map((x) => x.id);
    store = store.filter((e) => !ids.includes(e.id));
    return jsonResponse({ deleted_count: ids.length, deleted_ids: ids.map(String) });
  }
  const one = parsed.pathname.match(/^\/api\/v1\/athlete\/0\/events\/(\d+)$/);
  if (one) {
    const ev = store.find((e) => String(e.id) === one[1]);
    if (!ev) return jsonResponse({ error: 'nf' }, 404);
    if (method === 'GET') return jsonResponse({ ...ev });
    if (method === 'PUT') {
      if (icuFail) return jsonResponse({ error: 'icu says no' }, icuFail);
      Object.assign(ev, JSON.parse(options.body), { updated: '2026-10-14T11:00:00.000+00:00' });
      return jsonResponse({ ...ev });
    }
  }
  return jsonResponse({ error: 'unexpected_upstream', path: parsed.pathname, method }, 500);
};

function reset(initial = []) {
  store = initial.map((e) => ({ id: nextId++, athlete_id: 'i15487', ...e }));
  icuHits = [];
  stasCalls = [];
  stasMode = 'ok';
  icuFail = null;
  deleteResponse = null;
  callback.__testing.resetStats();
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function call(baseUrl, method, path, { body, headers = {} } = {}) {
  const response = await originalFetch(`${baseUrl}${path}`, {
    method,
    headers: {
      Authorization: 'Bearer intervals-access-token',
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'x-stas-request-id': REQUEST_ID,
      ...headers,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, body: await response.json() };
}

function plan(date, extra = {}) {
  return {
    name: 'Easy run', category: 'WORKOUT', type: 'Run',
    start_date_local: `${date}T09:00:00`, external_id: `plan:${date}-easy-run`, description: 'v1', ...extra,
  };
}

const day = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);

function testActorMapping() {
  const table = [
    [{ source: 'site' }, 'you'],
    [{ source: 'site', authMode: 'mcp', clientHost: 'claude.ai' }, 'you'],
    [{ source: 'mcp', authMode: 'mcp', clientHost: 'chatgpt.com' }, 'chatgpt'],
    [{ source: 'mcp', authMode: 'mcp', clientHost: 'www.chatgpt.com' }, 'chatgpt'],
    [{ source: 'mcp', authMode: 'mcp', clientHost: 'api.openai.com' }, 'chatgpt'],
    [{ source: 'mcp', authMode: 'mcp', clientHost: 'claude.ai' }, 'claude'],
    [{ source: 'mcp', authMode: 'mcp', clientHost: 'claude.com' }, 'claude'],
    [{ source: 'mcp', authMode: 'mcp', clientHost: 'mcp.anthropic.com' }, 'claude'],
    [{ source: 'mcp', authMode: 'mcp', clientHost: 'CLAUDE.AI' }, 'claude'],
    [{ source: 'mcp', authMode: 'mcp', clientHost: 'example.org' }, 'ai_chat'],
    [{ source: 'mcp', authMode: 'mcp', clientHost: 'notchatgpt.com' }, 'ai_chat'],
    [{ source: 'mcp', authMode: 'mcp', clientHost: 'chatgpt.com.evil.test' }, 'ai_chat'],
    [{ source: 'mcp', authMode: 'mcp' }, 'ai_chat'],
    [{ source: 'claude' }, 'claude'],
    [{ source: 'gpt' }, 'chatgpt'],
    [{ source: 'mcp' }, 'ai_chat'],
    [{}, 'ai_chat'],
  ];
  for (const [input, expected] of table) {
    assert.equal(resolvePlanChangeActor(input), expected, JSON.stringify(input));
  }
  console.log('ok - actor mapping table');
}

async function main() {
  testActorMapping();

  const app = express();
  app.use(requestIdIngress);
  // Тестовый вход как MCP-клиент: готовая req.auth с хостом клиента (по заголовку).
  app.use((req, res, next) => {
    const host = req.headers['x-test-mcp-host'];
    if (host) req.auth = { userId: '15487', athleteId: 15487, authMode: 'mcp', source: 'mcp', clientHost: host === 'none' ? undefined : host };
    next();
  });
  app.use('/gw', bearerUid());
  attachIcuPostExact(app);
  attachDelete(app);
  attachEventUpdate(app);
  app.use('/gw/icu', icuRouter);
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  localOrigin = baseUrl;
  process.env.PORT = String(server.address().port);

  const realLog = console.log;
  const logs = [];
  console.log = (...args) => { logs.push(args.join(' ')); realLog(...args); };

  try {
    // POST upsert: session_type не уходит в Intervals; обратный вызов с created/changed и session_type
    reset([{ ...plan(day(4)), description: 'old', external_id: `plan:${day(4)}-easy-run` }]);
    const existingId = store[0].id;
    let r = await call(baseUrl, 'POST', '/gw/icu/events?dry_run=false&change_reason=%20Moved%20for%20travel%20', {
      body: { events: [plan(day(4), { description: 'v2', session_type: 'easy' }), plan(day(5), { session_type: 'long' }), plan(day(6))] },
    });
    assert.equal(r.status, 200);
    assert.equal(r.body.created, 2);
    assert.equal(r.body.updated, 1);
    const bulk = icuHits.find((h) => h.path.endsWith('/bulk'));
    assert.ok(bulk.body.every((e) => !('session_type' in e)), 'no session_type in Intervals request');
    assert.equal(stasCalls.length, 1);
    const sent = stasCalls[0];
    assert.equal(sent.headers['X-API-Key'], 'test-stas-key');
    assert.equal(sent.headers['x-stas-request-id'], REQUEST_ID);
    assert.equal(sent.headers['x-stas-source'], 'gpt');
    assert.equal(sent.body.user_id, '15487');
    assert.equal(sent.body.actor, 'chatgpt');
    assert.equal(sent.body.request_id, REQUEST_ID);
    assert.equal(sent.body.change_reason, 'Moved for travel');
    assert.equal(sent.body.deleted, undefined);
    assert.equal(sent.body.events.length, 3);
    const [e1, e2, e3] = sent.body.events;
    assert.equal(e1.action, 'changed');
    assert.equal(e1.id, existingId);
    assert.equal(e1.session_type, 'easy');
    assert.equal(e1.description, 'v2');
    assert.equal(e1.updated, '2026-10-14T10:00:00.000+00:00');
    assert.equal(e1.athlete_id, 'i15487');
    // external_id не найден в окне чтения: действие не отправляем, STAS решает по своей отметке версии
    assert.equal('action' in e2, false);
    assert.equal(e2.session_type, 'long');
    assert.equal(e2.external_id, `plan:${day(5)}-easy-run`);
    assert.equal('action' in e3, false);
    assert.equal('session_type' in e3, false);
    for (const key of ['id', 'athlete_id', 'external_id', 'category', 'start_date_local', 'name', 'type', 'description', 'updated']) {
      assert.ok(key in e2, `callback event has ${key}`);
    }
    console.log('ok - POST upsert: no session_type to Intervals, callback changed / no action for unseen ids + session_type + change_reason');

    // dedupe=false: created, без session_type в Intervals
    reset();
    r = await call(baseUrl, 'POST', '/gw/icu/events?dry_run=false&dedupe=false', {
      body: { events: [{ ...plan(day(7)), session_type: 'tempo' }] },
    });
    assert.equal(r.status, 200);
    assert.equal(icuHits.filter((h) => h.method === 'POST')[0].body.session_type, undefined);
    assert.equal(stasCalls.length, 1);
    assert.equal(stasCalls[0].body.events[0].action, 'created');
    assert.equal(stasCalls[0].body.events[0].session_type, 'tempo');
    assert.equal(stasCalls[0].body.change_reason, undefined);
    console.log('ok - POST dedupe=false: created callback');

    // dry run (по умолчанию и явный) и preview: нет вызова, session_type убран из ответа
    reset();
    r = await call(baseUrl, 'POST', '/gw/icu/events', { body: { events: [{ ...plan(day(4)), session_type: 'easy' }] } });
    assert.equal(r.body.dry_run, true);
    assert.equal('session_type' in r.body.events[0], false);
    r = await call(baseUrl, 'POST', '/gw/icu/events?dry_run=true', { body: { events: [plan(day(4))] } });
    r = await call(baseUrl, 'POST', '/gw/icu/events/preview', { body: { events: [{ ...plan(day(4)), session_type: 'easy' }] } });
    assert.equal('session_type' in r.body.events[0], false);
    assert.equal(stasCalls.length, 0);
    console.log('ok - dry run / preview: no callback, session_type stripped');

    // Ошибка Intervals: ответ с ошибкой и без вызова
    reset();
    icuFail = 422;
    r = await call(baseUrl, 'POST', '/gw/icu/events?dry_run=false', { body: { events: [plan(day(4))] } });
    assert.equal(r.status, 422);
    assert.equal(stasCalls.length, 0);
    console.log('ok - Intervals error: no callback');

    // Actor: сайт STAS (X-API-Key + x-stas-source: site) и MCP-клиент
    reset();
    await call(baseUrl, 'POST', '/gw/icu/events?dry_run=false', {
      body: { events: [plan(day(4))] }, headers: { 'x-stas-source': 'site', 'X-API-Key': 'test-stas-key' },
    });
    assert.equal(stasCalls[0].body.actor, 'you');
    assert.equal(stasCalls[0].headers['x-stas-source'], 'site');
    reset();
    await call(baseUrl, 'POST', '/gw/icu/events?dry_run=false', {
      body: { events: [plan(day(4))] }, headers: { 'x-test-mcp-host': 'claude.ai' },
    });
    assert.equal(stasCalls[0].body.actor, 'claude');
    reset();
    await call(baseUrl, 'POST', '/gw/icu/events?dry_run=false', {
      body: { events: [plan(day(4))] }, headers: { 'x-test-mcp-host': 'none' },
    });
    assert.equal(stasCalls[0].body.actor, 'ai_chat');
    console.log('ok - actor from site key and MCP client host');

    // Более 25 событий: куски по 25 с разными request_id
    reset();
    const many = Array.from({ length: 101 }, (_, i) => plan(day(10), { external_id: `plan:many-${i}`, name: `w${i}` }));
    r = await call(baseUrl, 'POST', '/gw/icu/events?dry_run=false', { body: { events: many } });
    assert.equal(r.status, 200);
    assert.deepEqual(stasCalls.map((c) => c.body.events.length).sort((a, b) => a - b), [1, 25, 25, 25, 25]);
    assert.equal(new Set(stasCalls.map((c) => c.body.request_id)).size, 5);
    console.log('ok - chunking at 25 events');

    // DELETE real по external_id: deleted со строками, найденными перед удалением
    reset([plan(day(4)), plan(day(5))]);
    const [a, b] = store;
    r = await call(baseUrl, 'DELETE', `/gw/icu/events?dry_run=false&external_id=${encodeURIComponent(a.external_id)}&oldest=${day(0)}&newest=${day(30)}&change_reason=cleanup`);
    assert.equal(r.status, 200);
    assert.equal(r.body.deleted_count, 1);
    assert.equal(stasCalls.length, 1);
    assert.equal(stasCalls[0].body.events, undefined);
    assert.deepEqual(stasCalls[0].body.deleted, [{
      id: a.id, external_id: a.external_id, category: 'WORKOUT', start_date_local: a.start_date_local, name: 'Easy run',
    }]);
    assert.equal(stasCalls[0].body.change_reason, 'cleanup');
    // по префиксу, только фактически удалённые
    reset([plan(day(4)), plan(day(5))]);
    const [c, d] = store;
    deleteResponse = { deleted_count: 1, deleted_ids: [String(d.id)] };
    r = await call(baseUrl, 'DELETE', `/gw/icu/events?dry_run=false&external_id_prefix=plan:&oldest=${day(0)}&newest=${day(30)}`);
    assert.equal(r.body.ok, false);
    assert.equal(stasCalls.length, 1);
    assert.deepEqual(stasCalls[0].body.deleted.map((x) => x.id), [d.id]);
    assert.equal(stasCalls[0].body.deleted[0].external_id, d.external_id);
    // dry run DELETE и пустой выбор: нет вызова
    reset([plan(day(4))]);
    const only = store[0];
    await call(baseUrl, 'DELETE', `/gw/icu/events?external_id_prefix=plan:&oldest=${day(0)}&newest=${day(30)}`);
    await call(baseUrl, 'DELETE', `/gw/icu/events?dry_run=false&external_id_prefix=nothing:&oldest=${day(0)}&newest=${day(30)}`);
    assert.equal(stasCalls.length, 0);
    // ошибка Intervals при удалении
    icuFail = 500;
    await call(baseUrl, 'DELETE', `/gw/icu/events?dry_run=false&id=${only.id}`);
    assert.equal(stasCalls.length, 0);
    // явный id: только id
    icuFail = null;
    await call(baseUrl, 'DELETE', `/gw/icu/events?dry_run=false&id=${only.id}`);
    assert.equal(stasCalls.length, 1);
    assert.equal(String(stasCalls[0].body.deleted[0].id), String(only.id));
    assert.equal(stasCalls[0].body.deleted[0].external_id, null);
    console.log('ok - DELETE: callback with listed rows restricted to deleted ids; none on dry run/empty/error');

    // PUT real: changed с событием Intervals; dry run и ошибка - без вызова
    reset([plan(day(4))]);
    const put = store[0];
    r = await call(baseUrl, 'PUT', `/gw/icu/events/${put.id}?dry_run=false&change_reason=shift`, { body: { name: 'Renamed', start_date_local: `${day(4)}T18:00:00` } });
    assert.equal(r.status, 200);
    assert.deepEqual(Object.keys(r.body.event).sort(), ['category', 'external_id', 'id', 'start_date_local']);
    assert.equal(stasCalls.length, 1);
    const ev = stasCalls[0].body.events[0];
    assert.equal(ev.action, 'changed');
    assert.equal(ev.id, put.id);
    assert.equal(ev.name, 'Renamed');
    assert.equal(ev.start_date_local, `${day(4)}T18:00:00`);
    assert.equal(ev.updated, '2026-10-14T11:00:00.000+00:00');
    assert.equal(ev.athlete_id, 'i15487');
    assert.equal(stasCalls[0].body.change_reason, 'shift');
    stasCalls = [];
    await call(baseUrl, 'PUT', `/gw/icu/events/${put.id}`, { body: { name: 'x' } });
    icuFail = 422;
    r = await call(baseUrl, 'PUT', `/gw/icu/events/${put.id}?dry_run=false`, { body: { name: 'x' } });
    assert.equal(r.status, 422);
    assert.equal(stasCalls.length, 0);
    console.log('ok - PUT: changed callback; none on dry run/error');

    // STAS недоступен: ответ клиенту прежний, ровно один повтор в фоне
    for (const mode of ['throw', 'status500', 'hang']) {
      reset();
      stasMode = mode;
      callback.__testing.setTimings({ timeoutMs: 120, retryDelayMs: 60 });
      logs.length = 0;
      const started = Date.now();
      r = await call(baseUrl, 'POST', '/gw/icu/events?dry_run=false', { body: { events: [plan(day(4), { session_type: 'easy' })] } });
      const elapsed = Date.now() - started;
      assert.equal(r.status, 200, `${mode}: client response unchanged`);
      assert.equal(r.body.created, 1);
      assert.equal(r.body.ok, true);
      assert.equal(stasCalls.length, 1, `${mode}: first attempt`);
      assert.equal(callback.__testing.getStats().retriesScheduled, 1);
      if (mode === 'hang') assert.ok(elapsed >= 100 && elapsed < 2000, `hang bounded by timeout (${elapsed} ms)`);
      await sleep(mode === 'hang' ? 400 : 250);
      assert.equal(stasCalls.length, 2, `${mode}: exactly one retry`);
      assert.deepEqual(stasCalls[1].body, stasCalls[0].body, 'retry has the same body and request_id');
      await sleep(300);
      assert.equal(stasCalls.length, 2, `${mode}: no further retries`);
      const lines = logs.filter((l) => l.startsWith('[plan_changes][callback]')).map((l) => JSON.parse(l.slice('[plan_changes][callback] '.length)));
      assert.ok(lines.some((l) => l.phase === 'first' && l.outcome === 'failed' && l.stas_request_id === REQUEST_ID));
      assert.ok(lines.some((l) => l.phase === 'retry'));
      const logged = JSON.stringify(lines);
      assert.ok(!logged.includes('test-stas-key') && !logged.includes('intervals-access-token'));
    }
    // DELETE при недоступном STAS тоже отвечает как обычно
    reset([plan(day(4))]);
    stasMode = 'throw';
    r = await call(baseUrl, 'DELETE', `/gw/icu/events?dry_run=false&id=${store[0].id}`);
    assert.equal(r.status, 200);
    assert.equal(r.body.deleted_count, 1);
    await sleep(200);
    callback.__testing.setTimings({});
    console.log('ok - STAS unavailable (throw / 500 / hang): client response unchanged, exactly one background retry');

    // Нет id пользователя: вызов пропущен, функция не бросает
    reset();
    await callback.reportPlanChange({ headers: {}, query: {}, stasRequestId: REQUEST_ID, get: () => undefined }, { events: [{ action: 'created', row: { id: 1 } }] });
    assert.equal(stasCalls.length, 0);
    console.log('ok - missing user id: skipped without throwing');
  } finally {
    console.log = realLog;
    server.close();
    global.fetch = originalFetch;
  }
}

main().then(() => process.exit(0)).catch((error) => { console.error(error); process.exit(1); });
