#!/usr/bin/env node
'use strict';

// POST /gw/icu/activities/manual: мок Intervals, без сети. Полный createApp (порядок маршрутов, парсеры тела).
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

process.env.STAS_KEY = process.env.STAS_KEY || 'test-stas-key';
process.env.STAS_BASE = process.env.STAS_BASE || 'http://stas.local.test';

const { createApp } = require('../server');
const requestAuthTesting = require('../lib/request-auth').__testing;

const originalFetch = global.fetch;
const localOrigins = new Set();
const upstreamHits = [];

// Состояние мок-Intervals.
let dayList = [];
// Если задан, список активностей зависит от запрошенного дня (oldest).
let dayListByDay = null;
let events = {};
let activitiesById = {};
let nextId = 900;
let createPairs = true; // POST manual возвращает paired_event_id
let postStatus = null;
let postThrows = false;
let postDelayMs = 0;
let putStatus = null;
let putPairs = true; // PUT действительно привязывает
let listStatus = null;
let retryAfterHeader = null;
let postResponseShape = 'object'; // object | array | noid

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
  upstreamHits.push({ url: parsed.toString(), path: parsed.pathname, search: parsed.search, method, body: options.body });

  if (parsed.origin === 'http://stas.local.test') {
    if (parsed.pathname === '/api/db/ensure-intervals-user') return jsonResponse({ ok: true });
    return jsonResponse({ ok: true }, 202);
  }
  if (parsed.origin !== 'https://intervals.icu') return jsonResponse({ error: 'unexpected_upstream' }, 500);

  if (parsed.pathname === '/api/v1/athlete/0') return jsonResponse({ id: '15487', name: 'Patrik' });

  let m = parsed.pathname.match(/^\/api\/v1\/athlete\/0\/events\/(\d+)$/);
  if (m && method === 'GET') {
    const ev = events[m[1]];
    return ev ? jsonResponse(ev) : jsonResponse({ error: 'not found' }, 404);
  }

  if (parsed.pathname === '/api/v1/athlete/0/activities' && method === 'GET') {
    if (listStatus) return jsonResponse({ error: 'x' }, listStatus);
    if (dayListByDay) return jsonResponse(dayListByDay[parsed.searchParams.get('oldest')] || []);
    return jsonResponse(dayList);
  }

  if (parsed.pathname === '/api/v1/athlete/0/activities/manual' && method === 'POST') {
    if (postThrows) throw new Error('network down');
    if (postDelayMs) await new Promise(resolve => setTimeout(resolve, postDelayMs));
    if (postStatus) return jsonResponse({ error: 'x' }, postStatus);
    const sent = JSON.parse(options.body);
    if (postResponseShape === 'noid') return jsonResponse({ ok: true });
    const created = {
      id: `i${nextId++}`,
      icu_athlete_id: 'i15487',
      source: 'MANUAL',
      ...sent,
      paired_event_id: createPairs ? sent.paired_event_id : undefined,
      secret_internal: 'must-not-leak',
    };
    activitiesById[created.id] = created;
    dayList.push(created);
    return jsonResponse(postResponseShape === 'array' ? [created] : created);
  }

  m = parsed.pathname.match(/^\/api\/v1\/activity\/([^/]+)$/);
  if (m) {
    const act = activitiesById[m[1]];
    if (method === 'GET') return act ? jsonResponse(act) : jsonResponse({ error: 'not found' }, 404);
    if (method === 'PUT') {
      if (putStatus) return jsonResponse({ error: 'x' }, putStatus);
      const sent = JSON.parse(options.body);
      if (putPairs) act.paired_event_id = sent.paired_event_id;
      return jsonResponse(act);
    }
  }
  return jsonResponse({ error: 'unexpected_upstream', url: parsed.toString() }, 500);
};

const SITE = () => ({ 'X-API-Key': process.env.STAS_KEY, 'x-stas-source': 'site' });

async function request(baseUrl, json, { headers = SITE(), path: p = '/gw/icu/activities/manual', method = 'POST' } = {}) {
  const response = await originalFetch(`${baseUrl}${p}`, {
    method,
    headers: {
      Authorization: 'Bearer intervals-access-token',
      Accept: 'application/json',
      ...(json === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...headers,
    },
    ...(json === undefined ? {} : { body: JSON.stringify(json) }),
  });
  return { status: response.status, headers: response.headers, body: await response.json() };
}

// Только запросы к Intervals (без журнала попыток и ensure).
const icuHits = () => upstreamHits.filter(h => h.path.startsWith('/api/v1/') && h.path !== '/api/v1/athlete/0');
const posts = () => icuHits().filter(h => h.method === 'POST');
const puts = () => icuHits().filter(h => h.method === 'PUT');
const lists = () => icuHits().filter(h => h.path === '/api/v1/athlete/0/activities');

function reset() {
  upstreamHits.length = 0;
  dayList = [];
  dayListByDay = null;
  activitiesById = {};
  nextId = 900;
  events = {
    '5001': { id: 5001, athlete_id: 'i15487', category: 'WORKOUT', start_date_local: '2026-10-20T00:00:00' },
    '5002': { id: 5002, athlete_id: 'i15487', category: 'WORKOUT', start_date_local: '2026-10-20T00:00:00', paired_activity_id: 'i777' },
    '5003': { id: 5003, athlete_id: 'i99999', category: 'WORKOUT' },
  };
  activitiesById.i777 = { id: 'i777', icu_athlete_id: 'i15487', type: 'Run', name: 'Already paired', paired_event_id: 5002, external_id: null };
  createPairs = true;
  postStatus = null;
  postThrows = false;
  postDelayMs = 0;
  putStatus = null;
  putPairs = true;
  listStatus = null;
  retryAfterHeader = null;
  postResponseShape = 'object';
  requestAuthTesting.clearDirectTokenCache();
}

const baseBody = () => ({
  external_id: 'stas-done:2026-10-20:abc123',
  type: 'Run',
  start_date_local: '2026-10-20T07:30:00',
  moving_time: 3000,
});

async function main() {
  const app = createApp();
  const live = await new Promise(resolve => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const baseUrl = `http://127.0.0.1:${live.address().port}`;
  localOrigins.add(baseUrl);

  try {
    // 1. Только сайт: без ключа / источник gpt / mcp -> 403 до любого запроса в Intervals.
    reset();
    for (const headers of [
      {},
      { 'x-stas-source': 'site' }, // заголовок без ключа STAS
      { 'X-API-Key': process.env.STAS_KEY }, // ключ без источника site (по умолчанию gpt)
      { 'X-API-Key': process.env.STAS_KEY, 'x-stas-source': 'gpt' },
      { 'X-API-Key': process.env.STAS_KEY, 'x-stas-source': 'mcp' },
      { 'X-API-Key': 'wrong-key', 'x-stas-source': 'site' },
    ]) {
      const r = await request(baseUrl, baseBody(), { headers });
      assert.equal(r.status, 403, JSON.stringify(headers));
      assert.deepEqual(r.body, { ok: false, error: 'site_only' });
    }
    assert.equal(icuHits().length, 0, '403 must not reach Intervals');
    // Включая проверку токена (/athlete/0): ворота стоят раньше общей авторизации.
    assert.equal(upstreamHits.filter(h => h.path.startsWith('/api/v1/')).length, 0, 'gate runs before the bearer lookup');
    // Без Bearer тоже 403 (не 401): сначала источник и ключ.
    const noBearer = await originalFetch(`${baseUrl}/gw/icu/activities/manual`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(baseBody()),
    });
    assert.equal(noBearer.status, 403);
    console.log('ok - no key / source gpt / mcp / wrong key -> 403 site_only, zero Intervals requests');

    // 2. Валидация: 400 без запросов в Intervals.
    reset();
    const bad = [
      ['external_id', { external_id: 'manual:1' }],
      ['external_id', { external_id: 'stas-done:' }],
      ['type', { type: 'Run!' }],
      ['type', { type: '' }],
      ['start_date_local', { start_date_local: '2026-02-30T07:30:00' }],
      ['start_date_local', { start_date_local: '2026-10-20' }],
      ['moving_time', { moving_time: 30 }],
      ['moving_time', { moving_time: 3000.5 }],
      ['moving_time', { moving_time: 172801 }],
      ['icu_rpe', { icu_rpe: 11 }],
      ['icu_rpe', { icu_rpe: 0 }],
      ['distance', { distance: -1 }],
      ['distance', { distance: 1000001 }],
      ['name', { name: 'x'.repeat(121) }],
      ['description', { description: 'x'.repeat(2001) }],
      ['plan_event_id', { plan_event_id: 'abc' }],
      ['plan_event_id', { plan_event_id: 5001 }],
    ];
    for (const [field, patch] of bad) {
      const r = await request(baseUrl, { ...baseBody(), ...patch });
      assert.equal(r.status, 400, JSON.stringify(patch));
      assert.deepEqual(r.body, { ok: false, error: 'invalid_body', field });
    }
    let r = await request(baseUrl, [1, 2]);
    assert.equal(r.status, 400);
    assert.equal(r.body.error, 'invalid_body');
    const broken = await originalFetch(`${baseUrl}/gw/icu/activities/manual`, {
      method: 'POST',
      headers: { Authorization: 'Bearer intervals-access-token', 'Content-Type': 'application/json', ...SITE() },
      body: '{"external_id":',
    });
    assert.equal(broken.status, 400);
    r = await request(baseUrl, { ...baseBody(), description: 'd'.repeat(20000) });
    assert.equal(r.status, 413, '16kb route limit applies in the full app');
    assert.equal(icuHits().length, 0, 'validation errors must not reach Intervals');
    console.log('ok - validation failures -> 400 invalid_body(field), oversized -> 413, zero Intervals requests');

    // 3. Без плана: ровно 2 запроса; в Intervals уходят только разрешённые поля.
    reset();
    r = await request(baseUrl, {
      ...baseBody(),
      name: 'Evening run',
      distance: 5000,
      icu_rpe: 6,
      description: 'felt ok',
      id: 'i1',
      paired_event_id: 5001,
      athlete_id: 'i99999',
      sub_type: 'RACE',
    });
    assert.equal(r.status, 200);
    assert.equal(r.body.ok, true);
    assert.equal(r.body.created, true);
    assert.equal(r.body.existing, false);
    assert.equal(r.body.paired, null);
    assert.equal(icuHits().length, 2, 'list day + POST manual');
    assert.equal(icuHits()[0].method, 'GET');
    assert.equal(icuHits()[0].path, '/api/v1/athlete/0/activities');
    assert.equal(icuHits()[0].search, '?oldest=2026-10-19&newest=2026-10-21');
    assert.equal(icuHits()[1].method, 'POST');
    assert.deepEqual(JSON.parse(posts()[0].body), {
      type: 'Run',
      start_date_local: '2026-10-20T07:30:00',
      name: 'Evening run',
      moving_time: 3000,
      external_id: 'stas-done:2026-10-20:abc123',
      distance: 5000,
      icu_rpe: 6,
      description: 'felt ok',
    });
    assert.equal(r.body.activity.id, 'i900');
    assert.equal(r.body.activity.external_id, 'stas-done:2026-10-20:abc123');
    assert.equal(r.body.activity.secret_internal, undefined, 'only picked fields are returned');
    assert.deepEqual(Object.keys(r.body.activity).sort(), [
      'description', 'distance', 'elapsed_time', 'external_id', 'feel', 'icu_athlete_id', 'icu_intensity',
      'icu_rpe', 'icu_training_load', 'id', 'moving_time', 'name', 'paired_event_id', 'session_rpe',
      'source', 'start_date_local', 'type',
    ]);
    // Минимальное тело: имя по умолчанию = type.
    reset();
    r = await request(baseUrl, baseBody());
    assert.equal(r.status, 200);
    assert.deepEqual(JSON.parse(posts()[0].body), {
      type: 'Run', start_date_local: '2026-10-20T07:30:00', name: 'Run', moving_time: 3000,
      external_id: 'stas-done:2026-10-20:abc123',
    });
    console.log('ok - no plan: exactly 2 requests, whitelisted body (id/paired_event_id dropped), created:true');

    // 4. С планом: 3 запроса, paired_event_id в POST, paired:true.
    reset();
    r = await request(baseUrl, { ...baseBody(), plan_event_id: '5001' });
    assert.equal(r.status, 200);
    assert.equal(r.body.created, true);
    assert.equal(r.body.paired, true);
    assert.equal(icuHits().length, 3, 'event GET + list + POST');
    assert.deepEqual(icuHits().map(h => `${h.method} ${h.path}`), [
      'GET /api/v1/athlete/0/events/5001',
      'GET /api/v1/athlete/0/activities',
      'POST /api/v1/athlete/0/activities/manual',
    ]);
    assert.equal(JSON.parse(posts()[0].body).paired_event_id, 5001);
    assert.equal(r.body.activity.paired_event_id, 5001);
    assert.equal(puts().length, 0);
    console.log('ok - with plan: 3 requests, paired_event_id in POST, paired:true');

    // 5. Тот же external_id уже есть: POST нет.
    reset();
    dayList = [{
      id: 'i500', external_id: 'stas-done:2026-10-20:abc123', type: 'Run',
      start_date_local: '2026-10-20T07:30:00', moving_time: 3000, icu_athlete_id: 'i15487',
    }];
    r = await request(baseUrl, baseBody());
    assert.equal(r.status, 200);
    assert.equal(r.body.created, false);
    assert.equal(r.body.existing, true);
    assert.equal(r.body.reason, 'external_id');
    assert.equal(r.body.paired, null);
    assert.equal(r.body.activity.id, 'i500');
    assert.equal(posts().length, 0);
    assert.equal(icuHits().length, 1);
    console.log('ok - same external_id exists -> no POST, existing:true reason external_id');

    // 6. Похожая: +3 минуты и +8 % -> не создаём; +6 минут или +12 % -> создаём.
    reset();
    dayList = [{
      id: 'i501', external_id: 'garmin:1', type: 'run', source: 'GARMIN_CONNECT',
      start_date_local: '2026-10-20T07:33:00', moving_time: 3240, icu_athlete_id: 'i15487',
    }];
    r = await request(baseUrl, baseBody());
    assert.equal(r.status, 200);
    assert.equal(r.body.created, false);
    assert.equal(r.body.reason, 'similar');
    assert.equal(r.body.activity.id, 'i501');
    assert.equal(posts().length, 0);
    for (const [start, moving] of [['2026-10-20T07:36:30', 3000], ['2026-10-20T07:30:00', 3360]]) {
      reset();
      dayList = [{
        id: 'i502', external_id: 'garmin:2', type: 'Run',
        start_date_local: start, moving_time: moving, icu_athlete_id: 'i15487',
      }];
      r = await request(baseUrl, baseBody());
      assert.equal(r.status, 200);
      assert.equal(r.body.created, true, `${start} ${moving} is not similar`);
      assert.equal(posts().length, 1);
    }
    reset();
    dayList = [{
      id: 'i503', external_id: 'garmin:3', type: 'Ride',
      start_date_local: '2026-10-20T07:30:00', moving_time: 3000, icu_athlete_id: 'i15487',
    }];
    r = await request(baseUrl, baseBody());
    assert.equal(r.body.created, true, 'other sport type is not similar');
    console.log('ok - similar (same type, +3 min, +8 %) -> no POST; +6 min, +12 %, other type -> created');

    // 6b. Найденная активность привязывается к плану (один PUT), без POST.
    reset();
    putPairs = true;
    activitiesById.i504 = {
      id: 'i504', external_id: 'garmin:4', type: 'Run', start_date_local: '2026-10-20T07:31:00',
      moving_time: 3000, icu_athlete_id: 'i15487',
    };
    dayList = [activitiesById.i504];
    r = await request(baseUrl, { ...baseBody(), plan_event_id: '5001' });
    assert.equal(r.status, 200);
    assert.equal(r.body.created, false);
    assert.equal(r.body.reason, 'similar');
    assert.equal(r.body.paired, true);
    assert.equal(posts().length, 0);
    assert.equal(puts().length, 1);
    assert.deepEqual(JSON.parse(puts()[0].body), { paired_event_id: 5001 });
    assert.equal(puts()[0].path, '/api/v1/activity/i504');
    console.log('ok - found similar activity gets paired with one PUT, no POST');

    // 7. План уже выполнен: только GET события и GET активности.
    reset();
    r = await request(baseUrl, { ...baseBody(), plan_event_id: '5002' });
    assert.equal(r.status, 200);
    assert.equal(r.body.created, false);
    assert.equal(r.body.existing, true);
    assert.equal(r.body.reason, 'plan_already_done');
    assert.equal(r.body.paired, true);
    assert.equal(r.body.activity.id, 'i777');
    assert.deepEqual(icuHits().map(h => `${h.method} ${h.path}`), [
      'GET /api/v1/athlete/0/events/5002',
      'GET /api/v1/activity/i777',
    ]);
    console.log('ok - plan already paired -> existing, only event GET + activity GET');

    // 7b. У события нет paired_activity_id (так отвечает Intervals): выполненность по активности с paired_event_id в списке дня.
    reset();
    activitiesById.i810 = {
      id: 'i810', external_id: 'stas-done:plan:5001', type: 'Run', start_date_local: '2026-10-20T07:30:00',
      moving_time: 3000, icu_athlete_id: 'i15487', paired_event_id: 5001,
    };
    dayList = [activitiesById.i810];
    r = await request(baseUrl, { ...baseBody(), external_id: 'stas-done:plan:5001', plan_event_id: '5001' });
    assert.equal(r.status, 200);
    assert.equal(r.body.created, false);
    assert.equal(r.body.reason, 'plan_already_done');
    assert.equal(r.body.paired, true);
    assert.equal(r.body.activity.id, 'i810');
    assert.equal(posts().length, 0);
    assert.equal(puts().length, 0);
    console.log('ok - plan done is detected by an activity paired to it in the day list, no POST');

    // 7c. План: окно фиксировано вокруг даты планового события (день плана -2 ... +15), не зависит от даты запроса;
    // дата записи 25.10 при плане на 20.10 допустима, список один.
    reset();
    r = await request(baseUrl, { ...baseBody(), start_date_local: '2026-10-25T07:30:00', plan_event_id: '5001' });
    assert.equal(r.status, 200);
    assert.equal(lists().length, 1, 'one list, no extra request for the plan day');
    assert.equal(lists()[0].search, '?oldest=2026-10-18&newest=2026-11-04');
    console.log('ok - plan search window is fixed around the plan day');

    // 7c1. Повтор с другой датой записи находит созданную активность: привязка ищется в окне плана, не от даты запроса.
    reset();
    activitiesById.i812 = {
      id: 'i812', external_id: 'stas-done:plan:5001', type: 'Run', start_date_local: '2026-10-22T07:30:00',
      moving_time: 3000, icu_athlete_id: 'i15487', paired_event_id: 5001,
    };
    dayListByDay = { '2026-10-18': [activitiesById.i812] };
    r = await request(baseUrl, { ...baseBody(), start_date_local: '2026-10-25T09:00:00', plan_event_id: '5001' });
    assert.equal(r.status, 200);
    assert.equal(r.body.reason, 'plan_already_done');
    assert.equal(r.body.activity.id, 'i812');
    assert.equal(posts().length, 0);
    dayListByDay = null;
    console.log('ok - retry with another record date finds the paired activity (no second POST)');

    // 7c1b. Дата записи вне окна плана (день плана -1 ... +14): отказ 400 до списка и POST.
    reset();
    r = await request(baseUrl, { ...baseBody(), start_date_local: '2026-11-10T07:30:00', plan_event_id: '5001' });
    assert.equal(r.status, 400);
    assert.equal(r.body.error, 'date_out_of_window');
    assert.equal(lists().length, 0);
    assert.equal(posts().length, 0);
    r = await request(baseUrl, { ...baseBody(), start_date_local: '2026-10-18T07:30:00', plan_event_id: '5001' });
    assert.equal(r.status, 400);
    assert.equal(posts().length, 0);
    console.log('ok - record date outside the plan window is refused before any search or POST');

    // 7c2. План: ключ строит сервер (stas-done:plan:<id>), клиентский external_id для плана игнорируется.
    reset();
    r = await request(baseUrl, { ...baseBody(), external_id: 'stas-done:form:client1', plan_event_id: '5001' });
    assert.equal(r.status, 200);
    assert.equal(JSON.parse(posts()[0].body).external_id, 'stas-done:plan:5001');
    console.log('ok - plan external_id is built by the server');

    // 7c3. У события нет athlete_id: владельца не установить -> 404 plan_not_found, без POST.
    reset();
    events['5004'] = { id: 5004, category: 'WORKOUT', start_date_local: '2026-10-20T00:00:00' };
    r = await request(baseUrl, { ...baseBody(), plan_event_id: '5004' });
    assert.equal(r.status, 404);
    assert.equal(r.body.error, 'plan_not_found');
    assert.equal(posts().length, 0);
    console.log('ok - plan without an owner field is refused');

    // 7d. Похожая активность через полночь (23:59 и 00:01): один список за три дня её находит, второй POST не уходит.
    reset();
    activitiesById.i820 = {
      id: 'i820', external_id: 'garmin:9', type: 'Run', start_date_local: '2026-10-19T23:59:00',
      moving_time: 3000, icu_athlete_id: 'i15487',
    };
    dayList = [activitiesById.i820];
    r = await request(baseUrl, { ...baseBody(), start_date_local: '2026-10-20T00:01:00' });
    assert.equal(r.status, 200);
    assert.equal(r.body.created, false);
    assert.equal(r.body.reason, 'similar');
    assert.equal(posts().length, 0);
    assert.equal(lists().length, 1);
    console.log('ok - similar activity across midnight is found by the three-day list');

    // 7e. Список не массивом (сбой, нечитаемый ответ): дубли не проверить, ничего не создаём, 502.
    reset();
    dayListByDay = { '2026-10-19': { error: 'weird' } };
    r = await request(baseUrl, baseBody());
    assert.equal(r.status, 502);
    assert.equal(posts().length, 0);
    dayListByDay = null;
    console.log('ok - non-array list -> 502 without creating');

    // 7f. Два разных ключа, одна и та же тренировка, одновременно: у атлета запросы идут по очереди, POST один.
    reset();
    postDelayMs = 60;
    const [ra, rb] = await Promise.all([
      request(baseUrl, { ...baseBody(), external_id: 'stas-done:form:aaaaaa' }),
      request(baseUrl, { ...baseBody(), external_id: 'stas-done:form:bbbbbb' }),
    ]);
    assert.equal(ra.status, 200);
    assert.equal(rb.status, 200);
    assert.equal(posts().length, 1, 'one POST for two simultaneous keys of the same workout');
    assert.equal([ra, rb].filter(x => x.body.created).length, 1);
    postDelayMs = 0;
    console.log('ok - simultaneous requests with different keys are serialized per athlete (one POST)');

    // 7c4. Нормализация номера плана: '05001' и '5001' — один и тот же план и один ключ.
    reset();
    r = await request(baseUrl, { ...baseBody(), plan_event_id: '05001' });
    assert.equal(r.status, 200);
    assert.equal(JSON.parse(posts()[0].body).external_id, 'stas-done:plan:5001');
    assert.equal(JSON.parse(posts()[0].body).paired_event_id, 5001);
    console.log('ok - plan_event_id is normalized (no leading zeros)');

    // 7c5. Уже выполненный план при дате записи вне окна: 400 date_out_of_window, не 200 plan_already_done.
    reset();
    r = await request(baseUrl, { ...baseBody(), start_date_local: '2026-11-10T07:30:00', plan_event_id: '5002' });
    assert.equal(r.status, 400);
    assert.equal(r.body.error, 'date_out_of_window');
    assert.equal(posts().length, 0);
    console.log('ok - date window is checked before the already-paired shortcut');

    // 7c6. Одновременные запросы одного плана с разной датой не объединяются: запрос вне окна получает свой 400.
    reset();
    postDelayMs = 40;
    const [okRes, badRes] = await Promise.all([
      request(baseUrl, { ...baseBody(), plan_event_id: '5001' }),
      request(baseUrl, { ...baseBody(), start_date_local: '2026-11-10T07:30:00', plan_event_id: '5001' }),
    ]);
    assert.equal(okRes.status, 200);
    assert.equal(badRes.status, 400);
    assert.equal(badRes.body.error, 'date_out_of_window');
    assert.equal(posts().length, 1);
    postDelayMs = 0;
    console.log('ok - concurrent requests with another date are not merged (own window check)');

    // 7c7. Похожая активность уже привязана к другому плану: 409, ни PUT, ни POST (привязка не переключается).
    reset();
    activitiesById.i830 = {
      id: 'i830', external_id: 'garmin:30', type: 'Run', start_date_local: '2026-10-20T07:31:00',
      moving_time: 3000, icu_athlete_id: 'i15487', paired_event_id: 9999,
    };
    dayListByDay = { '2026-10-18': [activitiesById.i830] };
    r = await request(baseUrl, { ...baseBody(), plan_event_id: '5001' });
    assert.equal(r.status, 409);
    assert.equal(r.body.error, 'activity_paired_to_other_plan');
    assert.equal(posts().length, 0);
    assert.equal(puts().length, 0);
    dayListByDay = null;
    console.log('ok - an activity paired to another plan is not re-paired (409)');

    // 7c8. Название до 200 символов (как на сайте): 200 проходит, 201 — 400 invalid_body.
    reset();
    r = await request(baseUrl, { ...baseBody(), name: 'н'.repeat(200) });
    assert.equal(r.status, 200);
    assert.equal(JSON.parse(posts()[0].body).name.length, 200);
    reset();
    r = await request(baseUrl, { ...baseBody(), name: 'н'.repeat(201) });
    assert.equal(r.status, 400);
    assert.equal(r.body.field, 'name');
    assert.equal(posts().length, 0);
    console.log('ok - name limit is 200 characters like on the site');

    // 8. Чужой и несуществующий план -> 404 plan_not_found, без POST.
    reset();
    for (const planId of ['5003', '9999']) {
      r = await request(baseUrl, { ...baseBody(), plan_event_id: planId });
      assert.equal(r.status, 404, planId);
      assert.deepEqual(r.body, { ok: false, error: 'plan_not_found' });
    }
    assert.equal(posts().length, 0);
    assert.equal(lists().length, 0, 'plan check precedes the day list');
    console.log('ok - foreign / missing plan -> 404 plan_not_found, no list, no POST');

    // 9. Привязки нет в ответе POST: один PUT; сбой PUT -> paired:false, повтор находит и привязывает без второго POST.
    reset();
    createPairs = false;
    r = await request(baseUrl, { ...baseBody(), plan_event_id: '5001' });
    assert.equal(r.status, 200);
    assert.equal(r.body.created, true);
    assert.equal(r.body.paired, true);
    assert.equal(posts().length, 1);
    assert.equal(puts().length, 1);
    assert.deepEqual(JSON.parse(puts()[0].body), { paired_event_id: 5001 });
    assert.equal(r.body.activity.paired_event_id, 5001);

    reset();
    createPairs = false;
    putStatus = 500;
    r = await request(baseUrl, { ...baseBody(), plan_event_id: '5001' });
    // Сбой PUT не проглатывается: честный 502 (активность создана, повтор допишет привязку).
    assert.equal(r.status, 502);
    assert.equal(r.body.ok, false);
    assert.equal(posts().length, 1);
    assert.equal(puts().length, 1, 'one PUT only');
    // 429 на PUT: 429 с Retry-After.
    reset();
    createPairs = false;
    putStatus = 429;
    retryAfterHeader = '7';
    r = await request(baseUrl, { ...baseBody(), plan_event_id: '5001' });
    assert.equal(r.status, 429);
    assert.equal(r.body.retry_after_ms, 7000);
    assert.equal(posts().length, 1);
    retryAfterHeader = null;
    reset();
    createPairs = false;
    putStatus = 500;
    r = await request(baseUrl, { ...baseBody(), plan_event_id: '5001' });
    assert.equal(r.status, 502);
    // Повтор с тем же ключом: активность найдена по external_id, привязываем PUT-ом, второго POST нет.
    putStatus = null;
    r = await request(baseUrl, { ...baseBody(), plan_event_id: '5001' });
    assert.equal(r.status, 200);
    assert.equal(r.body.created, false);
    assert.equal(r.body.reason, 'external_id');
    assert.equal(r.body.paired, true);
    assert.equal(posts().length, 1, 'repeat must not POST again');
    assert.equal(puts().length, 2);

    // PUT ответил, но привязки так и нет -> paired:false.
    reset();
    createPairs = false;
    putPairs = false;
    r = await request(baseUrl, { ...baseBody(), plan_event_id: '5001' });
    // PUT 2xx без привязки: незавершённый шаг, 502 (не ok:true), повтор допишет связь.
    assert.equal(r.status, 502);
    assert.notEqual(r.body.ok, true);
    assert.equal(posts().length, 1);
    assert.equal(puts().length, 1);
    console.log('ok - missing pairing -> one PUT; PUT failure is an honest 502/429; repeat pairs without a second POST');

    // Ответ POST массивом / без id.
    reset();
    postResponseShape = 'array';
    r = await request(baseUrl, baseBody());
    assert.equal(r.status, 200);
    assert.equal(r.body.activity.id, 'i900');
    reset();
    postResponseShape = 'noid';
    r = await request(baseUrl, baseBody());
    assert.equal(r.status, 502);
    assert.deepEqual(r.body, { ok: false, error: 'upstream_error' });
    assert.equal(posts().length, 1);
    console.log('ok - POST response as array works; response without id -> 502');

    // 10. Два одинаковых запроса одновременно -> один POST manual.
    reset();
    postDelayMs = 80;
    const [a, b] = await Promise.all([
      request(baseUrl, { ...baseBody(), plan_event_id: '5001' }),
      request(baseUrl, { ...baseBody(), plan_event_id: '5001' }),
    ]);
    assert.equal(a.status, 200);
    assert.equal(b.status, 200);
    assert.equal(posts().length, 1, 'concurrent identical requests share one POST');
    assert.equal(lists().length, 1);
    assert.deepEqual(a.body, b.body);
    assert.equal(a.body.created, true);
    // После завершения ключ свободен: следующий запрос видит созданную активность и не создаёт.
    r = await request(baseUrl, { ...baseBody(), plan_event_id: '5001' });
    assert.equal(r.body.created, false);
    assert.equal(posts().length, 1);
    console.log('ok - concurrent identical requests -> exactly one POST manual, same response');

    // 11. Ошибки Intervals; POST никогда не повторяется.
    reset();
    postStatus = 429;
    retryAfterHeader = '7';
    r = await request(baseUrl, baseBody());
    assert.equal(r.status, 429);
    assert.equal(r.headers.get('retry-after'), '7');
    assert.deepEqual(r.body, { ok: false, error: 'rate_limited', retry_after_ms: 7000 });
    assert.equal(posts().length, 1);

    reset();
    postStatus = 500;
    r = await request(baseUrl, baseBody());
    assert.equal(r.status, 502);
    assert.deepEqual(r.body, { ok: false, error: 'upstream_error' });
    assert.equal(posts().length, 1);

    reset();
    postThrows = true;
    r = await request(baseUrl, baseBody());
    assert.equal(r.status, 502);
    assert.deepEqual(r.body, { ok: false, error: 'upstream_error' });
    assert.equal(posts().length, 1);

    for (const status of [401, 403]) {
      reset();
      postStatus = status;
      r = await request(baseUrl, baseBody());
      assert.equal(r.status, 401, `Intervals ${status}`);
      assert.equal(r.body.error, 'auth_required');
      assert.equal(posts().length, 1);
    }

    reset();
    postStatus = 422;
    r = await request(baseUrl, baseBody());
    assert.equal(r.status, 422);
    assert.deepEqual(r.body, { ok: false, error: 'rejected', status: 422 });
    assert.equal(posts().length, 1);

    reset();
    listStatus = 429;
    retryAfterHeader = '3';
    r = await request(baseUrl, baseBody());
    assert.equal(r.status, 429);
    assert.equal(r.body.retry_after_ms, 3000);
    assert.equal(posts().length, 0, 'failed list never leads to a create');
    console.log('ok - 429 (Retry-After) / 5xx / network / 401 / 422 mapped; POST is never repeated');

    // 12. Маршрута нет в схеме GPT Actions.
    const actionsSchema = fs.readFileSync(path.resolve(__dirname, '..', 'openapi.actions.json'), 'utf8');
    assert.equal(actionsSchema.includes('/activities/manual'), false);
    assert.equal(actionsSchema.includes('activities/manual'), false);
    console.log('ok - route is absent from openapi.actions.json');
  } finally {
    live.close();
    global.fetch = originalFetch;
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
