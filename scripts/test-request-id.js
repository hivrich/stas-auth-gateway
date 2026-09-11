#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');

process.env.STAS_KEY = process.env.STAS_KEY || 'test-stas-key';
process.env.STAS_BASE = process.env.STAS_BASE || 'http://stas.local.test';

const { createApp } = require('../server');
const { STAS_REQUEST_ID_HEADER } = require('../lib/request-id');
const { tokenIngress } = require('../lib/oauth-token-diagnostics');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const VALID_ID = '123e4567-e89b-42d3-a456-426614174000';
const UPPER_ID = '123E4567-E89B-42D3-A456-426614174000';
const BEARER_TOKEN = 'intervals-access-token';
const QUERY_SECRET = 'super-secret-query-value';
const BODY_SECRET = 'super-secret-body-value';
const EXCEPTION_SECRET = 'exception-secret-upstream-broke';
const BAD_BODY = '{definitely-not-json';

const originalConsole = { log: console.log, warn: console.warn, error: console.error };
const logLines = [];

let dbProxyUpstreamMode = 'ok';

function captureConsole() {
  for (const method of ['log', 'warn', 'error']) {
    console[method] = (...args) => logLines.push(args.map((item) => String(item)).join(' '));
  }
}

function restoreConsole() {
  for (const method of ['log', 'warn', 'error']) console[method] = originalConsole[method];
}

function findJsonLine(marker) {
  const line = [...logLines].reverse().find((text) => text.startsWith(marker));
  assert.ok(line, `expected a log line starting with ${marker}, got:\n${logLines.join('\n')}`);
  const payload = line.slice(marker.length).trim();
  return JSON.parse(payload);
}

const realFetch = global.fetch;
const upstreamHits = [];

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
  };
}

function installFetchMock(gatewayOrigin) {
  global.fetch = async (url, options = {}) => {
    const parsed = new URL(url.toString());
    if (parsed.origin === gatewayOrigin) return realFetch(url, options);
    upstreamHits.push({
      url: parsed.toString(),
      pathname: parsed.pathname,
      method: options.method || 'GET',
      headers: options.headers || {},
      body: options.body,
    });
    if (parsed.origin === 'https://intervals.icu' && parsed.pathname === '/api/v1/athlete/0') {
      if (options.headers?.Authorization !== `Bearer ${BEARER_TOKEN}`) {
        return jsonResponse({ error: 'invalid_token' }, 401);
      }
      return jsonResponse({ id: '15487', name: 'Test Athlete' });
    }
    if (parsed.pathname === '/api/db/ensure-intervals-user') return jsonResponse({ ok: true });
    if (parsed.pathname === '/api/db/trainings') return jsonResponse([{ id: 'train-1' }]);
    if (parsed.pathname === '/api/db/activity_detail') {
      if (dbProxyUpstreamMode === 'exception') throw new Error(EXCEPTION_SECRET);
      return jsonResponse({ ok: true, activity: { id: 'act-1' } });
    }
    return jsonResponse({ error: 'unexpected_upstream', url: parsed.toString() }, 500);
  };
}

async function main() {
  assert.equal(
    require('../lib/request-id').__testing.acceptedRequestId(`${VALID_ID}\n`),
    VALID_ID,
    'surrounding whitespace should be trimmed before validation',
  );
  assert.equal(require('../lib/request-id').__testing.acceptedRequestId(`${VALID_ID}x`), null);
  assert.equal(require('../lib/request-id').__testing.acceptedRequestId(VALID_ID.toUpperCase()), UPPER_ID);

  captureConsole();
  installFetchMock('');

  const app = createApp();
  const server = await new Promise((resolve) => {
    const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
  });
  const address = server.address();
  const gatewayOrigin = `http://${address.address}:${address.port}`;
  installFetchMock(gatewayOrigin);

  try {
    // Missing id: gateway mints a fresh UUID and echoes it.
    let response = await realFetch(`${gatewayOrigin}/gw/healthz`);
    assert.equal(response.status, 200);
    let echoed = response.headers.get(STAS_REQUEST_ID_HEADER);
    assert.match(echoed, UUID_RE, 'response must carry a valid generated UUID');

    // Valid id: preserved exactly and echoed back.
    response = await realFetch(`${gatewayOrigin}/gw/healthz`, { headers: { [STAS_REQUEST_ID_HEADER]: VALID_ID } });
    echoed = response.headers.get(STAS_REQUEST_ID_HEADER);
    assert.equal(echoed, VALID_ID, 'valid request id must be preserved verbatim');

    // Malformed and overlong ids are replaced with fresh UUIDs.
    response = await realFetch(`${gatewayOrigin}/gw/healthz`, { headers: { [STAS_REQUEST_ID_HEADER]: 'not-a-uuid' } });
    const replaced = response.headers.get(STAS_REQUEST_ID_HEADER);
    assert.match(replaced, UUID_RE);
    assert.notEqual(replaced, 'not-a-uuid');

    response = await realFetch(`${gatewayOrigin}/gw/healthz`, { headers: { [STAS_REQUEST_ID_HEADER]: 'z'.repeat(300) } });
    const replacedLong = response.headers.get(STAS_REQUEST_ID_HEADER);
    assert.match(replacedLong, UUID_RE);
    assert.notEqual(replaced, replacedLong, 'each rejected id must get its own fresh UUID');

    // Auth rejection log carries the id and never the rejected token value.
    const garbageToken = 'garbage-token-value-123';
    response = await realFetch(`${gatewayOrigin}/gw/api/me`, {
      headers: { [STAS_REQUEST_ID_HEADER]: VALID_ID, Authorization: `Bearer ${garbageToken}` },
    });
    assert.equal(response.status, 401);
    assert.equal(response.headers.get(STAS_REQUEST_ID_HEADER), VALID_ID);
    let payload = findJsonLine('[auth][bearer_rejected]');
    assert.equal(payload.stas_request_id, VALID_ID);
    assert.equal(payload.path, '/gw/api/me');

    // Full pipeline: valid id, valid auth (mocked Intervals upstream) — the same id
    // must reach the response, the /gw/api/me log record and the STAS-bound upstream.
    response = await realFetch(`${gatewayOrigin}/gw/api/me`, {
      headers: { [STAS_REQUEST_ID_HEADER]: VALID_ID, Authorization: `Bearer ${BEARER_TOKEN}`, 'x-stas-source': 'gpt' },
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get(STAS_REQUEST_ID_HEADER), VALID_ID);
    payload = findJsonLine('[auth][me]');
    assert.equal(payload.stas_request_id, VALID_ID);
    assert.equal(payload.status, 200);
    assert.equal(payload.auth_mode, 'intervals');

    response = await realFetch(`${gatewayOrigin}/gw/trainings?days=7&secret=${QUERY_SECRET}`, {
      headers: { [STAS_REQUEST_ID_HEADER]: VALID_ID, Authorization: `Bearer ${BEARER_TOKEN}` },
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get(STAS_REQUEST_ID_HEADER), VALID_ID);
    const trainingsHit = upstreamHits.find((hit) => hit.pathname === '/api/db/trainings');
    assert.ok(trainingsHit, 'expected an outbound STAS trainings call');
    assert.equal(
      trainingsHit.headers[STAS_REQUEST_ID_HEADER],
      VALID_ID,
      'outbound STAS call must forward the same request id',
    );
    assert.equal(trainingsHit.headers['x-stas-source'], 'gpt');

    // Real MCP proxy path /gw/api/db/*: success must carry the same ID through
    // the REQ/RES log records, the response and the outbound STAS call, while
    // query secrets stay out of the logs.
    response = await realFetch(`${gatewayOrigin}/gw/api/db/activity_detail?days=7&token=${QUERY_SECRET}`, {
      headers: { [STAS_REQUEST_ID_HEADER]: VALID_ID, Authorization: `Bearer ${BEARER_TOKEN}` },
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get(STAS_REQUEST_ID_HEADER), VALID_ID);
    let proxyPayload = findJsonLine('[db_proxy][REQ]');
    assert.equal(proxyPayload.stas_request_id, VALID_ID);
    assert.equal(proxyPayload.path, '/activity_detail');
    assert.equal(proxyPayload.upstream_path, '/api/db/activity_detail');
    proxyPayload = findJsonLine('[db_proxy][RES]');
    assert.equal(proxyPayload.stas_request_id, VALID_ID);
    assert.equal(proxyPayload.status, 200);
    assert.equal(typeof proxyPayload.duration_ms, 'number');
    const dbHit = upstreamHits.find((hit) => hit.pathname === '/api/db/activity_detail');
    assert.ok(dbHit, 'expected an outbound STAS activity_detail call');
    assert.equal(
      dbHit.headers[STAS_REQUEST_ID_HEADER],
      VALID_ID,
      'outbound STAS db call must forward the same request id',
    );

    // Body content must never reach the logs either.
    response = await realFetch(`${gatewayOrigin}/gw/api/db/activity_detail`, {
      method: 'POST',
      headers: {
        [STAS_REQUEST_ID_HEADER]: VALID_ID,
        Authorization: `Bearer ${BEARER_TOKEN}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ note: BODY_SECRET }),
    });
    assert.equal(response.status, 200);

    // Upstream failure: the ERR record keeps the same ID with a controlled
    // category; the raw exception text must not leak into any log line.
    dbProxyUpstreamMode = 'exception';
    response = await realFetch(`${gatewayOrigin}/gw/api/db/activity_detail?token=${QUERY_SECRET}`, {
      headers: { [STAS_REQUEST_ID_HEADER]: VALID_ID, Authorization: `Bearer ${BEARER_TOKEN}` },
    });
    assert.equal(response.status, 502);
    assert.equal(response.headers.get(STAS_REQUEST_ID_HEADER), VALID_ID);
    proxyPayload = findJsonLine('[db_proxy][ERR]');
    assert.equal(proxyPayload.stas_request_id, VALID_ID);
    assert.equal(proxyPayload.status, 502);
    assert.equal(proxyPayload.category, 'upstream_error');
    dbProxyUpstreamMode = 'ok';

    // 404 log carries the id; query secrets must not leak into logs.
    // (Valid bearer token is required: bearer auth runs before the 404 fallback.)
    response = await realFetch(`${gatewayOrigin}/gw/definitely-not-here?token=${QUERY_SECRET}`, {
      headers: { [STAS_REQUEST_ID_HEADER]: VALID_ID, Authorization: `Bearer ${BEARER_TOKEN}` },
    });
    assert.equal(response.status, 404);
    payload = findJsonLine('[http][not_found]');
    assert.equal(payload.stas_request_id, VALID_ID);
    assert.equal(payload.path, '/gw/definitely-not-here');

    // Malformed JSON body → unhandled error log with id; body text must not leak.
    response = await realFetch(`${gatewayOrigin}/gw/healthz`, {
      method: 'POST',
      headers: { [STAS_REQUEST_ID_HEADER]: VALID_ID, 'content-type': 'application/json' },
      body: BAD_BODY,
    });
    assert.equal(response.status, 500);
    payload = findJsonLine('[http][unhandled_error]');
    assert.equal(payload.stas_request_id, VALID_ID);

    // OAuth token diagnostics keep their internal request_id and add the accepted one.
    const oauthReq = {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      originalUrl: '/gw/oauth/token',
      stasRequestId: VALID_ID,
    };
    const listeners = {};
    const oauthRes = { statusCode: 200, once(event, handler) { listeners[event] = handler; } };
    tokenIngress(oauthReq, oauthRes, () => {});
    listeners.finish();
    payload = findJsonLine('[oauth][token][ingress]');
    assert.equal(payload.stas_request_id, VALID_ID);
    assert.match(payload.request_id, UUID_RE, 'internal OAuth request_id stays a fresh UUID');
    assert.notEqual(payload.request_id, VALID_ID);
    payload = findJsonLine('[oauth][token][outcome]');
    assert.equal(payload.stas_request_id, VALID_ID);
    assert.equal(payload.status, 200);

    const anonReq = {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      originalUrl: '/gw/oauth/token',
    };
    const anonListeners = {};
    const anonRes = { statusCode: 200, once(event, handler) { anonListeners[event] = handler; } };
    tokenIngress(anonReq, anonRes, () => {});
    anonListeners.finish();
    payload = findJsonLine('[oauth][token][ingress]');
    assert.equal(payload.stas_request_id, null, 'absent caller id must be recorded as null');

    // Security sweep: no token, query secret, body content, raw exception text
    // or unhandled JSON body anywhere in captured logs.
    const everything = logLines.join('\n');
    for (const sensitive of [BEARER_TOKEN, garbageToken, QUERY_SECRET, BODY_SECRET, EXCEPTION_SECRET, BAD_BODY]) {
      assert.ok(!everything.includes(sensitive), `logs must not contain ${JSON.stringify(sensitive)}`);
    }
    for (const marker of ['[db_proxy][REQ]', '[db_proxy][RES]', '[db_proxy][ERR]']) {
      const line = [...logLines].reverse().find((text) => text.startsWith(marker));
      assert.ok(line && !line.includes('?') && !line.includes('http'), `${marker} must log paths without query or URLs`);
    }
  } finally {
    server.close();
    restoreConsole();
    global.fetch = realFetch;
  }

  console.log('ok - x-stas-request-id accepted, echoed, logged and forwarded safely');
}

main().catch((error) => {
  restoreConsole();
  global.fetch = realFetch;
  console.error(error);
  process.exit(1);
});
