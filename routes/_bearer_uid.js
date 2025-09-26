/**
 * Global Bearer→UID middleware for /gw/*
 * Requires: Authorization: Bearer t_<base64url>{"uid":"<digits>"}
 * Sets: req.query.user_id, req.user_id, x-user-id
 */
module.exports = function () {
  return function (req, res, next) {
    // bypass for auth/health/openapi/version (учитываем и полный, и «срезанный» путь)
    const ou = String(req.originalUrl || '');
    const p  = String(req.path || req.url || '');
    if (ou.startsWith('/gw/oauth') || p.startsWith('/oauth') || p === '/healthz' || p === '/openapi.json' || p === '/version') {
      return next();
    }

    const bad = () => res.status(401).json({ status: 401, error: 'missing_or_invalid_token' });
    try {
      const auth = String(req.headers['authorization'] || '');
      if (!auth.startsWith('Bearer ')) return bad();
      const tok = auth.slice(7).trim();
      if (!tok.startsWith('t_')) return bad();

      const b64 = tok.slice(2).replace(/-/g, '+').replace(/_/g, '/');
      let uid = null;
      try {
        const parsed = JSON.parse(Buffer.from(b64, 'base64').toString('utf8'));
        uid = parsed && parsed.uid ? String(parsed.uid) : null;
      } catch {}
      if (!uid || !/^[0-9]+$/.test(uid)) return bad();

      // wipe client-provided user_id and set ours
      const q = Object.assign({}, req.query);
      delete q.user_id;
      q.user_id = uid;
      req.query   = q;
      req.user_id = uid;
      req.headers['x-user-id'] = uid;

      return next();
    } catch {
      return bad();
    }
  };
};
