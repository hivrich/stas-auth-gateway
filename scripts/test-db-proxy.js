#!/usr/bin/env node
'use strict';

const assert = require('assert');

process.env.STAS_KEY = process.env.STAS_KEY || 'test-stas-key';
process.env.STAS_BASE = process.env.STAS_BASE || 'http://stas.local.test';

const upstreamHits = [];
const originalFetch = global.fetch;

global.fetch = async (url, options = {}) => {
  upstreamHits.push({
    url: url.toString(),
    method: options.method || 'GET',
    headers: options.headers || {},
    body: options.body,
  });

  return {
    status: 200,
    headers: {
      get(name) {
        return String(name).toLowerCase() === 'content-type' ? 'application/json; charset=utf-8' : null;
      },
    },
    text: async () => JSON.stringify({ ok: true, url: url.toString() }),
  };
};

const uidInjectDb = require('../routes/_uid_inject_db');
const dbProxy = require('../routes/db_proxy');
const dbProxyHandler = dbProxy.stack?.[0]?.handle;

assert.strictEqual(typeof dbProxyHandler, 'function', 'db_proxy handler not found');

function makeLegacyToken(uid) {
  return `t_${Buffer.from(JSON.stringify({ uid })).toString('base64url')}`;
}

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
    req.headers.authorization = `Bearer ${makeLegacyToken(userId)}`;
  }
  if (options.body !== undefined) {
    req.headers['content-type'] = options.contentType || 'application/json';
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

async function runRequest(query, userId, options = {}) {
  const req = makeReq(query, userId, options);
  const res = makeRes();
  if (await runUidInject(req, res)) await runDbProxy(req, res);
  return res;
}

async function main() {
  try {
    let response = await runRequest({ training_id: 'train-123' }, 'user-42');
    assert.strictEqual(response.statusCode, 200);
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

    response = await runRequest({ training_id: 'train-456', user_id: 'explicit-7' }, 'user-42');
    assert.strictEqual(response.statusCode, 200);

    assert.strictEqual(upstreamHits.length, 2);
    hit = upstreamHits[1];
    forwarded = new URL(hit.url);
    assert.strictEqual(forwarded.pathname, '/api/db/activity_detail');
    assert.strictEqual(forwarded.searchParams.get('training_id'), 'train-456');
    assert.strictEqual(forwarded.searchParams.get('user_id'), 'explicit-7');

    response = await runRequest({ training_id: 'train-789' });
    assert.strictEqual(response.statusCode, 401);
    assert.deepStrictEqual(response.jsonBody, { status: 401, error: 'missing_or_invalid_token' });
    assert.strictEqual(upstreamHits.length, 2);

    response = await runRequest({}, 'user-42', {
      path: '/profile_sections/preview',
      method: 'POST',
      body: {
        section: 'rules',
        structured: { rules: { trainingsPerWeek: 5 } },
        previousHash: 'hash-123',
      },
    });
    assert.strictEqual(response.statusCode, 200);

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

    console.log('ok - db_proxy forwards db reads/writes and handles user_id/auth');
  } finally {
    global.fetch = originalFetch;
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
