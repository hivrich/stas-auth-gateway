const crypto = require('node:crypto');
const { stasRequestIdForwardHeaders } = require('./request-id');

const DEFAULT_CLAUDE_OAUTH_CLIENT_ID = 'claude-public-client';
const SUPPORTED_REQUEST_SOURCES = new Set(['gpt', 'claude', 'mcp', 'site']);
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

// Серверный вызов самого STAS: X-API-Key равен STAS_KEY. Сравнение постоянного
// времени по sha256 (длины не утекают); пустой или не заданный STAS_KEY не совпадает никогда.
function isStasServerRequest(req) {
  const expected = trimToString(process.env.STAS_KEY);
  const provided = trimToString(req?.get?.('x-api-key') || req?.headers?.['x-api-key']);
  if (!expected || !provided) return false;
  const left = crypto.createHash('sha256').update(provided).digest();
  const right = crypto.createHash('sha256').update(expected).digest();
  return crypto.timingSafeEqual(left, right);
}

function getRequestSource(req) {
  const authenticatedSource = normalizeSource(req?.auth?.source, null);
  if (authenticatedSource) return authenticatedSource;
  const header =
    req?.get?.('x-stas-source') ||
    req?.headers?.['x-stas-source'] ||
    req?.headers?.['X-Stas-Source'];

  const source = normalizeSource(header);
  // 'site' (правка с сайта STAS) принимаем только от самого STAS по его ключу; чужой заголовок - как раньше (gpt).
  if (source === 'site' && !isStasServerRequest(req)) return 'gpt';
  return source;
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
    ...stasRequestIdForwardHeaders(req),
  };
}

module.exports = {
  buildStasSourceHeaders,
  getClaudeOauthClientId,
  getRequestSource,
  isAllowedChatGptRedirectUri,
  isAllowedClaudeClientId,
  isAllowedClaudeRedirectUri,
  isStasServerRequest,
  normalizeSource,
  resolveOauthSource,
};
