const crypto = require('node:crypto');
const jwt = require('jsonwebtoken');
const { ASSERTION_TYPE } = require('../../lib/mcp-private-key-jwt');

const CLIENT_ID = 'https://chatgpt.com/oauth/client.json';
const JWKS_URI = 'https://chatgpt.com/oauth/jwks.json';
const CALLBACK = 'https://chatgpt.com/connector_platform_oauth_redirect';
const AUDIENCE = 'https://intervals.stas.run/gw/oauth/token';

function makeKey(kid = 'local-test-key') {
  const pair = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  return { ...pair, jwk: { ...pair.publicKey.export({ format: 'jwk' }), kid, alg: 'RS256', use: 'sig' } };
}

function metadata(overrides = {}) {
  return {
    client_id: CLIENT_ID, client_name: 'ChatGPT', client_uri: 'https://chatgpt.com',
    redirect_uris: [CALLBACK], grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'], token_endpoint_auth_method: 'private_key_jwt',
    jwks_uri: JWKS_URI, ...overrides,
  };
}

function assertionRequest(key, overrides = {}, options = {}) {
  const now = Math.floor((options.now ?? Date.now()) / 1000);
  const payload = { iss: CLIENT_ID, sub: CLIENT_ID, aud: AUDIENCE, iat: now, exp: now + 120, jti: crypto.randomUUID(), ...overrides };
  for (const field of Object.keys(payload)) if (payload[field] === undefined) delete payload[field];
  const assertion = jwt.sign(payload, key.privateKey, {
    algorithm: 'RS256', header: { kid: key.jwk.kid, ...options.header },
  });
  return { body: { client_id: CLIENT_ID, client_assertion_type: ASSERTION_TYPE, client_assertion: assertion }, headers: {} };
}

module.exports = { CLIENT_ID, JWKS_URI, CALLBACK, AUDIENCE, makeKey, metadata, assertionRequest };
