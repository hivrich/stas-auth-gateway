const { applyResolvedAuth, resolveRequestAuth } = require('../lib/request-auth');
const { getStasRequestId } = require('../lib/request-id');

function trimReason(value) {
  const raw = String(value || '').trim();
  return raw ? raw.slice(0, 120) : 'auth_resolution_failed';
}

/**
 * Global Bearer auth middleware for /gw/*.
 * Supports STAS MCP/Agent tokens and direct Intervals OAuth tokens.
 * Unsigned legacy local t_ tokens are rejected.
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
      p === '/openapi.actions.json' ||
      p === '/version'
    ) {
      return next();
    }

    const bad = () => {
      try {
        console.warn('[auth][bearer_rejected]', JSON.stringify({
          stas_request_id: getStasRequestId(req),
          method: req.method,
          path: String(req.originalUrl || req.url || '').split('?')[0] || null,
        }));
      } catch {}
      return res.status(401).json({ status: 401, error: 'missing_or_invalid_token' });
    };

    try {
      const auth = await resolveRequestAuth(req);
      if (!auth || !auth.userId) return bad();
      applyResolvedAuth(req, res, auth);
      return next();
    } catch (error) {
      // Stable codes go to logs as-is; raw text only when no code exists and
      // bounded, so failure details can never flood or leak request values.
      const rawReason = trimReason(error?.code || error?.message);
      try {
        console.error('[bearer_uid][auth_failed]', JSON.stringify({
          stas_request_id: getStasRequestId(req),
          status: Number(error?.status) || 502,
          reason: rawReason,
        }));
      } catch {}
      const status = Number(error?.status) || 401;
      if (status >= 500) return res.status(status).json({ status, error: 'auth_resolution_failed' });
      return bad();
    }
  };
};
