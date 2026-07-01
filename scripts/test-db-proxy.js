#!/usr/bin/env node
'use strict';

const assert = require('assert');

process.env.STAS_KEY = process.env.STAS_KEY || 'test-stas-key';
process.env.STAS_BASE = process.env.STAS_BASE || 'http://stas.local.test';

const originalFetch = global.fetch;
const upstreamHits = [];
let trainingsFetchMode = 'array';

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

function invalidJsonResponse(status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get(name) {
        return String(name).toLowerCase() === 'content-type' ? 'application/json; charset=utf-8' : null;
      },
    },
    json: async () => {
      throw new SyntaxError('invalid json');
    },
    text: async () => '{',
  };
}

global.fetch = async (url, options = {}) => {
  const parsed = new URL(url.toString());
  upstreamHits.push({
    url: parsed.toString(),
    method: options.method || 'GET',
    headers: options.headers || {},
    body: options.body,
  });

  if (parsed.pathname === '/api/db/trainings') {
    if (trainingsFetchMode === 'empty') return jsonResponse([]);
    if (trainingsFetchMode === 'envelope') return jsonResponse({ trainings: [{ id: 'train-envelope' }] });
    if (trainingsFetchMode === 'upstream-non-ok') return jsonResponse({ error: 'upstream_down' }, 503);
    if (trainingsFetchMode === 'invalid-json') return invalidJsonResponse();
    if (trainingsFetchMode === 'unknown-shape') return jsonResponse({ ok: true });
    if (trainingsFetchMode === 'timeout') {
      const error = new Error('The operation timed out');
      error.name = 'TimeoutError';
      throw error;
    }
    if (trainingsFetchMode === 'exception') throw new Error('socket hang up');
    return jsonResponse([{ id: 'train-1' }]);
  }

  return jsonResponse({ ok: true, url: parsed.toString() });
};

const uidInjectDb = require('../routes/_uid_inject_db');
const dbProxy = require('../routes/db_proxy');
const dbProxyHandler = dbProxy.stack?.[0]?.handle;
const trainingsRouter = require('../routes/trainings');

assert.strictEqual(typeof dbProxyHandler, 'function', 'db_proxy handler not found');
assert.strictEqual(typeof dbProxy.__testing?.getDbProxyTimeoutMs, 'function', 'db_proxy timeout helper not found');

function findRouteHandler(router, method, path) {
  const layer = router.stack?.find((item) => (
    item.route?.path === path &&
    item.route?.methods?.[String(method).toLowerCase()]
  ));
  return layer?.route?.stack?.[0]?.handle;
}

const trainingsHandler = findRouteHandler(trainingsRouter, 'GET', '/trainings');
assert.strictEqual(typeof trainingsHandler, 'function', 'trainings handler not found');

function makeReq(query, userId, options = {}) {
  const path = options.path || '/activity_detail';
  const method = options.method || 'GET';
  const headers = {};
  const rawQuery = new URLSearchParams(query).toString();
  const req = {
    path,
    originalUrl: `/gw/api/db${path}${rawQuery ? `?${rawQuery}` : ''}`,
    method,
    query: { ...query },
    headers,
    body: options.body,
    get(name) {
      return this.headers[String(name).toLowerCase()];
    },
  };

  if (userId) {
    req.auth = { userId: String(userId), authMode: 'test', source: 'gpt' };
    req.user_id = String(userId);
  }
  if (options.body !== undefined) {
    req.headers['content-type'] = options.contentType || 'application/json';
  }

  return req;
}

function makeTrainingsReq(query, userId) {
  const rawQuery = new URLSearchParams(query).toString();
  const req = {
    path: '/trainings',
    originalUrl: `/gw/trainings${rawQuery ? `?${rawQuery}` : ''}`,
    method: 'GET',
    query: { ...query },
    headers: {},
    get(name) {
      return this.headers[String(name).toLowerCase()];
    },
  };

  if (userId) {
    req.auth = { userId: String(userId), authMode: 'test', source: 'gpt' };
    req.user_id = String(userId);
  }

  return req;
}

function makeRes() {
  let resolveDone;
  const done = new Promise((resolve) => {
    resolveDone = resolve;
  });

  const res = {
    statusCode: 200,
    headers: {},
    locals: {},
    body: undefined,
    finished: false,
    done,
    status(code) {
      this.statusCode = code;
      return this;
    },
    set(name, value) {
      if (typeof name === 'object') {
        for (const [key, item] of Object.entries(name)) this.headers[key.toLowerCase()] = item;
        return this;
      }
      this.headers[String(name).toLowerCase()] = value;
      return this;
    },
    send(body) {
      this.body = body;
      this.finished = true;
      resolveDone(this);
      return this;
    },
    json(body) {
      this.jsonBody = body;
      this.set('content-type', 'application/json; charset=utf-8');
      return this.send(JSON.stringify(body));
    },
  };

  return res;
}

async function runUidInject(req, res) {
  let nextCalled = false;

  await new Promise((resolve, reject) => {
    const next = (error) => {
      if (error) return reject(error);
      nextCalled = true;
      return resolve();
    };

    try {
      const returned = uidInjectDb(req, res, next);
      if (returned && typeof returned.then === 'function') returned.then(resolve, reject);
    } catch (error) {
      reject(error);
    }

    res.done.then(resolve);
  });

  return nextCalled;
}

async function runDbProxy(req, res) {
  await new Promise((resolve, reject) => {
    const next = (error) => (error ? reject(error) : resolve());

    try {
      const returned = dbProxyHandler(req, res, next);
      if (returned && typeof returned.then === 'function') returned.then(resolve, reject);
    } catch (error) {
      reject(error);
    }

    res.done.then(resolve);
  });
}

async function runTrainings(req, res) {
  await new Promise((resolve, reject) => {
    const next = (error) => (error ? reject(error) : resolve());

    try {
      const returned = trainingsHandler(req, res, next);
      if (returned && typeof returned.then === 'function') returned.then(resolve, reject);
    } catch (error) {
      reject(error);
    }

    res.done.then(resolve);
  });
}

async function runRequest(query, userId, options = {}) {
  const req = makeReq(query, userId, options);
  const res = makeRes();
  if (await runUidInject(req, res)) await runDbProxy(req, res);
  return res;
}

async function runRequestWithObservedTimeout(query, userId, options = {}) {
  const originalSetTimeout = global.setTimeout;
  const delays = [];
  global.setTimeout = (handler, delay, ...args) => {
    delays.push(delay);
    return originalSetTimeout(handler, delay, ...args);
  };

  try {
    const response = await runRequest(query, userId, options);
    return { response, delays };
  } finally {
    global.setTimeout = originalSetTimeout;
  }
}

async function runTrainingsRequest(query, userId) {
  const req = makeTrainingsReq(query, userId);
  const res = makeRes();
  await runTrainings(req, res);
  return res;
}

async function expectTrainingsError(mode, expectedStatus, expectedError, expectedOptions = {}) {
  trainingsFetchMode = mode;
  const response = await runTrainingsRequest({ days: '7' }, 'user-42');
  assert.strictEqual(response.statusCode, expectedStatus);
  assert.strictEqual(response.jsonBody.status, expectedStatus);
  assert.strictEqual(response.jsonBody.error, expectedError);
  if (expectedOptions.retryable !== undefined) {
    assert.strictEqual(response.jsonBody.retryable, expectedOptions.retryable);
  }
  if (expectedOptions.upstreamStatus !== undefined) {
    assert.strictEqual(response.jsonBody.upstream_status, expectedOptions.upstreamStatus);
  }
  assert.notDeepStrictEqual(response.jsonBody, []);
}

async function main() {
  try {
    assert.strictEqual(dbProxy.__testing.getDbProxyTimeoutMs('GET', '/activity_detail'), 40000);
    assert.strictEqual(dbProxy.__testing.getDbProxyTimeoutMs('POST', '/activity_detail'), 5000);
    assert.strictEqual(dbProxy.__testing.getDbProxyTimeoutMs('GET', '/trainings'), 5000);

    let observed = await runRequestWithObservedTimeout({ training_id: 'train-123' }, 'user-42');
    let response = observed.response;
    assert.strictEqual(response.statusCode, 200);
    assert.ok(observed.delays.includes(40000), 'activity_detail should use longer timeout');
    const payload = JSON.parse(response.body);
    assert.strictEqual(payload.ok, true);

    assert.strictEqual(upstreamHits.length, 1);
    let hit = upstreamHits[0];
    let forwarded = new URL(hit.url);
    assert.strictEqual(hit.method, 'GET');
    assert.strictEqual(forwarded.pathname, '/api/db/activity_detail');
    assert.strictEqual(forwarded.searchParams.get('training_id'), 'train-123');
    assert.strictEqual(forwarded.searchParams.get('user_id'), 'user-42');
    assert.strictEqual(hit.headers['X-API-Key'], 'test-stas-key');

    response = await runRequest({ training_id: 'train-456', user_id: 'explicit-7', uid: 'uid-7' }, 'user-42');
    assert.strictEqual(response.statusCode, 200);

    assert.strictEqual(upstreamHits.length, 2);
    hit = upstreamHits[1];
    forwarded = new URL(hit.url);
    assert.strictEqual(forwarded.pathname, '/api/db/activity_detail');
    assert.strictEqual(forwarded.searchParams.get('training_id'), 'train-456');
    assert.strictEqual(forwarded.searchParams.get('user_id'), 'user-42');
    assert.strictEqual(forwarded.searchParams.has('uid'), false);

    response = await runRequest({ training_id: 'train-789', user_id: 'query-only' });
    assert.strictEqual(response.statusCode, 401);
    assert.deepStrictEqual(response.jsonBody, { status: 401, error: 'missing_or_invalid_token' });
    assert.strictEqual(upstreamHits.length, 2);

    observed = await runRequestWithObservedTimeout({}, 'user-42', {
      path: '/profile_sections/preview',
      method: 'POST',
      body: {
        section: 'rules',
        structured: { rules: { trainingsPerWeek: 5 } },
        previousHash: 'hash-123',
      },
    });
    response = observed.response;
    assert.strictEqual(response.statusCode, 200);
    assert.ok(observed.delays.includes(5000), 'generic db proxy routes should keep default timeout');

    assert.strictEqual(upstreamHits.length, 3);
    hit = upstreamHits[2];
    forwarded = new URL(hit.url);
    assert.strictEqual(hit.method, 'POST');
    assert.strictEqual(forwarded.pathname, '/api/db/profile_sections/preview');
    assert.strictEqual(forwarded.searchParams.get('user_id'), 'user-42');
    assert.strictEqual(hit.headers['Content-Type'], 'application/json');
    assert.deepStrictEqual(JSON.parse(hit.body), {
      section: 'rules',
      structured: { rules: { trainingsPerWeek: 5 } },
      previousHash: 'hash-123',
    });

    upstreamHits.length = 0;

    trainingsFetchMode = 'array';
    response = await runTrainingsRequest({ days: '7', full: 'true', user_id: 'query-only', uid: 'query-uid' }, 'user-42');
    assert.strictEqual(response.statusCode, 200);
    assert.deepStrictEqual(response.jsonBody, [{ id: 'train-1' }]);
    hit = upstreamHits[0];
    forwarded = new URL(hit.url);
    assert.strictEqual(forwarded.pathname, '/api/db/trainings');
    assert.strictEqual(forwarded.searchParams.get('user_id'), 'user-42');
    assert.strictEqual(forwarded.searchParams.get('uid'), null);
    assert.strictEqual(forwarded.searchParams.get('full'), 'true');
    assert.strictEqual(hit.headers['X-API-Key'], 'test-stas-key');

    trainingsFetchMode = 'empty';
    response = await runTrainingsRequest({ days: '7' }, 'user-42');
    assert.strictEqual(response.statusCode, 200);
    assert.deepStrictEqual(response.jsonBody, []);

    trainingsFetchMode = 'envelope';
    response = await runTrainingsRequest({ days: '7' }, 'user-42');
    assert.strictEqual(response.statusCode, 200);
    assert.deepStrictEqual(response.jsonBody, [{ id: 'train-envelope' }]);

    response = await runTrainingsRequest({ days: '7' });
    assert.strictEqual(response.statusCode, 401);
    assert.deepStrictEqual(response.jsonBody, { status: 401, error: 'missing_or_invalid_token' });

    await expectTrainingsError('upstream-non-ok', 502, 'upstream_error', {
      retryable: true,
      upstreamStatus: 503,
    });
    await expectTrainingsError('timeout', 504, 'upstream_timeout', { retryable: true });
    await expectTrainingsError('invalid-json', 502, 'invalid_upstream_response', { retryable: true });
    await expectTrainingsError('unknown-shape', 502, 'invalid_upstream_response', { retryable: true });
    await expectTrainingsError('exception', 502, 'upstream_error', { retryable: true });

    console.log('ok - db_proxy and trainings gateway contract pass');
  } finally {
    global.fetch = originalFetch;
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
