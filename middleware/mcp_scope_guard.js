const { getResolvedAuth } = require('../lib/request-auth');
const { scopeAllows } = require('../lib/mcp-oauth-scopes');

function classifyMcpScopeCategory(pathname) {
  const path = String(pathname || '').toLowerCase();
  if (!path || path === '/gw/api/me' || path === '/api/me') return null;
  if (/calendar|\/events?(?:\/|$)|plan/.test(path)) return 'CALENDAR';
  if (/wellness|health/.test(path)) return 'WELLNESS';
  if (/activity|training|workout/.test(path)) return 'ACTIVITY';
  if (/chat/.test(path)) return 'CHATS';
  if (/library/.test(path)) return 'LIBRARY';
  return 'SETTINGS';
}

function isWriteMethod(method) {
  return !['GET', 'HEAD', 'OPTIONS'].includes(String(method || 'GET').toUpperCase());
}

module.exports = function mcpScopeGuard() {
  return function guard(req, res, next) {
    const auth = getResolvedAuth(req);
    if (auth?.authMode !== 'mcp') return next();

    const pathname = String(req.originalUrl || req.path || '').split('?')[0];
    const category = classifyMcpScopeCategory(pathname);
    if (!category) return next();

    const write = isWriteMethod(req.method);
    if (scopeAllows(auth.scopes, category, write)) return next();

    const requiredScope = `${category}:${write ? 'WRITE' : 'READ'}`;
    res.setHeader('WWW-Authenticate', `Bearer error="insufficient_scope", scope="${requiredScope}"`);
    return res.status(403).json({ error: 'insufficient_scope', scope: requiredScope });
  };
};

module.exports.__testing = {
  classifyMcpScopeCategory,
  isWriteMethod,
};
