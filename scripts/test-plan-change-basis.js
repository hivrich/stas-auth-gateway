#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');

process.env.STAS_KEY = 'test-stas-key';
process.env.STAS_BASE = 'http://stas.local.test';

const { reportPlanChange, __testing } = require('../lib/plan-change-callback');
const originalFetch = global.fetch;
const calls = [];
let failFirst = false;

global.fetch = async (url, options = {}) => {
  calls.push({ url: String(url), body: options.body });
  const failed = failFirst;
  failFirst = false;
  return { ok: !failed, status: failed ? 503 : 200, body: { cancel: async () => {} } };
};

function req(changeBasis, requestId = 'basis-test-request') {
  return {
    query: changeBasis === undefined ? {} : { change_basis: changeBasis },
    changeBasisValidated: changeBasis,
    auth: { userId: 'athlete-1', authMode: 'intervals' },
    stasRequestId: requestId,
    headers: {},
    get: () => undefined,
  };
}

async function report(changeBasis, events = [], deleted = [], requestId) {
  const before = calls.length;
  await reportPlanChange(req(changeBasis, requestId), { events, deleted });
  return calls.slice(before).map((call) => JSON.parse(call.body));
}

async function main() {
  __testing.setTimings({ timeoutMs: 100, retryDelayMs: 10 });
  const a = { external_id: 'plan:a', frame_id: 'F-return-after-illness', frame_version: 1, decision_id: 'D4' };
  const b = { external_id: 'plan:b', frame_id: 'F-build-base', frame_version: 2, decision_id: 'D12' };

  let payloads = await report(JSON.stringify([a, b, { ...a, external_id: 'invalid', frame_id: 'bad' }]), [
    { action: 'created', sent: { external_id: 'plan:a', name: 'A' }, row: { id: 1, external_id: 'plan:a' } },
    { action: 'updated', sent: { external_id: 'plan:b', name: 'B' }, row: { id: 2, external_id: 'plan:b' } },
    { action: 'created', sent: { external_id: 'plan:unmatched' }, row: { id: 3, external_id: 'plan:unmatched' } },
  ]);
  assert.deepEqual(payloads[0].events.map((item) => item.basis), [
    { frame_id: a.frame_id, frame_version: a.frame_version, decision_id: a.decision_id },
    { frame_id: b.frame_id, frame_version: b.frame_version, decision_id: b.decision_id },
    undefined,
  ]);
  assert.equal(payloads[0].events[0].frame_id, undefined);

  payloads = await report(JSON.stringify([a]), [], [{ id: 4, row: { id: 4, external_id: 'plan:a' } }]);
  assert.deepEqual(payloads[0].deleted[0].basis, { frame_id: a.frame_id, frame_version: 1, decision_id: 'D4' });

  const unchangedEvent = [{ action: 'created', sent: { external_id: 'plan:a', name: 'A' }, row: { id: 5, external_id: 'plan:a' } }];
  const baselineStart = calls.length;
  const baseline = await report(undefined, unchangedEvent);
  const baselineBody = calls[baselineStart].body;
  const malformedStart = calls.length;
  const malformed = await report('{bad', unchangedEvent);
  assert.equal(calls[malformedStart].body, baselineBody);
  const object = await report(JSON.stringify(a), [{ action: 'created', sent: { external_id: 'plan:a' }, row: { id: 6, external_id: 'plan:a' } }]);
  const tooMany = await report(JSON.stringify(Array.from({ length: 101 }, (_, i) => ({ ...a, external_id: `plan:${i}` }))), [{ action: 'created', sent: { external_id: 'plan:0' }, row: { id: 7, external_id: 'plan:0' } }]);
  const tooLong = await report(' '.repeat(16001), [{ action: 'created', sent: { external_id: 'plan:a' }, row: { id: 8, external_id: 'plan:a' } }]);
  for (const [body] of [[baseline[0]], [malformed[0]], [object[0]], [tooMany[0]], [tooLong[0]]]) {
    assert.equal(Object.hasOwn(body.events[0], 'basis'), false);
  }

  const nine = Array.from({ length: 9 }, (_, i) => ({ action: 'created', sent: { external_id: `plan:${i}` }, row: { id: 20 + i, external_id: `plan:${i}` } }));
  const grouped = await report(undefined, nine, [], 'grouped-request');
  assert.equal(grouped.length, 2);
  assert.equal(grouped[0].events.length, 8);
  assert.equal(grouped[0].request_id, 'grouped-request');
  assert.equal(grouped[1].request_id, 'grouped-request#2');

  failFirst = true;
  const retryStart = calls.length;
  await report(undefined, [{ action: 'created', sent: { external_id: 'retry' }, row: { id: 40, external_id: 'retry' } }], [], 'retry-request');
  await new Promise((resolve) => setTimeout(resolve, 30));
  const retryCalls = calls.slice(retryStart).map((call) => call.body);
  assert.equal(retryCalls.length, 2);
  assert.equal(retryCalls[0], retryCalls[1]);
  assert.equal(JSON.parse(retryCalls[0]).request_id, 'retry-request');

  console.log('ok - basis parsing, event/deletion association, bounded input, legacy payload, grouping and retry idempotency');
}

main().finally(() => {
  global.fetch = originalFetch;
  __testing.setTimings({});
}).catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
