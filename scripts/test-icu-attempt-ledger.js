#!/usr/bin/env node
'use strict';

// Журнал попыток к Intervals.icu (lib/icu-attempt-ledger.js) и источник 'site' (lib/request-source.js).
// Мок fetch, без сети.
const assert = require('node:assert/strict');

delete process.env.STAS_KEY;
delete process.env.DB_BRIDGE_API_KEY;
process.env.STAS_BASE = 'http://stas.local.test';

const getStasKey = require('../lib/get_stas_key');
const { fetchIntervals, forwardRetryAfter, parseRetryAfter, parseRetryAfterMs } = require('../lib/icu-attempt-ledger');
const { icuListEventsWithAuth } = require('../lib/icu_write');
const { buildStasSourceHeaders, getRequestSource, normalizeSource } = require('../lib/request-source');

const originalFetch = global.fetch;
const sent = [];
let intervalsResponder = () => makeResponse({}, 200);
let ledgerResponder = () => makeResponse({ ok: true }, 202);

function makeResponse(body, status, headers = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (n) => headers[String(n).toLowerCase()] ?? null },
    json: async () => body,
    text: async () => JSON.stringify(body),
    clone() { return this; },
  };
}

global.fetch = async (url, options = {}) => {
  const parsed = new URL(url.toString());
  if (parsed.origin === 'http://stas.local.test') {
    sent.push({ path: parsed.pathname, headers: options.headers, body: JSON.parse(options.body), signal: options.signal });
    return ledgerResponder();
  }
  return intervalsResponder(parsed, options);
};

const settle = () => new Promise((resolve) => setTimeout(resolve, 40));
const fakeReq = (headers = {}, extra = {}) => ({
  headers,
  get: (name) => headers[String(name).toLowerCase()],
  ...extra,
});

async function main() {
  // Нет ключа STAS: отчёт пропускается, запрос пользователя идёт как обычно.
  if (!getStasKey()) {
    sent.length = 0;
    const resp = await fetchIntervals('https://intervals.icu/api/v1/athlete/0', { method: 'GET' }, {});
    assert.equal(resp.status, 200);
    await settle();
    assert.equal(sent.length, 0, 'no STAS key -> nothing is reported');
    console.log('ok - ledger skips reporting when the STAS key is missing');
  } else {
    console.log('skip - STAS key is configured on this host (missing-key case)');
  }

  process.env.STAS_KEY = 'test-stas-key';
  const record = () => sent[sent.length - 1].body;

  assert.equal(parseRetryAfterMs('5'), 5000);
  assert.equal(parseRetryAfterMs(' 0 '), 0);
  assert.equal(parseRetryAfterMs(new Date(Date.now() + 10000).toUTCString()) > 5000, true);
  assert.equal(parseRetryAfterMs(new Date(Date.now() - 10000).toUTCString()), 0);
  assert.equal(parseRetryAfterMs('soon'), null);
  assert.equal(parseRetryAfterMs(null), null);
  // Невалидные значения не разбираются: отрицательные, дробные, экспонента, нестандартные даты.
  for (const bad of ['-1', '1.5', '1e3', '+5', '0x10', '2026-10-20', 'Tue Oct 20 2026 10:00:00', 'Tue, 20 Oct 2026 10:00:00 +0200', '5 seconds']) {
    assert.equal(parseRetryAfterMs(bad), null, `"${bad}" is not a valid Retry-After`);
    assert.equal(parseRetryAfter(bad), null);
  }
  // forwardRetryAfter: заголовок и ms из одного числа; невалидное - ничего не пересылается.
  const fakeRes = () => { const headers = {}; return { headers, set: (k, v) => { headers[k] = v; } }; };
  for (const bad of ['-1', '1.5', '1e3', 'garbage', '99999999999999999999']) {
    const res = fakeRes();
    assert.equal(forwardRetryAfter(res, bad), null);
    assert.deepEqual(res.headers, {}, `"${bad}": nothing forwarded`);
  }
  const fwd = fakeRes();
  assert.equal(forwardRetryAfter(fwd, '172800'), 172800000);
  assert.deepEqual(fwd.headers, { 'Retry-After': '172800' });
  const fwdDate = fakeRes();
  const dateMs = forwardRetryAfter(fwdDate, new Date(Date.now() + 10 * 86400000).toUTCString());
  assert.equal(fwdDate.headers['Retry-After'], String(Math.ceil(dateMs / 1000)));
  assert.ok(Math.abs(dateMs - 864000000) < 2000);

  // Без суточного лимита: header и ms из одного числа. Переполнение (20 цифр) - невалидно.
  assert.deepEqual(parseRetryAfter('172800'), { header: '172800', ms: 172800000 });
  assert.equal(parseRetryAfter('99999999999999999999'), null);
  assert.equal(parseRetryAfter('1234567890'), null, 'more than 9 digits is invalid');
  assert.deepEqual(parseRetryAfter('999999999'), { header: '999999999', ms: 999999999000 });
  const now = Date.parse('2026-10-20T10:00:00Z');
  assert.deepEqual(parseRetryAfter('Fri, 30 Oct 2026 10:00:00 GMT', now), { header: '864000', ms: 864000000 });
  assert.deepEqual(parseRetryAfter('Tue, 20 Oct 2026 10:00:00 GMT', now), { header: '0', ms: 0 });
  assert.deepEqual(parseRetryAfter('Mon, 19 Oct 2026 10:00:00 GMT', now), { header: '0', ms: 0 });
  const tenDays = parseRetryAfter(new Date(Date.now() + 10 * 86400000).toUTCString());
  assert.ok(Math.abs(tenDays.ms - 864000000) < 2000 && tenDays.header === String(Math.ceil(tenDays.ms / 1000)));
  const validDate = new Date(Date.now() + 20000).toUTCString();
  assert.deepEqual(Object.keys(parseRetryAfter(validDate)), ['header', 'ms']);
  const vd = parseRetryAfter(validDate);
  assert.equal(vd.header, String(Math.ceil(vd.ms / 1000)), 'header is seconds derived from the same ms');
  console.log('ok - Retry-After parses seconds and HTTP dates');

  // Bearer + Basic (повтор после 401) для сохранённых ключей: две записи, athlete_id без "i".
  sent.length = 0;
  intervalsResponder = (parsed, options) => (
    String(options.headers.Authorization).startsWith('Bearer ')
      ? makeResponse({ error: 'no' }, 401)
      : makeResponse([], 200)
  );
  const req = fakeReq({ 'x-stas-request-id': 'x', 'x-stas-attempt': '3' }, { stasRequestId: '11111111-2222-4333-8444-555555555555' });
  const legacyAuth = { token: 'k', athleteId: 'i77', authMode: 'legacy' };
  await icuListEventsWithAuth({ auth: legacyAuth, q: { oldest: '2026-10-20', newest: '2026-10-21' }, req });
  await settle();
  assert.equal(sent.length, 2);
  const [bearer, basic] = sent.map((x) => x.body);
  assert.equal(bearer.attempt_kind, 'bearer');
  assert.equal(bearer.http_status, 401);
  assert.equal(bearer.outcome, 'http_error');
  assert.equal(basic.attempt_kind, 'basic');
  assert.equal(basic.http_status, 200);
  assert.equal(basic.outcome, 'ok');
  for (const rec of [bearer, basic]) {
    assert.equal(rec.provider_athlete_id, '77');
    assert.equal(rec.initiator, 'gpt');
    assert.equal(rec.method, 'GET');
    assert.equal(rec.path, '/api/v1/athlete/i77/events', 'pathname only, no query string');
    assert.equal(rec.retry_after_ms, null);
    assert.equal(rec.attempt_number, 3);
    assert.equal(typeof rec.latency_ms, 'number');
    assert.ok(Date.parse(rec.started_at) > 0);
  }
  assert.equal(sent[0].path, '/api/db/intervals-attempts');
  assert.equal(sent[0].headers['X-API-Key'], 'test-stas-key');
  assert.equal(sent[0].headers['Content-Type'], 'application/json');
  assert.equal(sent[0].headers['x-stas-request-id'], '11111111-2222-4333-8444-555555555555');
  console.log('ok - bearer and basic attempts are both reported with contract fields');

  // 429 / timeout / сеть.
  sent.length = 0;
  intervalsResponder = () => makeResponse({}, 429, { 'retry-after': '8' });
  await fetchIntervals('https://intervals.icu/api/v1/athlete/0/events/1', { method: 'PUT' }, { athleteId: 'i5', kind: 'bearer' });
  await settle();
  assert.equal(record().http_status, 429);
  assert.equal(record().outcome, 'http_error');
  assert.equal(record().retry_after_ms, 8000);
  assert.equal(record().method, 'PUT');
  assert.equal(record().attempt_number, null);

  sent.length = 0;
  intervalsResponder = () => { const e = new Error('The operation timed out'); e.name = 'TimeoutError'; throw e; };
  await assert.rejects(fetchIntervals('https://intervals.icu/api/v1/athlete/0', {}, { athleteId: 5 }), /timed out/);
  await settle();
  assert.equal(record().http_status, null);
  assert.equal(record().outcome, 'timeout');

  sent.length = 0;
  intervalsResponder = () => { throw new TypeError('fetch failed'); };
  await assert.rejects(fetchIntervals('https://intervals.icu/api/v1/athlete/0', { method: 'DELETE' }, { athleteId: 5 }), /fetch failed/);
  await settle();
  assert.equal(record().outcome, 'network_error');
  assert.equal(record().method, 'DELETE');
  assert.equal(record().provider_athlete_id, '5');
  console.log('ok - 429 (retry_after_ms), timeout and network error are reported; errors still reach the caller');

  // Поиск атлета: id из ответа при успехе, null при отказе; OAuth-режим: id из uid запроса.
  sent.length = 0;
  intervalsResponder = () => makeResponse({ id: 'i15487', name: 'A' }, 200);
  await fetchIntervals('https://intervals.icu/api/v1/athlete/0', {}, { kind: 'athlete_lookup', idFromBody: true });
  await settle();
  assert.equal(record().provider_athlete_id, '15487');
  assert.equal(record().attempt_kind, 'athlete_lookup');
  sent.length = 0;
  intervalsResponder = () => makeResponse({ error: 'no' }, 401);
  await fetchIntervals('https://intervals.icu/api/v1/athlete/0', {}, { kind: 'athlete_lookup', idFromBody: true });
  await settle();
  assert.equal(record().provider_athlete_id, null);
  assert.equal(record().outcome, 'http_error');
  sent.length = 0;
  intervalsResponder = () => makeResponse({}, 200);
  await fetchIntervals('https://intervals.icu/api/v1/athlete/0/events', {}, {
    req: fakeReq({}, { user_id: '15487', intervals_token: 'tok' }),
    auth: { authMode: 'intervals', athleteId: '0' },
    kind: 'bearer',
  });
  await settle();
  assert.equal(record().provider_athlete_id, '15487');
  console.log('ok - athlete id: from /athlete/0 body, null on failure, request user in OAuth mode');

  // Сбой журнала (ошибка, зависание, 500) не меняет результат и не бросает.
  for (const mode of ['throw', 'status', 'hang']) {
    sent.length = 0;
    ledgerResponder = mode === 'throw'
      ? () => { throw new Error('stas down'); }
      : mode === 'status' ? () => makeResponse({}, 500) : () => new Promise(() => {});
    intervalsResponder = () => makeResponse({ fine: true }, 200);
    const started = Date.now();
    const resp = await fetchIntervals('https://intervals.icu/api/v1/athlete/0', {}, { athleteId: 5 });
    assert.equal(resp.status, 200);
    assert.deepEqual(await resp.json(), { fine: true });
    assert.ok(Date.now() - started < 500, `${mode}: the report must not delay the response`);
    await settle();
    assert.ok(sent[0].signal, 'report has a timeout signal');
  }
  ledgerResponder = () => makeResponse({ ok: true }, 202);
  console.log('ok - ledger failure, 500 or hang does not delay or change the user response');

  // Источник 'site': только от самого STAS (ключ X-API-Key = STAS_KEY).
  assert.equal(normalizeSource('site'), 'site');
  assert.equal(getRequestSource(fakeReq({ 'x-stas-source': 'site', 'x-api-key': 'test-stas-key' })), 'site');
  assert.equal(getRequestSource(fakeReq({ 'x-stas-source': 'site', 'x-api-key': 'wrong' })), 'gpt');
  assert.equal(getRequestSource(fakeReq({ 'x-stas-source': 'site' })), 'gpt');
  assert.equal(getRequestSource(fakeReq({ 'x-stas-source': 'claude' })), 'claude');
  assert.equal(getRequestSource(fakeReq({ 'x-api-key': 'test-stas-key' })), 'gpt');
  assert.equal(buildStasSourceHeaders(fakeReq({ 'x-stas-source': 'site', 'x-api-key': 'test-stas-key' }))['x-stas-source'], 'site');
  assert.equal(buildStasSourceHeaders(fakeReq({ 'x-stas-source': 'site' }))['x-stas-source'], 'gpt');
  console.log("ok - source 'site' is honoured only with the STAS key");
}

main().then(() => {
  global.fetch = originalFetch;
}).catch((error) => {
  console.error(error);
  process.exit(1);
});
