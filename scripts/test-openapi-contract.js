#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

const { createApp } = require('../server');

const gatewaySchemaPath = path.resolve(__dirname, '..', 'openapi.actions.json');
const productSchemaPath = path.resolve(__dirname, '..', '..', 'stas.run', 'product', 'gpt-actions-current.json');

const expectedActionsPaths = [
  '/gw/api/me',
  '/gw/api/db/user_summary',
  '/gw/api/db/trainings',
  '/gw/api/db/activity_detail',
  '/gw/api/db/profile_sections',
  '/gw/api/db/profile_sections/preview',
  '/gw/api/db/profile_sections/commit',
  '/gw/api/db/profile_changes',
  '/gw/api/db/profile_changes/{changeId}/restore',
  '/gw/icu/events',
  '/gw/trainings',
  '/gw/user_summary',
  '/gw/strategy',
];

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => (
      `${JSON.stringify(key)}:${stableStringify(value[key])}`
    )).join(',')}}`;
  }
  return JSON.stringify(value);
}

function assertSemanticEqual(actual, expected, message) {
  assert.equal(stableStringify(actual), stableStringify(expected), message);
}

function findBadRequiredReferences(root) {
  const bad = [];

  function walk(node, location) {
    if (!node || typeof node !== 'object') return;

    if (node.type === 'object' && Array.isArray(node.required)) {
      const properties = node.properties || {};
      for (const requiredKey of node.required) {
        if (!Object.prototype.hasOwnProperty.call(properties, requiredKey)) {
          bad.push(`${location}.required includes missing property ${requiredKey}`);
        }
      }
    }

    for (const [key, value] of Object.entries(node)) {
      walk(value, `${location}.${key}`);
    }
  }

  walk(root, '$');
  return bad;
}

async function listen(app) {
  return new Promise((resolve, reject) => {
    const server = http.createServer(app);
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

async function close(server) {
  await new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

async function fetchText(baseUrl, pathname) {
  const response = await fetch(`${baseUrl}${pathname}`);
  return {
    status: response.status,
    contentType: response.headers.get('content-type') || '',
    body: await response.text(),
  };
}

async function main() {
  const gatewayBytes = fs.readFileSync(gatewaySchemaPath);
  const productBytes = fs.readFileSync(productSchemaPath);
  const gatewaySchema = JSON.parse(gatewayBytes);
  const productSchema = JSON.parse(productBytes);

  assertSemanticEqual(
    productSchema,
    gatewaySchema,
    'stas.run product Actions schema must semantically match gateway openapi.actions.json'
  );

  const app = createApp();
  const server = await listen(app);
  const address = server.address();
  const baseUrl = `http://${address.address}:${address.port}`;

  try {
    const canonical = await fetchText(baseUrl, '/gw/openapi.json');
    const actions = await fetchText(baseUrl, '/gw/openapi.actions.json');

    assert.equal(canonical.status, 200, '/gw/openapi.json must return 200');
    assert.equal(actions.status, 200, '/gw/openapi.actions.json must return 200');
    assert.match(canonical.contentType, /^application\/json\b/);
    assert.match(actions.contentType, /^application\/json\b/);
    assert.equal(canonical.body, actions.body, 'canonical OpenAPI endpoints must return identical bytes');

    const servedSchema = JSON.parse(canonical.body);
    assertSemanticEqual(servedSchema, gatewaySchema, 'served canonical schema must match openapi.actions.json');

    for (const stalePath of ['/gw/openapi.yaml', '/gw/openapi.min.json', '/gw/openapi.min.yaml']) {
      const stale = await fetchText(baseUrl, stalePath);
      assert.equal(stale.status, 410, `${stalePath} must return 410 Gone`);
      assert.match(stale.contentType, /^application\/json\b/);
      const body = JSON.parse(stale.body);
      assert.equal(body.error, 'openapi_variant_gone');
      assert.equal(body.canonical, '/gw/openapi.json');
      assert.equal(body.path, stalePath);
    }
  } finally {
    await close(server);
  }

  const pathNames = Object.keys(gatewaySchema.paths || {});
  assert.equal(pathNames.length, expectedActionsPaths.length, 'canonical schema must expose exactly 13 Actions paths');
  assert.deepEqual(
    [...pathNames].sort(),
    [...expectedActionsPaths].sort(),
    'canonical schema must expose the expected Actions paths'
  );

  const securitySchemes = gatewaySchema.components?.securitySchemes || {};
  assert.deepEqual(Object.keys(securitySchemes), ['oauth2'], 'canonical schema must expose only oauth2 security');

  const oauth2 = securitySchemes.oauth2;
  assert.equal(oauth2.type, 'oauth2');
  assert.deepEqual(Object.keys(oauth2.flows || {}), ['authorizationCode']);

  const authorizationCode = oauth2.flows.authorizationCode;
  assert.equal(authorizationCode.authorizationUrl, 'https://intervals.stas.run/gw/oauth/authorize');
  assert.equal(authorizationCode.tokenUrl, 'https://intervals.stas.run/gw/oauth/token');
  assert.ok(Object.keys(authorizationCode.scopes || {}).length > 0, 'oauth2 scopes must be declared');

  const securityStory = stableStringify(securitySchemes).toLowerCase();
  for (const forbidden of ['stas-id', 'stas id', 'user_id', 'bearer', 'clientcredentials', 'password', 'implicit']) {
    assert.equal(securityStory.includes(forbidden), false, `security scheme must not mention ${forbidden}`);
  }

  const fullSchemaText = stableStringify(gatewaySchema).toLowerCase();
  if (fullSchemaText.includes('pkce') || fullSchemaText.includes('code_challenge')) {
    assert.ok(fullSchemaText.includes('s256'), 'PKCE, if represented, must use S256');
    assert.equal(fullSchemaText.includes('code_challenge_method=plain'), false, 'PKCE plain method must not be represented');
  }

  const badRequiredReferences = findBadRequiredReferences(gatewaySchema);
  assert.deepEqual(badRequiredReferences, [], 'object schemas must not require missing properties');

  const dbTrainings = gatewaySchema.paths['/gw/api/db/trainings'].get;
  assert.equal(
    dbTrainings.responses['200'].content['application/json'].schema.$ref,
    '#/components/schemas/TrainingsListResponse',
    '/gw/api/db/trainings must document the runtime bare-array response'
  );

  const gwTrainings = gatewaySchema.paths['/gw/trainings'].get;
  assert.equal(
    gwTrainings.responses['200'].content['application/json'].schema.$ref,
    '#/components/schemas/TrainingsListResponse',
    '/gw/trainings success schema must stay a bare array'
  );
  for (const status of ['502', '504']) {
    assert.equal(
      gwTrainings.responses[status].content['application/json'].schema.$ref,
      '#/components/schemas/ErrorResponse',
      `/gw/trainings ${status} must document typed JSON errors`
    );
  }
  assert.equal(
    stableStringify(gwTrainings).toLowerCase().includes('full raw'),
    false,
    '/gw/trainings descriptions must not promise full raw data'
  );
  assert.equal(gatewaySchema.components.schemas.ErrorResponse.properties.retryable.type, 'boolean');
  assert.equal(gatewaySchema.components.schemas.ErrorResponse.properties.upstream_status.type, 'integer');

  const createEventsPost = gatewaySchema.paths['/gw/icu/events'].post;
  const createEventsParams = createEventsPost.parameters || [];
  const dryRunParam = createEventsParams.find((param) => (
    param.name === 'dry_run' && param.in === 'query'
  ));
  assert.ok(dryRunParam, 'POST /gw/icu/events must expose dry_run as a query parameter');
  assert.equal(dryRunParam.required, true, 'POST /gw/icu/events dry_run query parameter must be required');
  assert.equal(
    createEventsPost.requestBody.content['application/json'].schema.$ref,
    '#/components/schemas/CreatePlannedWorkoutsRequest',
    'POST /gw/icu/events body schema must stay separate from dry_run query parameter'
  );
  const bulkCreateResult = gatewaySchema.components.schemas.BulkCreateResult;
  assert.equal(bulkCreateResult.properties.dry_run.type, 'boolean');
  assert.equal(bulkCreateResult.properties.errors.type, 'array');
  assert.deepEqual(
    bulkCreateResult.required,
    ['ok'],
    'BulkCreateResult must not require fields that are absent from dry-run previews or dedupe responses'
  );
  assert.equal(
    bulkCreateResult.additionalProperties,
    true,
    'BulkCreateResult must allow upstream diagnostic fields such as events or icu'
  );

  const gatewaySha = sha256(gatewayBytes);
  const productSha = sha256(productBytes);
  const byteEquivalent = gatewayBytes.equals(productBytes);
  if (byteEquivalent) {
    assert.equal(gatewaySha, productSha, 'byte-equivalent schemas must have matching SHA-256');
  }

  console.log(`ok - OpenAPI contract canonicalized (gateway=${gatewaySha}, product=${productSha}, byteEqual=${byteEquivalent})`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
