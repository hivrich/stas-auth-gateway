#!/usr/bin/env node
'use strict';

// POST /gw/icu/events: событие с уже существующим external_id обновляется (id сохраняется),
// а не пропускается и не дублируется, в том числе вне окна сегодня -7..+60.
// Intervals.icu мокается как API: GET /events (окно oldest..newest), POST /events,
// POST /events/bulk?upsert=true (сопоставление по external_id независимо от даты).

const assert = require('node:assert/strict');
const express = require('express');

process.env.STAS_KEY = 'test-stas-key';
process.env.STAS_BASE = 'http://stas.local.test';

const bearerUid = require('../routes/_bearer_uid');
const attachIcuPostExact = require('../lib/icu_post_exact');

const originalFetch = global.fetch;
let localOrigin = '';
let store = [];
let nextId = 1000;
let calls = [];

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

function dayOffset(days) {
  return new Date(Date.now() + days * 86400 * 1000).toISOString().slice(0, 10);
}

global.fetch = async (url, options = {}) => {
  const parsed = new URL(url.toString());
  if (parsed.origin === localOrigin) return originalFetch(url, options);

  const method = options.method || 'GET';
  if (parsed.origin === 'http://stas.local.test' && parsed.pathname === '/api/db/ensure-intervals-user') {
    return jsonResponse({ ok: true });
  }
  if (parsed.origin === 'https://intervals.icu' && parsed.pathname === '/api/v1/athlete/0') {
    return jsonResponse({ id: '15487', name: 'Test Athlete' });
  }
  if (parsed.origin !== 'https://intervals.icu') {
    return jsonResponse({ error: 'unexpected_upstream', url: parsed.toString() }, 500);
  }

  const base = '/api/v1/athlete/0/events';
  if (parsed.pathname === base && method === 'GET') {
    calls.push({ method, path: parsed.pathname });
    const oldest = parsed.searchParams.get('oldest');
    const newest = parsed.searchParams.get('newest');
    return jsonResponse(store.filter((e) => {
      const d = e.start_date_local.slice(0, 10);
      return (!oldest || d >= oldest) && (!newest || d <= newest);
    }));
  }
  if (parsed.pathname === base && method === 'POST') {
    calls.push({ method, path: parsed.pathname });
    const body = JSON.parse(options.body);
    const ev = { id: nextId++, ...body };
    store.push(ev);
    return jsonResponse(ev, 201);
  }
  if (parsed.pathname === `${base}/bulk` && method === 'POST') {
    calls.push({ method, path: parsed.pathname, upsert: parsed.searchParams.get('upsert') });
    assert.equal(parsed.searchParams.get('upsert'), 'true');
    const body = JSON.parse(options.body);
    assert.ok(Array.isArray(body));
    const out = body.map((incoming) => {
      const found = store.find((e) => e.external_id && e.external_id === incoming.external_id);
      if (found) {
        Object.assign(found, incoming, { id: found.id });
        return { ...found };
      }
      const ev = { id: nextId++, ...incoming };
      store.push(ev);
      return { ...ev };
    });
    return jsonResponse(out);
  }
  return jsonResponse({ error: 'unexpected_upstream', url: parsed.toString(), method }, 500);
};

async function post(baseUrl, query, events) {
  const response = await originalFetch(`${baseUrl}/gw/icu/events${query}`, {
    method: 'POST',
    headers: {
      Authorization: 'Bearer intervals-access-token',
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ events }),
  });
  return { status: response.status, body: await response.json() };
}

function ev(daysFromToday, extra = {}) {
  return {
    name: 'Easy run',
    category: 'WORKOUT',
    type: 'Run',
    start_date_local: `${dayOffset(daysFromToday)}T09:00:00`,
    external_id: `plan:${dayOffset(daysFromToday)}-easy-run`,
    description: 'v1',
    ...extra,
  };
}

function reset(initial = []) {
  store = initial.map((e) => ({ id: nextId++, ...e }));
  calls = [];
}

async function main() {
  const app = express();
  app.use('/gw', bearerUid());
  attachIcuPostExact(app);
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  localOrigin = baseUrl;

  try {
    // Новое событие -> created:1
    reset();
    let r = await post(baseUrl, '?dry_run=false', [ev(3)]);
    assert.equal(r.status, 200);
    assert.deepEqual(
      { ok: r.body.ok, dry_run: r.body.dry_run, created: r.body.created, updated: r.body.updated, skipped: r.body.skipped, errors: r.body.errors },
      { ok: true, dry_run: false, created: 1, updated: 0, skipped: 0, errors: [] },
    );
    assert.equal(r.body.reason, undefined);
    assert.equal(store.length, 1);
    const firstId = store[0].id;
    assert.equal(r.body.icu[0].id, firstId);

    // Повтор с тем же external_id и другим описанием -> обновление, тот же id, не дубль
    r = await post(baseUrl, '?dry_run=false', [ev(3, { description: 'v2' })]);
    assert.equal(r.status, 200);
    assert.equal(r.body.created, 0);
    assert.equal(r.body.updated, 1);
    assert.equal(r.body.skipped, 0);
    assert.equal(r.body.reason, undefined);
    assert.equal(store.length, 1, 'no duplicate');
    assert.equal(store[0].id, firstId, 'id preserved');
    assert.equal(store[0].description, 'v2', 'content updated');
    assert.equal(r.body.icu[0].id, firstId);

    // Событие через 120 дней (вне окна -7..+60): создание, затем правка -> обновление, не дубль
    reset();
    r = await post(baseUrl, '?dry_run=false', [ev(120)]);
    assert.equal(r.body.created, 1);
    const farId = store[0].id;
    r = await post(baseUrl, '?dry_run=false', [ev(120, { description: 'v2' })]);
    assert.equal(r.body.created, 0);
    assert.equal(r.body.updated, 1);
    assert.equal(r.body.skipped, 0);
    assert.equal(store.length, 1);
    assert.equal(store[0].id, farId);
    assert.equal(store[0].description, 'v2');

    // Событие 30 дней назад (вне окна -7..+60)
    reset();
    r = await post(baseUrl, '?dry_run=false', [ev(-30)]);
    assert.equal(r.body.created, 1);
    const pastId = store[0].id;
    r = await post(baseUrl, '?dry_run=false', [ev(-30, { name: 'Edited name' })]);
    assert.equal(r.body.created, 0);
    assert.equal(r.body.updated, 1);
    assert.equal(store.length, 1);
    assert.equal(store[0].id, pastId);
    assert.equal(store[0].name, 'Edited name');

    // Пакет: одно существующее + одно новое -> created:1, updated:1; пользовательский external_id без префикса plan:
    reset();
    await post(baseUrl, '?dry_run=false', [ev(5, { external_id: 'note:custom-1', category: 'NOTE', type: undefined })]);
    const noteId = store[0].id;
    r = await post(baseUrl, '?dry_run=false', [
      ev(5, { external_id: 'note:custom-1', category: 'NOTE', type: undefined, description: 'edited' }),
      ev(6),
    ]);
    assert.equal(r.body.created, 1);
    assert.equal(r.body.updated, 1);
    assert.equal(r.body.skipped, 0);
    assert.equal(store.length, 2);
    assert.equal(store.find((e) => e.external_id === 'note:custom-1').id, noteId);
    assert.equal(r.body.icu.length, 2);

    // dry_run (по умолчанию и явный) ничего не пишет и не читает
    for (const q of ['', '?dry_run=true']) {
      reset([ev(3)]);
      r = await post(baseUrl, q, [ev(3, { description: 'v2' }), ev(4)]);
      assert.equal(r.status, 200);
      assert.equal(r.body.dry_run, true);
      assert.equal(r.body.created, 0);
      assert.equal(r.body.skipped, 0);
      assert.equal(calls.length, 0, 'dry_run must not call Intervals');
      assert.equal(store.length, 1);
      assert.equal(store[0].description, 'v1');
    }

    // dedupe=false: прежнее поведение, всё создаётся POST-ом без поиска и upsert (дубли возможны)
    reset([ev(3)]);
    r = await post(baseUrl, '?dry_run=false&dedupe=false', [ev(3, { description: 'v2' })]);
    assert.equal(r.status, 200);
    assert.equal(r.body.created, 1);
    assert.equal(r.body.updated, 0);
    assert.equal(r.body.skipped, 0);
    assert.deepEqual(calls.map((c) => `${c.method} ${c.path}`), ['POST /api/v1/athlete/0/events']);
    assert.equal(store.length, 2);

    console.log('ok - events with an existing external_id are updated in place (id kept), inside and outside the default window');
  } finally {
    server.close();
    global.fetch = originalFetch;
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
