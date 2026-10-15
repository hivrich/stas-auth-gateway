#!/usr/bin/env node
'use strict';

// Ключ STAS для проверки источника 'site' берётся через getStasKey(), а не напрямую из process.env.
// Ключ задаём до загрузки модулей: getStasKey кеширует первое найденное значение.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

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

const ROOT = path.resolve(__dirname, '..');
const STAS_ENV_FILE = '/opt/stas-db-bridge/.env';

// Изолированный сценарий: lib/get_stas_key.js кеширует ключ в переменной модуля, поэтому каждый сценарий идёт
// в отдельном дочернем процессе с чистым env (только PATH + переданные переменные). Порт не слушаем: фейковые req.
function runIsolated(env, body) {
  const code = `
    const fakeReq = (key) => {
      const h = key === undefined ? {} : { 'x-api-key': key };
      return { headers: h, get: (n) => h[String(n).toLowerCase()] };
    };
    const { isStasServerRequest } = require(${JSON.stringify(path.join(ROOT, 'lib/request-source.js'))});
    const out = {};
    ${body}
    process.stdout.write(JSON.stringify(out));
  `;
  const result = spawnSync(process.execPath, ['-e', code], {
    env: { PATH: process.env.PATH || '', ...env },
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, `child failed: ${result.stderr}`);
  return JSON.parse(result.stdout);
}

function testIsolatedKeySources() {
  // (a) STAS_KEY не задан, задан DB_BRIDGE_API_KEY: ключ берётся из него
  let out = runIsolated({ DB_BRIDGE_API_KEY: 'bridge-key' }, `
    out.bridgeKey = isStasServerRequest(fakeReq('bridge-key'));
    out.otherKey = isStasServerRequest(fakeReq('other-key'));
  `);
  assert.equal(out.bridgeKey, true, 'DB_BRIDGE_API_KEY is trusted when STAS_KEY is unset');
  assert.equal(out.otherKey, false);
  console.log('ok - getStasKey fallback: DB_BRIDGE_API_KEY is trusted when STAS_KEY is unset');

  // (b) оба заданы, значения разные: приоритет у STAS_KEY, DB_BRIDGE_API_KEY не проходит
  out = runIsolated({ STAS_KEY: 'stas-key', DB_BRIDGE_API_KEY: 'bridge-key' }, `
    out.stasKey = isStasServerRequest(fakeReq('stas-key'));
    out.bridgeKey = isStasServerRequest(fakeReq('bridge-key'));
  `);
  assert.equal(out.stasKey, true, 'STAS_KEY has priority');
  assert.equal(out.bridgeKey, false, 'DB_BRIDGE_API_KEY is not trusted when STAS_KEY is set');
  console.log('ok - getStasKey priority: STAS_KEY wins over DB_BRIDGE_API_KEY');

  // (c) нет ни STAS_KEY, ни DB_BRIDGE_API_KEY, и файла ключа нет: никто не доверен
  if (fs.existsSync(STAS_ENV_FILE)) {
    console.log(`skip - no key anywhere: ${STAS_ENV_FILE} exists on this machine, scenario needs it absent`);
  } else {
    out = runIsolated({}, `
      out.someKey = isStasServerRequest(fakeReq('some-key'));
      out.emptyKey = isStasServerRequest(fakeReq(''));
      out.noKey = isStasServerRequest(fakeReq());
      out.undefinedLike = isStasServerRequest(fakeReq('undefined'));
    `);
    assert.deepEqual(out, { someKey: false, emptyKey: false, noKey: false, undefinedLike: false });
    console.log('ok - getStasKey without any source: no request is trusted');
  }

  // (г) кеш: после первого вызова смена process.env.STAS_KEY в том же процессе результат не меняет
  out = runIsolated({ STAS_KEY: 'first-key' }, `
    out.firstBefore = isStasServerRequest(fakeReq('first-key'));
    process.env.STAS_KEY = 'second-key';
    out.firstAfter = isStasServerRequest(fakeReq('first-key'));
    out.secondAfter = isStasServerRequest(fakeReq('second-key'));
  `);
  assert.deepEqual(out, { firstBefore: true, firstAfter: true, secondAfter: false });
  console.log('ok - getStasKey cache: changing STAS_KEY after the first call does not change the result');
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
  let live;
  try {
    live = await new Promise((resolve, reject) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
      s.once('error', reject);
    });
  } catch (error) {
    global.fetch = originalFetch;
    if (error && error.code === 'EPERM') {
      console.log('skip - POST /gw/icu/activities/manual: environment does not allow listening on a port (EPERM)');
      return;
    }
    throw error;
  }
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

    // (c) ключ сайта + x-stas-source: site -> проверка источника пройдена, дальше работает валидация тела маршрута.
    // Реальный ответ (lib/attach_activity_create.js, validateBody): external_id должен быть stas-done:<...>,
    // 'manual:1' не подходит, поэтому 400 { ok: false, error: 'invalid_body', field: 'external_id' }.
    r = await post(baseUrl, { 'X-API-Key': getStasKey(), 'x-stas-source': 'site' }, body);
    assert.equal(r.status, 400);
    assert.equal(r.body.error, 'invalid_body');
    assert.equal(r.body.field, 'external_id');
    // Проверка токена (uidGate) ходит в Intervals за athlete/0; запись активности до валидации не доходит.
    assert.equal(icuHits.some((h) => h.method !== 'GET' || h.path.includes('/activities')), false,
      'validation error must not create an activity in Intervals');
    console.log('ok - POST /gw/icu/activities/manual: no key -> 403 site_only; site key -> 400 invalid_body (external_id)');
  } finally {
    live.close();
    global.fetch = originalFetch;
  }
}

async function main() {
  testIsStasServerRequest();
  testIsolatedKeySources();
  await testRoute();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
