#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const express = require('express');

process.env.STAS_KEY = process.env.STAS_KEY || 'test-stas-key';
process.env.STAS_BASE = process.env.STAS_BASE || 'http://stas.local.test';

const bearerUid = require('../routes/_bearer_uid');
const icu = require('../routes/icu');
const attachDelete = require('../lib/attach_delete');
const { requestIdIngress } = require('../lib/request-id');
const requestAuthTesting = require('../lib/request-auth').__testing;

const originalFetch = global.fetch;
let localOrigin = '';
const upstreamHits = [];
let eventsListRetryAfter = null;
let eventsListStatus = null; // статус отказа Intervals на чтении событий (листинг)
// Ответ мок-Intervals на bulk-delete; тесты частичного удаления подменяют его.
let bulkDeleteResponder = (body) => {
  assert.deepEqual(body, [{ id: 116577024 }]);
  return jsonResponse({ deleted_ids: [116577024] });
};
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
    assert.equal(parsed.searchParams.get('user_id'), null);
    assert.equal(parsed.searchParams.get('uid'), null);
    if (eventsListStatus) {
      const refused = jsonResponse({ error: 'listing refused' }, eventsListStatus);
      refused.headers.get = (name) => (String(name).toLowerCase() === 'retry-after' ? eventsListRetryAfter : null);
      return refused;
    }
    return jsonResponse(broadCalendar);
  }

  if (parsed.origin === 'https://intervals.icu' && parsed.pathname === '/api/v1/athlete/0/events/bulk-delete') {
    return bulkDeleteResponder(JSON.parse(options.body || '[]'));
  }

  return jsonResponse({ error: 'unexpected_upstream', url: parsed.toString() }, 500);
};

function makeApp() {
  const app = express();
  app.use(requestIdIngress);
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
    retryAfter: response.headers.get('retry-after'),
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
      '/gw/icu/events/delete-preview?external_id_prefix=test%3A&oldest=2026-06-18&newest=2026-06-19&user_id=999&uid=888',
    );
    assert.equal(response.status, 200);
    assert.equal(response.body.dry_run, true);
    assert.equal(response.body.uid, '15487');
    assert.deepEqual(response.body.to_delete.ids, ['116577024']);
    assert.equal(
      upstreamHits.some(hit => new URL(hit.url).pathname === '/api/v1/athlete/0/events/bulk-delete'),
      false,
      'delete preview must not call bulk-delete',
    );

    response = await request(
      baseUrl,
      '/gw/icu/events?external_id_prefix=test%3A&oldest=2026-06-18&newest=2026-06-19&dry_run=true&user_id=999&uid=888',
      { method: 'DELETE' },
    );
    assert.equal(response.status, 200);
    assert.equal(response.body.dry_run, true);
    assert.equal(response.body.uid, '15487');
    assert.deepEqual(response.body.to_delete.ids, ['116577024']);

    response = await request(
      baseUrl,
      '/gw/icu/events?external_id=test%3Awrite-check%3A2026-06-18&oldest=2026-06-18&newest=2026-06-19&dry_run=true&user_id=999',
      { method: 'DELETE' },
    );
    assert.equal(response.status, 200);
    assert.equal(response.body.uid, '15487');
    assert.deepEqual(response.body.to_delete.ids, ['116577024']);

    response = await request(
      baseUrl,
      '/gw/icu/events?external_id_prefix=test%3A&oldest=2026-06-18&newest=2026-06-19&dry_run=false&user_id=999',
      { method: 'DELETE' },
    );
    assert.equal(response.status, 200);
    assert.equal(response.body.deleted_count, 1);
    assert.deepEqual(response.body.deleted_ids, ['116577024']);

    const deleteHit = upstreamHits.find(hit => new URL(hit.url).pathname === '/api/v1/athlete/0/events/bulk-delete');
    assert.ok(deleteHit, 'expected bulk-delete call');

    console.log('ok - delete dry-run and real delete are filtered by external_id');

    // Полное удаление нескольких событий: ok:true, failed пуст.
    const planDelete = '/gw/icu/events?external_id_prefix=plan%3A&oldest=2026-06-18&newest=2026-06-19&dry_run=false';
    bulkDeleteResponder = (body) => {
      assert.deepEqual(body, [{ id: 116274129 }, { id: 116274131 }, { id: 116274133 }]);
      return jsonResponse({ deleted_ids: [116274129, 116274131, 116274133] });
    };
    response = await request(baseUrl, planDelete, { method: 'DELETE' });
    assert.equal(response.status, 200);
    assert.equal(response.body.ok, true);
    assert.equal(response.body.deleted_count, 3);
    assert.deepEqual(response.body.deleted_ids, ['116274129', '116274131', '116274133']);
    assert.deepEqual(response.body.failed, []);
    assert.equal(response.body.error, undefined);
    console.log('ok - full delete reports ok:true and empty failed');

    // 200, но Intervals вернул не все id: неудалённые в failed, ok не true.
    bulkDeleteResponder = () => jsonResponse({ deleted_ids: [116274129] });
    response = await request(baseUrl, planDelete, { method: 'DELETE' });
    assert.equal(response.status, 200);
    assert.equal(response.body.ok, false);
    assert.equal(response.body.error, 'delete_incomplete');
    assert.equal(response.body.deleted_count, 1);
    assert.deepEqual(response.body.deleted_ids, ['116274129']);
    assert.deepEqual(response.body.failed, [
      { id: '116274131', status: 200, reason: 'not_deleted_by_intervals' },
      { id: '116274133', status: 200, reason: 'not_deleted_by_intervals' },
    ]);
    console.log('ok - partial delete (deleted_ids) puts missing ids into failed');

    // 200 только со счётчиком, 0 < счётчик < запрошенного: какие удалились — неизвестно.
    bulkDeleteResponder = () => jsonResponse({ deleted_count: 1 });
    response = await request(baseUrl, planDelete, { method: 'DELETE' });
    assert.equal(response.body.ok, false);
    assert.equal(response.body.error, 'delete_unconfirmed');
    assert.equal(response.body.deleted_count, 1);
    assert.equal(response.body.requested_count, 3);
    assert.deepEqual(response.body.unconfirmed_ids, ['116274129', '116274131', '116274133']);
    assert.deepEqual(response.body.failed, []);
    console.log('ok - partial delete (count only) reports unconfirmed_ids, not failed');

    // Счётчик 0: точно ничего не удалено, все id в failed.
    bulkDeleteResponder = () => jsonResponse(0);
    response = await request(baseUrl, planDelete, { method: 'DELETE' });
    assert.equal(response.body.ok, false);
    assert.equal(response.body.error, 'delete_incomplete');
    assert.equal(response.body.deleted_count, 0);
    assert.equal(response.body.unconfirmed_ids, undefined);
    assert.deepEqual(response.body.failed.map(item => item.id), ['116274129', '116274131', '116274133']);
    assert.ok(response.body.failed.every(item => item.reason === 'not_deleted_by_intervals'));
    console.log('ok - count 0 puts all ids into failed');

    // Только счётчик, равный запрошенному: как раньше, ok:true.
    bulkDeleteResponder = () => jsonResponse(3);
    response = await request(baseUrl, planDelete, { method: 'DELETE' });
    assert.equal(response.body.ok, true);
    assert.equal(response.body.deleted_count, 3);
    assert.deepEqual(response.body.failed, []);
    console.log('ok - full delete (count only) stays ok:true');

    // Ошибка запроса: ok:false, все id в failed со статусом ответа, без reason.
    bulkDeleteResponder = () => jsonResponse({ error: 'boom' }, 500);
    response = await request(baseUrl, planDelete, { method: 'DELETE' });
    assert.equal(response.body.ok, false);
    assert.equal(response.body.error, undefined);
    assert.deepEqual(response.body.failed, [
      { id: '116274129', status: 500 },
      { id: '116274131', status: 500 },
      { id: '116274133', status: 500 },
    ]);
    console.log('ok - upstream error keeps previous failed shape');

    // Отказ запроса (422): статус каждого id остаётся в failed, ответ шлюза прежний.
    bulkDeleteResponder = () => jsonResponse({ error: 'bad' }, 422);
    response = await request(baseUrl, planDelete, { method: 'DELETE' });
    assert.equal(response.status, 422, 'rejection status is kept');
    assert.equal(response.body.ok, false);
    assert.ok(response.body.failed.every(item => item.status === 422), 'existing failed[] fields are kept');
    assert.equal(response.body.dry_run, false);

    // Отказ 422 на листинге: id (external_id) и префикс - тот же статус, не 500/502.
    eventsListStatus = 422;
    const exactDelete = '/gw/icu/events?external_id=plan%3A2026-06-18%3Aeasy-run&oldest=2026-06-18&newest=2026-06-19&dry_run=false';
    response = await request(baseUrl, exactDelete, { method: 'DELETE' });
    assert.equal(response.status, 422, 'external_id lookup keeps the rejection status');
    assert.deepEqual(response.body, { ok: false, error: 'events_fetch_failed', status: 422 });
    response = await request(baseUrl, planDelete, { method: 'DELETE' });
    assert.equal(response.status, 422, 'prefix lookup keeps the rejection status');
    assert.deepEqual(response.body, { ok: false, error: 'events_fetch_failed', status: 422 });
    eventsListStatus = 500;
    response = await request(baseUrl, planDelete, { method: 'DELETE' });
    assert.equal(response.status, 502, '5xx on lookup stays 502');
    eventsListStatus = null;
    console.log('ok - 422 from Intervals keeps its status for bulk-delete, external_id and prefix lookups');

    // Лимит Intervals: честный 429 с Retry-After, тело с failed сохранено.
    bulkDeleteResponder = () => {
      const limited = jsonResponse({ error: 'slow down' }, 429);
      limited.headers.get = (name) => (String(name).toLowerCase() === 'retry-after' ? '9' : null);
      return limited;
    };
    response = await request(baseUrl, planDelete, { method: 'DELETE' });
    assert.equal(response.status, 429);
    assert.equal(response.retryAfter, '9');
    assert.equal(response.body.ok, false);
    assert.equal(response.body.error, 'rate_limited');
    assert.equal(response.body.retry_after_ms, 9000);
    assert.deepEqual(response.body.failed.map(item => item.status), [429, 429, 429]);
    console.log('ok - Intervals 429 -> HTTP 429 with Retry-After, failed list kept');

    // Внутренние запросы к нашему же GET /gw/icu/events несут проверенный источник, id запроса и номер попытки;
    // X-API-Key - только если исходный вызов был серверным вызовом STAS.
    const attempts = () => upstreamHits
      .filter(hit => new URL(hit.url).pathname === '/api/db/intervals-attempts')
      .map(hit => ({ ...JSON.parse(hit.body), _headers: hit.headers }));
    const requestId = '22222222-3333-4444-8555-666666666666';
    const hopRequest = (headers) => request(baseUrl, planDelete, { method: 'DELETE', headers });
    bulkDeleteResponder = () => jsonResponse({ deleted_ids: [116274129, 116274131, 116274133] });
    for (const asStas of [true, false]) {
      requestAuthTesting.clearDirectTokenCache();
      upstreamHits.length = 0;
      response = await hopRequest({
        'x-stas-source': 'site',
        'x-stas-attempt': '4',
        'x-stas-request-id': requestId,
        ...(asStas ? { 'X-API-Key': process.env.STAS_KEY } : {}),
      });
      assert.equal(response.status, 200);
      await new Promise(resolve => setTimeout(resolve, 60));
      const records = attempts().filter(rec => rec.method === 'GET' && rec.path === '/api/v1/athlete/0/events');
      assert.equal(records.length, 1, 'the listing hop reached Intervals once');
      assert.equal(records[0].attempt_number, 4);
      assert.equal(records[0]._headers['x-stas-request-id'], requestId);
      assert.equal(records[0].initiator, asStas ? 'site' : 'gpt', "'site' only with the verified STAS key");
      const ensure = upstreamHits.filter(hit => new URL(hit.url).pathname === '/api/db/ensure-intervals-user');
      assert.equal(ensure.length, asStas ? 0 : 1, 'STAS server call skips ensure-intervals-user on the hop');
      if (!asStas) assert.equal(JSON.parse(ensure[0].body).source, 'gpt');
    }
    // GET /gw/icu/events при 429 Intervals: Retry-After и retry_after_ms в теле; успех не меняется.
    eventsListStatus = 429;
    eventsListRetryAfter = '6';
    response = await request(baseUrl, '/gw/icu/events?days=7');
    assert.equal(response.status, 429);
    assert.equal(response.retryAfter, '6');
    assert.equal(response.body.retry_after_ms, 6000);
    eventsListRetryAfter = '-1';
    response = await request(baseUrl, '/gw/icu/events?days=7');
    assert.equal(response.status, 429);
    assert.equal(response.retryAfter, null, 'invalid Retry-After is not forwarded');
    assert.equal(response.body.retry_after_ms, undefined);
    eventsListStatus = null;
    response = await request(baseUrl, '/gw/icu/events?days=7');
    assert.equal(response.status, 200);
    assert.deepEqual(response.body, broadCalendar);
    console.log('ok - GET events 429 carries Retry-After and retry_after_ms; success unchanged');

    console.log('ok - local hops forward source, request id, attempt number and the STAS key only for verified server calls');

    // Защита событий «Болезнь / травма / поездка»: по окну и по external_id не удаляются, только по id.
    broadCalendar.push(
      { id: 200001, external_id: 'note:2026-06-20:range-sick-a1', category: 'SICK', name: 'Sick' },
      { id: 200002, external_id: 'note:2026-06-20:day-note', category: 'NOTE', name: 'Plain note' },
      { id: 200003, external_id: 'note:2026-06-21:injury-knee', category: 'INJURED', name: 'Injured' },
      { id: 200004, external_id: 'note:2026-06-22:range-trip-b2', category: 'NOTE', name: 'Range key only' },
      { id: 200005, external_id: 'note:2026-06-23:trip', category: 'HOLIDAY', name: 'Trip' },
    );
    const protectedIds = ['200001', '200003', '200004', '200005'];
    const rangeReason = 'calendar_range_event_delete_by_id_only';
    const noteWindow = 'external_id_prefix=note%3A&oldest=2026-06-20&newest=2026-06-23';
    const upstreamBulkCalls = () => upstreamHits.filter(hit => new URL(hit.url).pathname === '/api/v1/athlete/0/events/bulk-delete');

    response = await request(baseUrl, `/gw/icu/events/delete-preview?${noteWindow}`);
    assert.equal(response.status, 200);
    assert.deepEqual(response.body.to_delete.ids, ['200002']);
    assert.deepEqual(response.body.protected, { count: 4, ids: protectedIds, reason: rangeReason });

    response = await request(baseUrl, `/gw/icu/events?${noteWindow}&dry_run=true`, { method: 'DELETE' });
    assert.deepEqual(response.body.to_delete.ids, ['200002']);
    assert.deepEqual(response.body.protected.ids, protectedIds);

    bulkDeleteResponder = (body) => {
      assert.deepEqual(body, [{ id: 200002 }]);
      return jsonResponse({ deleted_ids: [200002] });
    };
    response = await request(baseUrl, `/gw/icu/events?${noteWindow}&dry_run=false`, { method: 'DELETE' });
    assert.equal(response.body.ok, true);
    assert.deepEqual(response.body.deleted_ids, ['200002']);
    assert.deepEqual(response.body.failed, []);
    assert.deepEqual(response.body.protected, { count: 4, ids: protectedIds, reason: rangeReason });
    console.log('ok - prefix window delete skips SICK/INJURED/HOLIDAY and range- events');

    // Окно, где есть только защищённые события: удалять нечего, Intervals не вызываем.
    const bulkCallsBefore = upstreamBulkCalls().length;
    response = await request(
      baseUrl,
      '/gw/icu/events?external_id_prefix=note%3A2026-06-21%3A&oldest=2026-06-21&newest=2026-06-21&dry_run=false',
      { method: 'DELETE' },
    );
    assert.equal(response.body.ok, true);
    assert.equal(response.body.deleted_count, 0);
    assert.deepEqual(response.body.deleted_ids, []);
    assert.deepEqual(response.body.failed, []);
    assert.deepEqual(response.body.protected, { count: 1, ids: ['200003'], reason: rangeReason });
    assert.equal(upstreamBulkCalls().length, bulkCallsBefore, 'protected-only delete must not call bulk-delete');

    // Точный external_id события с range-ключом / SICK не удаляет его.
    response = await request(
      baseUrl,
      '/gw/icu/events?external_id=note%3A2026-06-20%3Arange-sick-a1&dry_run=false',
      { method: 'DELETE' },
    );
    assert.equal(response.body.ok, true);
    assert.equal(response.body.deleted_count, 0);
    assert.deepEqual(response.body.protected, { count: 1, ids: ['200001'], reason: rangeReason });
    assert.equal(upstreamBulkCalls().length, bulkCallsBefore, 'exact external_id must not delete range events');

    response = await request(
      baseUrl,
      '/gw/icu/events?external_ids=note%3A2026-06-20%3Arange-sick-a1,note%3A2026-06-20%3Aday-note&dry_run=true',
      { method: 'DELETE' },
    );
    assert.deepEqual(response.body.to_delete.ids, ['200002']);
    assert.deepEqual(response.body.protected.ids, ['200001']);
    console.log('ok - exact external_id delete skips range events');

    // Явный id события болезни удаляется как раньше, без поля protected.
    bulkDeleteResponder = (body) => {
      assert.deepEqual(body, [{ id: 200001 }]);
      return jsonResponse({ deleted_ids: [200001] });
    };
    response = await request(baseUrl, '/gw/icu/events?id=200001&dry_run=false', { method: 'DELETE' });
    assert.equal(response.body.ok, true);
    assert.deepEqual(response.body.deleted_ids, ['200001']);
    assert.equal(response.body.protected, undefined);
    console.log('ok - explicit id still deletes a SICK event');
  } finally {
    server.close();
    global.fetch = originalFetch;
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
