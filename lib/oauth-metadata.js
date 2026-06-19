const {
  AGENT_AUTH_GRANT_TYPE,
  buildAgentAuthMetadata,
  isAgentAuthConfigured,
} = require('./agent-auth');

function trimToString(value) {
  if (value === null || value === undefined) return '';
  return String(value).trim();
}

function normalizeMetadataBaseUrl(value, label) {
  const raw = trimToString(value).replace(/\/+$/, '');

  if (!raw) {
    throw new Error(`${label}_missing`);
  }

  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`${label}_invalid`);
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`${label}_invalid_protocol`);
  }

  return parsed.toString().replace(/\/+$/, '');
}

function resolveOAuthMetadataBaseUrl(origin, env = process.env) {
  const configuredBase = trimToString(env.GATEWAY_BASE_URL);

  if (configuredBase) {
    return normalizeMetadataBaseUrl(configuredBase, 'GATEWAY_BASE_URL');
  }

  return normalizeMetadataBaseUrl(origin, 'request_origin');
}

function buildOAuthAuthorizationServerMetadata(origin, env = process.env) {
  const base = resolveOAuthMetadataBaseUrl(origin, env);
  const methods = ['client_secret_basic', 'client_secret_post'];
  if (env.INTERVALS_CLIENT_ID && env.INTERVALS_CLIENT_SECRET) {
    methods.push('none');
  }

  const metadata = {
    issuer: base,
    authorization_endpoint: `${base}/gw/oauth/authorize`,
    token_endpoint: `${base}/gw/oauth/token`,
    registration_endpoint: `${base}/gw/oauth/register`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: methods,
  };

  if (isAgentAuthConfigured()) {
    metadata.grant_types_supported = ['authorization_code', AGENT_AUTH_GRANT_TYPE];
    metadata.revocation_endpoint = `${base}/gw/oauth/revoke`;
    metadata.agent_auth = buildAgentAuthMetadata(base);
  }

  return metadata;
}

module.exports = {
  buildOAuthAuthorizationServerMetadata,
  resolveOAuthMetadataBaseUrl,
};
