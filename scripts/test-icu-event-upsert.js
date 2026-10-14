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
const attachIcuPostDryRun = require('../lib/icu_post_dryrun');

const originalFetch = global.fetch;
let localOrigin = '';
let store = [];
let nextId = 1000;
let calls = [];
let upstreamBodies = []; // тела записей, ушедших в Intervals (POST /events и bulk)
let bulkMode = 'normal'; // 'normal' | 'nonarray' | 'short' (на строку меньше) | 'noid' (первая строка без id)
let bulkFail = null; // { status, retryAfter }: bulk upsert отвечает ошибкой Intervals
let bulkAsOtherEntry = false; // имитация другого способа входа: bulk upsert не видит чужой external_id и создаёт новое событие

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
    upstreamBodies.push(body);
    const ev = { id: nextId++, ...body };
    store.push(ev);
    return jsonResponse(ev, 201);
  }
  if (parsed.pathname === `${base}/bulk` && method === 'POST') {
    calls.push({ method, path: parsed.pathname, upsert: parsed.searchParams.get('upsert') });
    if (bulkFail) {
      const failed = jsonResponse({ error: 'icu says no' }, bulkFail.status);
      failed.headers.get = (n) => (String(n).toLowerCase() === 'retry-after' ? bulkFail.retryAfter ?? null : null);
      return failed;
    }
    assert.equal(parsed.searchParams.get('upsert'), 'true');
    const body = JSON.parse(options.body);
    assert.ok(Array.isArray(body));
    upstreamBodies.push(...body);
    const out = body.map((incoming) => {
      const found = bulkAsOtherEntry ? undefined : store.find((e) => e.external_id && e.external_id === incoming.external_id);
      if (found) {
        Object.assign(found, incoming, { id: found.id });
        return { ...found };
      }
      const ev = { id: nextId++, ...incoming };
      store.push(ev);
      return { ...ev };
    });
    if (bulkMode === 'nonarray') return jsonResponse({ ok: true });
    if (bulkMode === 'short') return jsonResponse(out.slice(0, -1));
    if (bulkMode === 'noid') return jsonResponse(out.map((r, i) => (i === 0 ? { external_id: r.external_id } : r)));
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
  return { status: response.status, retryAfter: response.headers.get('retry-after'), body: await response.json() };
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
  upstreamBodies = [];
  bulkAsOtherEntry = false;
  bulkMode = 'normal';
  bulkFail = null;
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
      { ok: r.body.ok, dry_run: r.body.dry_run, created: r.body.created, updated: r.body.updated, duplicated: r.body.duplicated, unconfirmed: r.body.unconfirmed, unconfirmed_external_ids: r.body.unconfirmed_external_ids, skipped: r.body.skipped, errors: r.body.errors },
      { ok: true, dry_run: false, created: 1, updated: 0, duplicated: 0, unconfirmed: 0, unconfirmed_external_ids: [], skipped: 0, errors: [] },
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
    assert.equal(r.body.duplicated, 0);
    assert.equal(r.body.unconfirmed, 0);
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
    assert.equal(r.body.unconfirmed, 0);
    assert.equal(r.body.skipped, 0);
    assert.equal(store.length, 2);
    assert.equal(store.find((e) => e.external_id === 'note:custom-1').id, noteId);
    assert.equal(r.body.icu.length, 2);

    // Событие существует, а bulk вернул ДРУГОЙ id (другой способ входа) -> duplicated:1, updated:0
    reset();
    await post(baseUrl, '?dry_run=false', [ev(3)]);
    assert.equal(store.length, 1);
    bulkAsOtherEntry = true;
    r = await post(baseUrl, '?dry_run=false', [ev(3, { description: 'v2' })]);
    assert.equal(r.status, 200);
    assert.equal(r.body.created, 0);
    assert.equal(r.body.updated, 0);
    assert.equal(r.body.duplicated, 1);
    assert.equal(r.body.unconfirmed, 0);
    assert.equal(r.body.skipped, 0);
    assert.equal(store.length, 2, 'the mock really created a duplicate');
    bulkAsOtherEntry = false;

    // Известное ограничение: событие вне окна чтения (перенесено с +120 на +3 дня), upsert обновил его
    // по external_id, но в карте предварительного чтения его нет -> считается created:1.
    reset();
    await post(baseUrl, '?dry_run=false', [ev(120, { external_id: 'plan:moved-run' })]);
    const movedId = store[0].id;
    r = await post(baseUrl, '?dry_run=false', [ev(3, { external_id: 'plan:moved-run' })]);
    assert.equal(r.status, 200);
    assert.equal(r.body.created, 1, 'known limitation: out-of-window update counts as created');
    assert.equal(r.body.updated, 0);
    assert.equal(r.body.duplicated, 0);
    assert.equal(r.body.unconfirmed, 0);
    assert.equal(store.length, 1, 'but it is not a duplicate');
    assert.equal(store[0].id, movedId);

    // Неподтверждённая запись не выдаётся за успех: ответ не массив / короче пакета / строка без id.
    reset();
    bulkMode = 'nonarray';
    r = await post(baseUrl, '?dry_run=false', [ev(3), ev(4)]);
    assert.equal(r.status, 200);
    assert.equal(r.body.ok, true);
    assert.deepEqual(
      [r.body.created, r.body.updated, r.body.duplicated, r.body.unconfirmed, r.body.errors],
      [0, 0, 0, 2, []],
    );
    assert.deepEqual(r.body.unconfirmed_external_ids, [ev(3).external_id, ev(4).external_id]);

    reset();
    bulkMode = 'short';
    r = await post(baseUrl, '?dry_run=false', [ev(3), ev(4), ev(5)]);
    assert.equal(r.status, 200);
    assert.equal(r.body.ok, true);
    assert.deepEqual([r.body.created, r.body.updated, r.body.unconfirmed], [2, 0, 1]);
    assert.deepEqual(r.body.unconfirmed_external_ids, [ev(5).external_id]);

    reset();
    bulkMode = 'noid';
    r = await post(baseUrl, '?dry_run=false', [ev(3), ev(4)]);
    assert.equal(r.status, 200);
    assert.equal(r.body.ok, true);
    assert.deepEqual([r.body.created, r.body.updated, r.body.unconfirmed], [1, 0, 1]);
    assert.deepEqual(r.body.unconfirmed_external_ids, [ev(3).external_id]);

    // external_id без префикса plan:/note: в upsert -> 400, в Intervals ничего не уходит
    for (const bad of ['race:2026-10-20-marathon', 'foo']) {
      reset();
      r = await post(baseUrl, '?dry_run=false', [ev(3), ev(4, { external_id: bad })]);
      assert.equal(r.status, 400);
      assert.deepEqual(r.body, { error: 'bad_request', message: 'external_id must start with plan: or note:' });
      assert.equal(calls.length, 0, 'nothing must reach Intervals');
      assert.equal(store.length, 0);
    }
    // dedupe=false и dry_run префикс не проверяют
    reset();
    r = await post(baseUrl, '?dry_run=false&dedupe=false', [ev(3, { external_id: 'race:x' })]);
    assert.equal(r.status, 200);
    r = await post(baseUrl, '?dry_run=true', [ev(3, { external_id: 'foo' })]);
    assert.equal(r.status, 200);

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

    // Ошибки Intervals на записи: 429 с Retry-After и отказ 422 идут наверх своим статусом, не 502.
    reset();
    bulkFail = { status: 429, retryAfter: '12' };
    r = await post(baseUrl, '?dry_run=false', [ev(3)]);
    assert.equal(r.status, 429);
    assert.equal(r.retryAfter, '12');
    assert.equal(r.body.retry_after_ms, 12000);
    bulkFail = { status: 422, retryAfter: null };
    r = await post(baseUrl, '?dry_run=false', [ev(3)]);
    assert.equal(r.status, 422);
    assert.equal(r.retryAfter, null);
    assert.equal(r.body.retry_after_ms, undefined);
    assert.equal(store.length, 0, 'failed upsert writes nothing');


    // id в теле события не доходит до Intervals (иначе правка произвольного события в обход защиты)
    reset();
    r = await post(baseUrl, '?dry_run=false', [ev(3, { id: 123 })]);
    assert.equal(r.status, 200);
    assert.equal(upstreamBodies.length, 1);
    assert.equal('id' in upstreamBodies[0], false, 'upsert body has no id');
    assert.notEqual(store[0].id, 123);
    reset();
    r = await post(baseUrl, '?dry_run=false&dedupe=false', [ev(3, { id: 123 })]);
    assert.equal(r.status, 200);
    assert.equal(upstreamBodies.length, 1);
    assert.equal('id' in upstreamBodies[0], false, 'create body has no id');
    // dry run и preview: в ответе тоже без id
    r = await post(baseUrl, '?dry_run=true', [ev(3, { id: 123 })]);
    assert.equal('id' in r.body.events[0], false);
    const previewResponse = await originalFetch(`${baseUrl}/gw/icu/events/preview`, {
      method: 'POST',
      headers: { Authorization: 'Bearer intervals-access-token', 'Content-Type': 'application/json' },
      body: JSON.stringify({ events: [ev(3, { id: 123 })] }),
    });
    assert.equal(previewResponse.status, 200);
    assert.equal('id' in (await previewResponse.json()).events[0], false, 'preview output has no id');
    // отдельный модуль icu_post_dryrun: тот же запрет
    const dryApp = express();
    dryApp.use('/gw', bearerUid());
    attachIcuPostDryRun(dryApp);
    const dryServer = await new Promise((resolve) => { const s2 = dryApp.listen(0, '127.0.0.1', () => resolve(s2)); });
    try {
      localOrigin = `http://127.0.0.1:${dryServer.address().port}`;
      const dryResponse = await originalFetch(`${localOrigin}/gw/icu/events?dry_run=true`, {
        method: 'POST',
        headers: { Authorization: 'Bearer intervals-access-token', 'Content-Type': 'application/json' },
        body: JSON.stringify({ events: [ev(3, { id: 123 })] }),
      });
      assert.equal(dryResponse.status, 200);
      assert.equal('id' in (await dryResponse.json()).events[0], false, 'icu_post_dryrun output has no id');
    } finally {
      dryServer.close();
      localOrigin = baseUrl;
    }
    console.log('ok - an id in the event body is dropped before Intervals and in previews');
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
