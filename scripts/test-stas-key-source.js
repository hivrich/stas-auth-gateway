#!/usr/bin/env node
'use strict';

// Ключ STAS для проверки источника 'site' берётся через getStasKey(), а не напрямую из process.env.
// Ключ задаём до загрузки модулей: getStasKey кеширует первое найденное значение.
const assert = require('node:assert/strict');

const SITE_KEY = 'test-stas-key-source';
process.env.STAS_KEY = SITE_KEY;
process.env.STAS_BASE = process.env.STAS_BASE || 'http://stas.local.test';

const getStasKey = require('../lib/get_stas_key');
const { isStasServerRequest, getRequestSource } = require('../lib/request-source');
const { createApp } = require('../server');

const originalFetch = global.fetch;
const localOrigins = new Set();
const icuHits = [];

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

// Мок без сети: Intervals отвечает только на проверку токена, всё остальное фиксируем.
global.fetch = async (url, options = {}) => {
  const parsed = new URL(url.toString());
  if (localOrigins.has(parsed.origin)) return originalFetch(url, options);
  if (parsed.origin === 'http://stas.local.test') return jsonResponse({ ok: true }, 202);
  if (parsed.origin !== 'https://intervals.icu') return jsonResponse({ error: 'unexpected_upstream' }, 500);
  icuHits.push({ path: parsed.pathname, method: options.method || 'GET' });
  if (parsed.pathname === '/api/v1/athlete/0') return jsonResponse({ id: '15487', name: 'Patrik' });
  return jsonResponse({ error: 'unexpected_upstream', url: parsed.toString() }, 500);
};

// Минимальный req: достаточно get() и headers, как у Express.
function fakeReq(headers = {}) {
  const lower = {};
  for (const [k, v] of Object.entries(headers)) lower[k.toLowerCase()] = v;
  return { headers: lower, get: (name) => lower[String(name).toLowerCase()] };
}

function testIsStasServerRequest() {
  const key = getStasKey();
  assert.equal(key, SITE_KEY, 'getStasKey reads STAS_KEY');

  // (a) ключ из getStasKey() совпадает
  assert.equal(isStasServerRequest(fakeReq({ 'X-API-Key': key })), true);
  assert.equal(isStasServerRequest(fakeReq({ 'X-API-Key': `  ${key}  ` })), true, 'whitespace is trimmed');

  // (b) чужой, пустой и отсутствующий ключ
  assert.equal(isStasServerRequest(fakeReq({ 'X-API-Key': 'wrong-key' })), false);
  assert.equal(isStasServerRequest(fakeReq({ 'X-API-Key': `${key}x` })), false);
  assert.equal(isStasServerRequest(fakeReq({ 'X-API-Key': '' })), false);
  assert.equal(isStasServerRequest(fakeReq({})), false);

  // Источник 'site' принимается только вместе с ключом.
  assert.equal(getRequestSource(fakeReq({ 'X-API-Key': key, 'x-stas-source': 'site' })), 'site');
  assert.equal(getRequestSource(fakeReq({ 'x-stas-source': 'site' })), 'gpt');
  assert.equal(getRequestSource(fakeReq({ 'X-API-Key': 'wrong-key', 'x-stas-source': 'site' })), 'gpt');
  console.log('ok - isStasServerRequest: key from getStasKey() matches; wrong / empty / missing does not');
}

async function post(baseUrl, headers, body) {
  const response = await originalFetch(`${baseUrl}/gw/icu/activities/manual`, {
    method: 'POST',
    headers: {
      Authorization: 'Bearer intervals-access-token',
      Accept: 'application/json',
      'Content-Type': 'application/json',
      ...headers,
    },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

async function testRoute() {
  const app = createApp();
  const live = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const baseUrl = `http://127.0.0.1:${live.address().port}`;
  localOrigins.add(baseUrl);

  try {
    // Заведомо невалидное тело: если источник принят, маршрут отвечает 400 (валидация), а не 403.
    const body = { external_id: 'manual:1', type: 'Run', start_date_local: '2026-10-20T07:30:00', moving_time: 3000 };

    // (c) без ключа -> 403 site_only, как раньше
    let r = await post(baseUrl, {}, body);
    assert.equal(r.status, 403);
    assert.deepEqual(r.body, { ok: false, error: 'site_only' });
    r = await post(baseUrl, { 'x-stas-source': 'site' }, body);
    assert.equal(r.status, 403);
    assert.deepEqual(r.body, { ok: false, error: 'site_only' });
    r = await post(baseUrl, { 'X-API-Key': 'wrong-key', 'x-stas-source': 'site' }, body);
    assert.equal(r.status, 403);
    assert.deepEqual(r.body, { ok: false, error: 'site_only' });
    assert.equal(icuHits.length, 0, '403 must not reach Intervals');

    // (c) ключ сайта + x-stas-source: site -> проверка источника пройдена (дальше ответ маршрута, не 403)
    r = await post(baseUrl, { 'X-API-Key': getStasKey(), 'x-stas-source': 'site' }, body);
    assert.notEqual(r.status, 403, 'site key passes the source check');
    assert.notEqual(r.body && r.body.error, 'site_only');
    console.log(`ok - POST /gw/icu/activities/manual: no key -> 403 site_only; site key passes the source check (status ${r.status})`);
  } finally {
    live.close();
    global.fetch = originalFetch;
  }
}

async function main() {
  testIsStasServerRequest();
  await testRoute();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
