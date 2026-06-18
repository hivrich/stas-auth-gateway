/**
 * Global Bearer→UID middleware for /gw/*
 * Supports:
 * - Legacy gateway Bearer t_<base64url>{"uid":"..."}
 * - Direct Intervals OAuth Bearer tokens
 * Sets: req.query.user_id, req.user_id, req.intervals_token, x-user-id
 */
const { applyResolvedAuth, getBearerToken, resolveRequestAuth } = require('../lib/request-auth');

module.exports = function () {
  return async function (req, res, next) {
    // bypass for auth/health/openapi/version (учитываем и полный, и «срезанный» путь)
    const ou = String(req.originalUrl || '');
    const p  = String(req.path || req.url || '');
    if (ou.startsWith('/gw/oauth') || p.startsWith('/oauth') || p === '/healthz' || p === '/openapi.json' || p === '/version') {
      return next();
    }

    const bad = () => res.status(401).json({ status: 401, error: 'missing_or_invalid_token' });
    const authRequired = () => res.status(401).json({
      status: 401,
      error: 'auth_required',
      message: 'Требуется переподключение. Попросите пользователя заново войти через Intervals.icu',
    });

    try {
      const token = getBearerToken(req);
      if (!token) return bad();

      const auth = await resolveRequestAuth(req);
      if (!auth) {
        return token.startsWith('t_') ? bad() : authRequired();
      }

      applyResolvedAuth(req, res, auth);
      return next();
    } catch (error) {
      if (error?.status === 401) return authRequired();
      return res.status(error?.status || 502).json({
        status: error?.status || 502,
        error: 'user_sync_failed',
      });
    }
  };
};
