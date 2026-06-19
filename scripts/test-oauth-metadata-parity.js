#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const stasDiscoveryPath = path.resolve(__dirname, '..', '..', 'stas.run', 'src', 'lib', 'oauth-discovery.ts');

function readFile(filePath) {
  return fs.readFileSync(filePath, 'utf8');
}

function readExportedString(source, name, constants = {}) {
  const match = source.match(new RegExp(`export const ${name} = "([^"]+)";`));
  if (match) return match[1];

  const templateMatch = source.match(new RegExp(`export const ${name} = \`\\$\\{([A-Z0-9_]+)\\}([^\`]*)\`;`));
  if (templateMatch && constants[templateMatch[1]]) {
    return `${constants[templateMatch[1]]}${templateMatch[2]}`;
  }

  assert.fail(`expected ${name} in stas.run oauth-discovery.ts`);
}

function readExportedStringArray(source, name) {
  const match = source.match(new RegExp(`export const ${name} = \\[([\\s\\S]*?)\\] as const;`));
  assert.ok(match, `expected ${name} in stas.run oauth-discovery.ts`);
  return Array.from(match[1].matchAll(/"([^"]+)"/g), (item) => item[1]);
}

function assertIncludesAll(actual, expected, message) {
  for (const value of expected) {
    assert.ok(actual.includes(value), `${message}: missing ${value}`);
  }
}

function assertNoPlainPkce(value, label) {
  const methods = Array.isArray(value) ? value.map((item) => String(item).toLowerCase()) : [];
  assert.equal(methods.includes('plain'), false, `${label} must not advertise plain PKCE`);
}

const oldEnv = {
  AGENT_AUTH_ENABLED: process.env.AGENT_AUTH_ENABLED,
  AGENT_AUTH_TOKEN_SECRET: process.env.AGENT_AUTH_TOKEN_SECRET,
  GATEWAY_BASE_URL: process.env.GATEWAY_BASE_URL,
  INTERVALS_CLIENT_ID: process.env.INTERVALS_CLIENT_ID,
  INTERVALS_CLIENT_SECRET: process.env.INTERVALS_CLIENT_SECRET,
};

process.env.AGENT_AUTH_ENABLED = 'true';
process.env.AGENT_AUTH_TOKEN_SECRET = 'hJ8sQ2vN5wR7xL0mC9pT4zA6bE3yU1kF';
process.env.GATEWAY_BASE_URL = 'https://intervals.stas.run';
process.env.INTERVALS_CLIENT_ID = 'metadata-parity-client';
process.env.INTERVALS_CLIENT_SECRET = 'metadata-parity-secret-0123456789';

try {
  const stasSource = readFile(stasDiscoveryPath);
  const issuer = readExportedString(stasSource, 'STAS_OAUTH_ISSUER');
  const constants = { STAS_OAUTH_ISSUER: issuer };
  const expected = {
    issuer,
    authorizationEndpoint: readExportedString(stasSource, 'STAS_OAUTH_AUTHORIZATION_ENDPOINT', constants),
    tokenEndpoint: readExportedString(stasSource, 'STAS_OAUTH_TOKEN_ENDPOINT', constants),
    registrationEndpoint: readExportedString(stasSource, 'STAS_OAUTH_REGISTRATION_ENDPOINT', constants),
    revocationEndpoint: readExportedString(stasSource, 'STAS_OAUTH_REVOCATION_ENDPOINT', constants),
    agentAuthSkillUrl: readExportedString(stasSource, 'STAS_AGENT_AUTH_SKILL_URL'),
    agentAuthIdentityEndpoint: readExportedString(stasSource, 'STAS_AGENT_AUTH_IDENTITY_ENDPOINT', constants),
    agentAuthClaimEndpoint: readExportedString(stasSource, 'STAS_AGENT_AUTH_CLAIM_ENDPOINT', constants),
    agentAuthScope: readExportedString(stasSource, 'STAS_AGENT_AUTH_SCOPE'),
    agentAuthClaimGrantType: readExportedString(stasSource, 'STAS_AGENT_AUTH_CLAIM_GRANT_TYPE'),
    oauthScopes: readExportedStringArray(stasSource, 'STAS_OAUTH_SCOPES'),
  };

  const { buildOAuthAuthorizationServerMetadata } = require('../lib/oauth-metadata');
  const metadata = buildOAuthAuthorizationServerMetadata('http://bridge-api:3001');

  assert.equal(metadata.issuer, expected.issuer);
  assert.equal(metadata.authorization_endpoint, expected.authorizationEndpoint);
  assert.equal(metadata.token_endpoint, expected.tokenEndpoint);
  assert.equal(metadata.registration_endpoint, expected.registrationEndpoint);
  assert.equal(metadata.revocation_endpoint, expected.revocationEndpoint);
  assert.deepEqual(metadata.response_types_supported, ['code']);
  assert.deepEqual(metadata.code_challenge_methods_supported, ['S256']);
  assertNoPlainPkce(metadata.code_challenge_methods_supported, 'gateway metadata');
  assertIncludesAll(metadata.grant_types_supported || [], ['authorization_code', expected.agentAuthClaimGrantType], 'grant_types_supported');
  assertIncludesAll(
    metadata.token_endpoint_auth_methods_supported || [],
    ['client_secret_basic', 'client_secret_post', 'none'],
    'token_endpoint_auth_methods_supported',
  );

  assert.ok(metadata.agent_auth, 'expected gateway metadata to advertise Agent Auth when configured');
  assert.equal(metadata.agent_auth.skill, expected.agentAuthSkillUrl);
  assert.equal(metadata.agent_auth.identity_endpoint, expected.agentAuthIdentityEndpoint);
  assert.equal(metadata.agent_auth.register_uri, expected.agentAuthIdentityEndpoint);
  assert.equal(metadata.agent_auth.claim_endpoint, expected.agentAuthClaimEndpoint);
  assert.equal(metadata.agent_auth.claim_uri, expected.agentAuthClaimEndpoint);
  assert.equal(metadata.agent_auth.token_endpoint, expected.tokenEndpoint);
  assert.equal(metadata.agent_auth.revocation_endpoint, expected.revocationEndpoint);
  assert.deepEqual(metadata.agent_auth.identity_types_supported, ['anonymous']);
  assert.deepEqual(metadata.agent_auth.credential_types_supported, ['bearer']);
  assert.deepEqual(metadata.agent_auth.anonymous.credential_types_supported, ['bearer']);
  assert.deepEqual(metadata.agent_auth.scopes_supported, [expected.agentAuthScope]);

  const schemaPath = path.resolve(__dirname, '..', 'openapi.actions.json');
  const schema = JSON.parse(readFile(schemaPath));
  const authorizationCode = schema.components?.securitySchemes?.oauth2?.flows?.authorizationCode;
  assert.ok(authorizationCode, 'expected authorizationCode flow in gateway OpenAPI');
  assert.equal(authorizationCode.authorizationUrl, expected.authorizationEndpoint);
  assert.equal(authorizationCode.tokenUrl, expected.tokenEndpoint);
  assertIncludesAll(Object.keys(authorizationCode.scopes || {}), expected.oauthScopes, 'OpenAPI OAuth scopes');

  const metadataText = JSON.stringify(metadata).toLowerCase();
  assert.equal(metadataText.includes('bridge-api'), false, 'gateway metadata must not leak internal compose host');
  assert.equal(metadataText.includes('127.0.0.1'), false, 'gateway metadata must not leak local request host');
  assert.equal(metadataText.includes('"plain"'), false, 'gateway metadata must not contain plain PKCE');

  console.log('ok - OAuth metadata uses canonical public base from internal host and matches STAS discovery expectations');
} finally {
  for (const [key, value] of Object.entries(oldEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}
