const MCP_SCOPE_CATEGORIES = ['ACTIVITY', 'WELLNESS', 'CALENDAR', 'CHATS', 'LIBRARY', 'SETTINGS'];
const MCP_SCOPES_SUPPORTED = MCP_SCOPE_CATEGORIES.flatMap((category) => [`${category}:READ`, `${category}:WRITE`]);
const MCP_DEFAULT_SCOPES = MCP_SCOPE_CATEGORIES.map((category) => `${category}:WRITE`);
const MCP_SCOPE_SET = new Set(MCP_SCOPES_SUPPORTED);

function trimToString(value) {
  if (value === null || value === undefined) return '';
  return String(value).trim();
}

function normalizeMcpScopes(value, options = {}) {
  const raw = Array.isArray(value) ? value : trimToString(value).split(/[\s,]+/);
  const scopes = [...new Set(raw.map(trimToString).filter(Boolean))];
  if (scopes.length === 0 && options.useDefault !== false) return [...MCP_DEFAULT_SCOPES];
  if (scopes.length === 0 || scopes.some((scope) => !MCP_SCOPE_SET.has(scope))) return null;
  return scopes;
}

function scopeAllows(scopes, category, write) {
  const normalized = normalizeMcpScopes(scopes, { useDefault: false });
  if (!normalized || !MCP_SCOPE_CATEGORIES.includes(category)) return false;
  if (normalized.includes(`${category}:WRITE`)) return true;
  return !write && normalized.includes(`${category}:READ`);
}

module.exports = {
  MCP_DEFAULT_SCOPES,
  MCP_SCOPES_SUPPORTED,
  normalizeMcpScopes,
  scopeAllows,
};
