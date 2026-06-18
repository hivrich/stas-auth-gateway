const AGENT_READ_ROUTES = new Set([
  'GET /gw/api/me',
  'GET /gw/trainings',
  'GET /gw/api/db/user_summary',
  'GET /gw/api/db/activity_detail',
  'GET /gw/icu/events',
]);

const AGENT_CONTROL_ROUTES = new Set([
  'POST /gw/oauth/revoke',
]);

function requestPath(req) {
  const originalUrl = String(req.originalUrl || req.url || '');
  const withoutQuery = originalUrl.split('?')[0] || '';
  if (withoutQuery.startsWith('/gw/')) return withoutQuery.replace(/\/+$/, '') || '/gw';

  const path = String(req.path || '').split('?')[0] || '';
  const normalized = path.startsWith('/gw/') ? path : `/gw${path.startsWith('/') ? '' : '/'}${path}`;
  return normalized.replace(/\/+$/, '') || '/gw';
}

module.exports = function agentReadOnlyGuard() {
  return function guardAgentReadOnly(req, res, next) {
    if (req?.auth?.authMode !== 'agent') return next();

    const key = `${String(req.method || 'GET').toUpperCase()} ${requestPath(req)}`;
    if (AGENT_READ_ROUTES.has(key)) return next();
    if (AGENT_CONTROL_ROUTES.has(key)) return next();

    try {
      console.warn('[agent_auth][deny]', JSON.stringify({
        method: req.method,
        path: requestPath(req),
        registration_id: req.auth.registrationId || null,
      }));
    } catch {}

    return res.status(403).json({
      error: 'forbidden',
      reason: 'agent_auth_read_only',
    });
  };
};

module.exports.AGENT_READ_ROUTES = AGENT_READ_ROUTES;
module.exports.AGENT_CONTROL_ROUTES = AGENT_CONTROL_ROUTES;
