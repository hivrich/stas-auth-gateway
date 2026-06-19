const { applyResolvedAuth, resolveRequestAuth } = require('../lib/request-auth');

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
    console.error('[uid_inject_db][auth_failed]', error?.status || 502, error?.message || error);
    const status = Number(error?.status) || 401;
    if (status >= 500) return res.status(status).json({status,error:'auth_resolution_failed'});
    return res.status(401).json({status:401,error:'missing_or_invalid_token'});
  }
};
