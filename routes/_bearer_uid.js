const { applyResolvedAuth, resolveRequestAuth } = require('../lib/request-auth');

/**
 * Global Bearer auth middleware for /gw/*.
 * Supports both legacy local t_ tokens and direct Intervals OAuth access tokens.
 */
module.exports = function () {
  return async function (req, res, next) {
    // bypass for auth/health/openapi/version (учитываем и полный, и «срезанный» путь)
    const ou = String(req.originalUrl || '');
    const p  = String(req.path || req.url || '');
    if (
      ou.startsWith('/gw/oauth') ||
      p.startsWith('/oauth') ||
      p === '/healthz' ||
      p === '/openapi.json' ||
      p === '/openapi.yaml' ||
      p === '/openapi.min.json' ||
      p === '/openapi.min.yaml' ||
      p === '/openapi.actions.json' ||
      p === '/version'
    ) {
      return next();
    }

    const bad = () => res.status(401).json({ status: 401, error: 'missing_or_invalid_token' });

    try {
      const auth = await resolveRequestAuth(req);
      if (!auth || !auth.userId) return bad();
      applyResolvedAuth(req, res, auth);
      return next();
    } catch (error) {
      console.error('[bearer_uid][auth_failed]', error?.status || 502, error?.message || error);
      const status = Number(error?.status) || 401;
      if (status >= 500) return res.status(status).json({ status, error: 'auth_resolution_failed' });
      return bad();
    }
  };
};
