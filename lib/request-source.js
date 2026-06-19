const DEFAULT_CLAUDE_OAUTH_CLIENT_ID = 'claude-public-client';
const SUPPORTED_REQUEST_SOURCES = new Set(['gpt', 'claude']);
const CLAUDE_CALLBACK_PATHS = new Set(['/api/mcp/auth_callback']);
const CLAUDE_ALLOWED_HOSTS = new Set(['claude.ai', 'claude.com']);
const CHATGPT_ALLOWED_HOSTS = new Set(['chat.openai.com', 'chatgpt.com']);
const CHATGPT_CALLBACK_PATH_RE = /^\/aip\/g-[^/]+\/oauth\/callback$/;

function trimToString(value) {
  if (value === null || value === undefined) return '';
  return String(value).trim();
}

function normalizeSource(value, fallback = 'gpt') {
  const normalized = trimToString(value).toLowerCase();
  if (SUPPORTED_REQUEST_SOURCES.has(normalized)) return normalized;
  return fallback;
}

function getRequestSource(req) {
  const header =
    req?.get?.('x-stas-source') ||
    req?.headers?.['x-stas-source'] ||
    req?.headers?.['X-Stas-Source'];

  return normalizeSource(header);
}

function getClaudeOauthClientId() {
  return trimToString(process.env.CLAUDE_OAUTH_CLIENT_ID) || DEFAULT_CLAUDE_OAUTH_CLIENT_ID;
}

function isAllowedClaudeClientId(clientId) {
  const raw = trimToString(clientId);
  return Boolean(raw && raw === getClaudeOauthClientId());
}

function parseHttpsUrl(value) {
  const raw = trimToString(value);
  if (!raw) return null;

  try {
    const url = new URL(raw);
    if (url.protocol !== 'https:') return null;
    return url;
  } catch {
    return null;
  }
}

function hasNoQueryOrHash(url) {
  return !url.search && !url.hash;
}

function isAllowedClaudeRedirectUri(uri) {
  const url = parseHttpsUrl(uri);
  return Boolean(
    url &&
    hasNoQueryOrHash(url) &&
    CLAUDE_ALLOWED_HOSTS.has(url.hostname) &&
    CLAUDE_CALLBACK_PATHS.has(url.pathname),
  );
}

function isAllowedChatGptRedirectUri(uri) {
  const url = parseHttpsUrl(uri);
  return Boolean(
    url &&
    hasNoQueryOrHash(url) &&
    CHATGPT_ALLOWED_HOSTS.has(url.hostname) &&
    CHATGPT_CALLBACK_PATH_RE.test(url.pathname),
  );
}

function resolveOauthSource({ clientId, redirectUri } = {}) {
  if (isAllowedClaudeClientId(clientId) || isAllowedClaudeRedirectUri(redirectUri)) {
    return 'claude';
  }

  if (isAllowedChatGptRedirectUri(redirectUri)) {
    return 'gpt';
  }

  return null;
}

function buildStasSourceHeaders(req, extraHeaders = {}) {
  return {
    ...extraHeaders,
    'x-stas-source': getRequestSource(req),
  };
}

module.exports = {
  buildStasSourceHeaders,
  getClaudeOauthClientId,
  getRequestSource,
  isAllowedChatGptRedirectUri,
  isAllowedClaudeClientId,
  isAllowedClaudeRedirectUri,
  normalizeSource,
  resolveOauthSource,
};
