/**
 * UID injector for /gw/api/db/*
 * Requires Bearer if ?user_id is missing. No defaults.
 */
const { getRequestUserId } = require('../lib/request-auth');

module.exports = function(req, res, next){
  try{
    if (req.query && req.query.user_id) return next();
    const uid = getRequestUserId(req);
    if (!uid) return res.status(401).json({status:401,error:'missing_or_invalid_token'});
    if (!req.query) req.query = {};
    req.query.user_id = uid;
    req.headers['x-user-id'] = uid;
    return next();
  }catch(_e){
    return res.status(401).json({status:401,error:'missing_or_invalid_token'});
  }
};
