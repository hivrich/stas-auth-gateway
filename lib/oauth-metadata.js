const {
  AGENT_AUTH_GRANT_TYPE,
  buildAgentAuthMetadata,
  isAgentAuthConfigured,
} = require('./agent-auth');

function trimToString(value) {
  if (value === null || value === undefined) return '';
  return String(value).trim();
}

function buildOAuthAuthorizationServerMetadata(origin) {
  const base = trimToString(origin).replace(/\/+$/, '');
  const methods = ['client_secret_basic', 'client_secret_post'];
  if (process.env.INTERVALS_CLIENT_ID && process.env.INTERVALS_CLIENT_SECRET) {
    methods.push('none');
  }

  const metadata = {
    issuer: base,
    authorization_endpoint: `${base}/gw/oauth/authorize`,
    token_endpoint: `${base}/gw/oauth/token`,
    registration_endpoint: `${base}/gw/oauth/register`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code'],
    code_challenge_methods_supported: ['S256', 'plain'],
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
};
