#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');

process.env.STAS_BASE = 'http://stas.local.test';
process.env.STAS_KEY = 'test-stas-key';

const originalFetch = global.fetch;
const upstreamHits = [];
let responses = [];

function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
  };
}

global.fetch = async (url, options = {}) => {
  const next = responses.shift();
  if (!next) throw new Error(`unexpected upstream call: ${url}`);
  upstreamHits.push({
    url: new URL(String(url)),
    method: options.method || 'GET',
    headers: options.headers || {},
    body: options.body ? JSON.parse(options.body) : undefined,
  });
  return jsonResponse(next.body, next.status);
};

const {
  applyGoalResultChange,
  saveProfileSection,
} = require('../routes/single_call_writes').__testing;

function makeReq(body, userId = 'user-42') {
  return {
    body,
    query: { user_id: 'untrusted-query-user' },
    headers: {},
    auth: userId ? { userId, source: 'gpt', authMode: 'test' } : undefined,
    user_id: userId || undefined,
    get(name) {
      return this.headers[String(name).toLowerCase()];
    },
  };
}

function makeRes() {
  return {
    statusCode: 200,
    jsonBody: undefined,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.jsonBody = body;
      return this;
    },
  };
}

function assertHit(index, method, pathname, userId = 'user-42') {
  const hit = upstreamHits[index];
  assert.equal(hit.method, method);
  assert.equal(hit.url.pathname, pathname);
  assert.equal(hit.url.searchParams.get('user_id'), userId);
  assert.equal(hit.headers['X-API-Key'], 'test-stas-key');
  assert.equal(hit.headers['x-stas-source'], 'gpt');
}

async function testProfileSave() {
  upstreamHits.length = 0;
  responses = [
    { body: { sections: [{ section: 'rules', hash: 'hash-1' }] } },
    { body: { ok: true, noChange: false, change: { id: 17 } } },
    { body: { ok: true, change: { id: 17 }, section: { section: 'rules', targetField: 'rules', text: 'Rule', hash: 'hash-2', enabled: true } } },
  ];

  const response = makeRes();
  await saveProfileSection(makeReq({
    section: 'rules',
    structured: { rules: { additionalRules: ['No intensity after poor sleep'] } },
    diffSummary: 'Add sleep safety rule',
  }), response);

  assert.equal(response.statusCode, 200);
  assert.equal(response.jsonBody.ok, true);
  assert.equal(response.jsonBody.saved, true);
  assert.equal(response.jsonBody.noChange, false);
  assert.equal(responses.length, 0);
  assert.equal(upstreamHits.length, 3, 'one external profile Action must finish all internal steps');
  assertHit(0, 'GET', '/api/db/profile_sections');
  assertHit(1, 'POST', '/api/db/profile_sections/preview');
  assert.deepEqual(upstreamHits[1].body, {
    section: 'rules',
    structured: { rules: { additionalRules: ['No intensity after poor sleep'] } },
    previousHash: 'hash-1',
    diffSummary: 'Add sleep safety rule',
  });
  assertHit(2, 'POST', '/api/db/profile_sections/commit');
  assert.deepEqual(upstreamHits[2].body, { changeId: 17 });
}

async function testProfileNoChange() {
  upstreamHits.length = 0;
  responses = [
    { body: { sections: [{ section: 'profile', hash: 'same-hash' }] } },
    { body: { ok: true, noChange: true, change: null, section: { section: 'profile', targetField: 'info', text: 'Same', hash: 'same-hash', enabled: true } } },
  ];

  const response = makeRes();
  await saveProfileSection(makeReq({
    section: 'profile',
    structured: { profile: { city: 'Moscow' } },
  }), response);

  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.jsonBody, {
    ok: true,
    saved: false,
    noChange: true,
    section: { section: 'profile', targetField: 'info', text: 'Same', hash: 'same-hash', enabled: true },
  });
  assert.equal(upstreamHits.length, 2);
}

async function testGoalApply() {
  upstreamHits.length = 0;
  responses = [
    { body: { dataVersion: 'a'.repeat(64) } },
    { body: { ok: true, preview: { changeId: 23, operation: 'general_create' } } },
    { body: { ok: true, changeId: 23, replay: false, state: { version: 2, dataVersion: 'b'.repeat(64), items: [], omittedCount: 0, bestResultVersion: null, manualResults: [], legacyResults: [] } } },
  ];

  const command = {
    type: 'general_create',
    operationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    title: 'Run consistently',
  };
  const response = makeRes();
  await applyGoalResultChange(makeReq({ command }), response);

  assert.equal(response.statusCode, 200);
  assert.equal(response.jsonBody.ok, true);
  assert.equal(response.jsonBody.changeId, 23);
  assert.equal(upstreamHits.length, 3, 'one external goal Action must finish all internal steps');
  assertHit(0, 'GET', '/api/db/goals/editable');
  assertHit(1, 'POST', '/api/db/goals/changes/preview');
  assert.deepEqual(upstreamHits[1].body, {
    expectedDataVersion: 'a'.repeat(64),
    command,
  });
  assertHit(2, 'POST', '/api/db/goals/changes/commit');
  assert.deepEqual(upstreamHits[2].body, { changeId: 23 });
}

async function testMissingAuthStopsBeforeUpstream() {
  upstreamHits.length = 0;
  responses = [];
  const response = makeRes();
  await saveProfileSection(makeReq({ section: 'rules', structured: {} }, null), response);
  assert.equal(response.statusCode, 401);
  assert.equal(response.jsonBody.error, 'missing_or_invalid_token');
  assert.equal(upstreamHits.length, 0);
}

async function testInvalidSuccessfulUpstreamBodyFailsClosed() {
  upstreamHits.length = 0;
  responses = [
    { body: { sections: [{ section: 'rules', hash: 'hash-1' }] } },
    { body: { ok: true, noChange: false, change: { id: 31 } } },
    { body: {} },
  ];

  const profileResponse = makeRes();
  await saveProfileSection(makeReq({ section: 'rules', structured: { rules: {} } }), profileResponse);
  assert.equal(profileResponse.statusCode, 502);
  assert.equal(profileResponse.jsonBody.error, 'profile_commit_invalid');

  upstreamHits.length = 0;
  responses = [
    { body: { dataVersion: 'a'.repeat(64) } },
    { body: { ok: true, preview: { changeId: 32 } } },
    { body: { ok: true } },
  ];

  const goalResponse = makeRes();
  await applyGoalResultChange(makeReq({
    command: {
      type: 'general_create',
      operationId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      title: 'Stay healthy',
    },
  }), goalResponse);
  assert.equal(goalResponse.statusCode, 502);
  assert.equal(goalResponse.jsonBody.error, 'goal_commit_invalid');
}

async function main() {
  try {
    await testProfileSave();
    await testProfileNoChange();
    await testGoalApply();
    await testMissingAuthStopsBeforeUpstream();
    await testInvalidSuccessfulUpstreamBodyFailsClosed();
    console.log('ok - single-call writes complete internal read, validation, and commit');
  } finally {
    global.fetch = originalFetch;
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
