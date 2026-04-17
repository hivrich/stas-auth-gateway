function trimToString(value) {
  if (value === null || value === undefined) return '';
  return String(value).trim();
}

function normalizeSource(value) {
  return trimToString(value).toLowerCase() === 'claude' ? 'claude' : 'gpt';
}

function getRequestSource(req) {
  const header =
    req?.get?.('x-stas-source') ||
    req?.headers?.['x-stas-source'] ||
    req?.headers?.['X-Stas-Source'];

  return normalizeSource(header);
}

function isClaudeClientId(clientId) {
  const normalized = trimToString(clientId).toLowerCase();
  if (!normalized) return false;

  const configured = trimToString(process.env.CLAUDE_OAUTH_CLIENT_ID).toLowerCase();
  if (configured && normalized === configured) return true;

  return normalized.includes('claude');
}

function isClaudeRedirectUri(redirectUri) {
  const raw = trimToString(redirectUri);
  if (!raw) return false;

  try {
    const url = new URL(raw);
    return `${url.hostname}${url.pathname}`.toLowerCase().includes('claude');
  } catch {
    return raw.toLowerCase().includes('claude');
  }
}

function resolveOauthSource({ clientId, redirectUri }) {
  if (isClaudeClientId(clientId) || isClaudeRedirectUri(redirectUri)) {
    return 'claude';
  }

  return 'gpt';
}

function buildStasSourceHeaders(req, extraHeaders = {}) {
  return {
    ...extraHeaders,
    'x-stas-source': getRequestSource(req),
  };
}

module.exports = {
  buildStasSourceHeaders,
  getRequestSource,
  normalizeSource,
  resolveOauthSource,
};
