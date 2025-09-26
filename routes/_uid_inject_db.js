/**
 * UID injector for /gw/api/db/*
 * Requires Bearer if ?user_id is missing. No defaults.
 */
module.exports = function(req, res, next){
  try{
    if (req.query && req.query.user_id) return next();
    const auth = String(req.headers['authorization'] || '');
    const m = auth.match(/^Bearer\s+t_([A-Za-z0-9\-_]+)$/);
    if (!m) return res.status(401).json({status:401,error:'missing_or_invalid_token'});
    const b64 = m[1].replace(/-/g,'+').replace(/_/g,'/');
    const json = JSON.parse(Buffer.from(b64,'base64').toString('utf8'));
    if (!json || !json.uid) return res.status(401).json({status:401,error:'missing_or_invalid_token'});
    const uid = String(json.uid);
    if (!req.query) req.query = {};
    req.query.user_id = uid;
    req.headers['x-user-id'] = uid;
    return next();
  }catch(_e){
    return res.status(401).json({status:401,error:'missing_or_invalid_token'});
  }
};
