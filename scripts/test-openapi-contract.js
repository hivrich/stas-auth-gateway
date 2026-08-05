#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

const { createApp } = require('../server');

const gatewaySchemaPath = path.resolve(__dirname, '..', 'openapi.actions.json');
const productSchemaPath = process.env.STAS_PRODUCT_ACTIONS_SCHEMA
  ? path.resolve(process.env.STAS_PRODUCT_ACTIONS_SCHEMA)
  : path.resolve(__dirname, '..', '..', 'stas.run', 'product', 'gpt-actions-current.json');

const expectedActionsPaths = [
  '/gw/api/me',
  '/gw/api/db/user_summary',
  '/gw/api/db/activity_detail',
  '/gw/api/db/goals/editable',
  '/gw/api/db/goals/activity-candidates',
  '/gw/api/db/goals/changes/apply',
  '/gw/api/db/profile_sections',
  '/gw/api/db/profile_sections/save',
  '/gw/api/db/profile_changes',
  '/gw/api/db/profile_changes/{changeId}',
  '/gw/api/db/profile_changes/{changeId}/restore',
  '/gw/icu/events',
  '/gw/trainings',
  '/gw/api/db/user_summary/v2',
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

function findBrokenLocalRefs(root) {
  const broken = [];

  function resolveLocalRef(ref) {
    return ref.slice(2).split('/').reduce((value, part) => {
      const key = part.replaceAll('~1', '/').replaceAll('~0', '~');
      return value && Object.prototype.hasOwnProperty.call(value, key) ? value[key] : undefined;
    }, root);
  }

  function walk(node, location) {
    if (!node || typeof node !== 'object') return;
    if (typeof node.$ref === 'string' && node.$ref.startsWith('#/') && resolveLocalRef(node.$ref) === undefined) {
      broken.push(`${location} points to missing ${node.$ref}`);
    }
    for (const [key, value] of Object.entries(node)) {
      walk(value, `${location}.${key}`);
    }
  }

  walk(root, '$');
  return broken;
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
  assert.equal(
    pathNames.length,
    expectedActionsPaths.length,
    `canonical schema must expose exactly ${expectedActionsPaths.length} Actions paths`,
  );
  assert.deepEqual(
    [...pathNames].sort(),
    [...expectedActionsPaths].sort(),
    'canonical schema must expose the expected Actions paths'
  );

  const operationsById = new Map();
  for (const pathItem of Object.values(gatewaySchema.paths || {})) {
    for (const operation of Object.values(pathItem || {})) {
      if (operation && typeof operation === 'object' && operation.operationId) {
        operationsById.set(operation.operationId, operation);
      }
    }
  }
  const nonConsequentialOperations = [
    'getMe',
    'getUserSummary',
    'getActivityDetailFromDB',
    'readProfileSections',
    'readProfileChangeHistory',
    'getPlannedWorkoutsGw',
    'getTrainings',
    'getUserSummaryGw',
    'getEditableGoalsResults',
    'getGoalActivityCandidates',
    'readProfileChangeDetail',
  ];
  const writeOperationsUsingPlatformDefaults = [
    'saveProfileSection',
    'restoreProfileChange',
    'deletePlannedWorkouts',
    'createPlannedWorkoutsGw',
    'writeStrategy',
    'applyGoalResultChange',
  ];
  assert.equal(
    operationsById.size,
    nonConsequentialOperations.length + writeOperationsUsingPlatformDefaults.length,
    'every Actions operation must have an expected confirmation classification',
  );
  for (const operationId of nonConsequentialOperations) {
    assert.equal(
      operationsById.get(operationId)?.['x-openai-isConsequential'],
      false,
      `${operationId} must not request platform confirmation`,
    );
  }
  for (const operationId of writeOperationsUsingPlatformDefaults) {
    assert.equal(
      operationsById.get(operationId)?.['x-openai-isConsequential'],
      undefined,
      `${operationId} must use the platform default instead of forcing the looping confirmation flag`,
    );
  }

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
  const brokenLocalRefs = findBrokenLocalRefs(gatewaySchema);
  assert.deepEqual(brokenLocalRefs, [], 'all local schema references must resolve');

  const editableGoals = gatewaySchema.paths['/gw/api/db/goals/editable'];
  assert.deepEqual(Object.keys(editableGoals), ['get'], 'editable goals must stay GET-only');
  assert.equal(editableGoals.get.operationId, 'getEditableGoalsResults');
  assert.equal(
    editableGoals.get.responses['200'].content['application/json'].schema.$ref,
    '#/components/schemas/EditableGoalsResultsResponse',
  );
  const applyGoalResult = gatewaySchema.paths['/gw/api/db/goals/changes/apply'].post;
  assert.equal(applyGoalResult.operationId, 'applyGoalResultChange');
  assert.equal(applyGoalResult['x-openai-isConsequential'], undefined);
  assert.deepEqual(
    applyGoalResult.requestBody.content['application/json'].schema.required,
    ['command'],
    'one-call goal writes must not require an externally fetched dataVersion or preview id',
  );
  assert.deepEqual(
    gatewaySchema.components.schemas.EditableGoalsResultsResponse.properties.bestResultVersion.type,
    ['string', 'null'],
    'editable goals must allow the real no-best-result null state',
  );
  assert.deepEqual(
    gatewaySchema.components.schemas.GoalResultChangeCommitResponse.properties.state
      .properties.bestResultVersion.type,
    ['string', 'null'],
    'one-call goal response must allow the real no-best-result null state',
  );
  assert.equal(gatewaySchema.components.schemas.GoalResultEditCommand.oneOf.length, 16);
  assert.equal(gatewaySchema.paths['/gw/api/db/goals/current'], undefined, 'retired current-goals path must stay absent');
  assert.equal(gatewaySchema.components.schemas.AnalysisProjectionResponse, undefined);

  const commandTypes = gatewaySchema.components.schemas.GoalResultEditCommand.oneOf
    .flatMap((variant) => variant.properties.type.enum)
    .sort();
  assert.deepEqual(commandTypes, [
    'general_archive',
    'general_create',
    'general_update',
    'legacy_result_convert',
    'legacy_result_delete',
    'manual_result_create',
    'manual_result_delete',
    'manual_result_update',
    'result_detach_activity',
    'result_link_activity',
    'result_set',
    'start_cancel',
    'start_create',
    'start_delete',
    'start_dns',
    'start_update',
  ]);

  const profileSections = gatewaySchema.paths['/gw/api/db/profile_sections'].get;
  const activeProfileSection = profileSections.responses['200'].content['application/json']
    .schema.properties.sections.items.$ref;
  assert.equal(activeProfileSection, '#/components/schemas/ActiveProfileSection');
  assert.deepEqual(gatewaySchema.components.schemas.ActiveProfileSection.properties.section.enum, ['profile', 'rules']);
  assert.equal(gatewaySchema.components.schemas.ProfileMemoryStructuredGoals, undefined);
  assert.equal(gatewaySchema.components.schemas.ProfileMemoryStructuredInput, undefined);

  const profileSave = gatewaySchema.paths['/gw/api/db/profile_sections/save'].post;
  assert.equal(
    profileSave.responses['200'].content['application/json'].schema.$ref,
    '#/components/schemas/ProfileSectionSaveResponse'
  );
  assert.equal(profileSave.operationId, 'saveProfileSection');
  assert.equal(profileSave['x-openai-isConsequential'], undefined);
  assert.deepEqual(
    gatewaySchema.components.schemas.ProfileSectionSaveRequest.required,
    ['section', 'structured'],
    'one-call profile writes must not require an externally fetched hash or preview id',
  );

  const profileHistory = gatewaySchema.paths['/gw/api/db/profile_changes'].get;
  assert.equal(profileHistory.operationId, 'readProfileChangeHistory');
  assert.equal(
    profileHistory.responses['200'].content['application/json'].schema.$ref,
    '#/components/schemas/ProfileMemoryHistoryPage'
  );
  assert.equal(profileHistory.parameters.find((parameter) => parameter.name === 'limit').schema.maximum, 20);
  assert.ok(profileHistory.parameters.some((parameter) => parameter.name === 'cursor'));
  const profileDetail = gatewaySchema.paths['/gw/api/db/profile_changes/{changeId}'].get;
  assert.equal(profileDetail.operationId, 'readProfileChangeDetail');

  const gwTrainings = gatewaySchema.paths['/gw/trainings'].get;
  assert.equal(gwTrainings.operationId, 'getTrainings');
  assert.equal(
    gwTrainings.parameters.find((parameter) => parameter.name === 'full')?.schema?.default,
    false,
    '/gw/trainings must default to the compact index mode'
  );
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
  assert.equal(
    gatewaySchema.components.schemas.TrainingFull.properties.listDetail.$ref,
    '#/components/schemas/TrainingListDetail',
    'every training item must expose exact list-delivery accounting'
  );
  assert.equal(gatewaySchema.components.schemas.ErrorResponse.properties.retryable.type, 'boolean');
  assert.equal(gatewaySchema.components.schemas.ErrorResponse.properties.upstream_status.type, 'integer');

  const userSummaryV2 = gatewaySchema.paths['/gw/api/db/user_summary/v2'].get;
  assert.ok(
    userSummaryV2.description.length <= 300,
    'GPT Actions operation description must not exceed 300 characters'
  );

  const createEventsPost = gatewaySchema.paths['/gw/icu/events'].post;
  const deleteEvents = gatewaySchema.paths['/gw/icu/events'].delete;
  const writeStrategy = gatewaySchema.paths['/gw/strategy'].post;
  assert.equal(createEventsPost['x-openai-isConsequential'], undefined);
  assert.equal(deleteEvents['x-openai-isConsequential'], undefined);
  assert.equal(writeStrategy.operationId, 'writeStrategy');
  assert.equal(writeStrategy['x-openai-isConsequential'], undefined);
  for (const operation of [createEventsPost, deleteEvents, writeStrategy, profileSave, applyGoalResult]) {
    assert.ok(operation.description.length <= 300, `${operation.operationId} description must fit GPT Actions limit`);
  }
  for (const operation of [createEventsPost, deleteEvents, writeStrategy, profileSave, applyGoalResult]) {
    assert.match(operation.description, /call once|single confirmed/i);
    assert.match(operation.description, /do not (call|read)/i);
  }
  const actionsStory = stableStringify(gatewaySchema.paths);
  assert.equal(actionsStory.includes('previewPlannedWorkoutsGw'), false);
  assert.equal(actionsStory.includes('previewProfileSectionChange'), false);
  assert.equal(actionsStory.includes('commitProfileSectionChange'), false);
  assert.equal(actionsStory.includes('previewGoalResultChange'), false);
  assert.equal(actionsStory.includes('commitGoalResultChange'), false);
  const createEventsParams = createEventsPost.parameters || [];
  const dryRunParam = createEventsParams.find((param) => (
    param.name === 'dry_run' && param.in === 'query'
  ));
  assert.ok(dryRunParam, 'POST /gw/icu/events must expose dry_run as a query parameter');
  assert.equal(dryRunParam.required, true, 'POST /gw/icu/events dry_run query parameter must be required');
  assert.deepEqual(dryRunParam.schema.enum, [false], 'POST /gw/icu/events must only expose confirmed writes');
  const deleteDryRunParam = deleteEvents.parameters.find((param) => (
    param.name === 'dry_run' && param.in === 'query'
  ));
  assert.ok(deleteDryRunParam, 'DELETE /gw/icu/events must expose dry_run as a query parameter');
  assert.equal(deleteDryRunParam.required, true);
  assert.deepEqual(deleteDryRunParam.schema.enum, [false], 'DELETE /gw/icu/events must only expose confirmed deletes');
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
  assert.equal(byteEquivalent, true, 'stas.run product Actions schema must be byte-identical to gateway openapi.actions.json');
  assert.equal(gatewaySha, productSha, 'byte-identical schemas must have matching SHA-256');

  console.log(`ok - OpenAPI contract canonicalized (gateway=${gatewaySha}, product=${productSha}, byteEqual=${byteEquivalent})`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
