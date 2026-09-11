const { applyResolvedAuth, resolveRequestAuth } = require('../lib/request-auth');
const { getStasRequestId } = require('../lib/request-id');

// Stable codes go to logs as-is; raw text only when no code exists and
// bounded, so failure details can never flood or leak request values.
function trimReason(value) {
  const raw = String(value || '').trim();
  return raw ? raw.slice(0, 120) : 'auth_resolution_failed';
}

/**
 * UID injector for /gw/api/db/*.
 * The global /gw middleware normally sets user_id already; this re-applies
 * resolved auth and deliberately ignores any query-provided identity.
 */
module.exports = async function(req, res, next){
  try{
    const auth = await resolveRequestAuth(req);
    if (!auth || !auth.userId) {
      return res.status(401).json({status:401,error:'missing_or_invalid_token'});
    }

    applyResolvedAuth(req, res, auth);
    return next();
  }catch(error){
    try {
      console.error('[uid_inject_db][auth_failed]', JSON.stringify({
        stas_request_id: getStasRequestId(req),
        method: req.method,
        path: String(req.path || '').split('?')[0] || null,
        status: Number(error?.status) || 502,
        reason: trimReason(error?.code || error?.message),
      }));
    } catch {}
    const status = Number(error?.status) || 401;
    if (status >= 500) return res.status(status).json({status,error:'auth_resolution_failed'});
    return res.status(401).json({status:401,error:'missing_or_invalid_token'});
  }
};
