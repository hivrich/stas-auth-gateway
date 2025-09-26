'use strict';

function requireUser(req, res, next) {
  // Your OAuth/JWT middleware should already decode token into req.user
  // Here we enforce NO DEFAULTS:
  const uid =
    (req.user && (req.user.user_id || req.user.id)) ||
    (req.auth && (req.auth.user_id || req.auth.id));

  if (!uid) {
    return res.status(401).json({
      error: 'unauthorized',
      detail: 'user_id is required in access token (no defaults permitted)'
    });
  }
  req.user_id = String(uid);
  return next();
}

function buildBasicAuthHeader(user, pass) {
  const token = Buffer.from(`${user}:${pass}` ).toString('base64');
  return `Basic ${token}` ;
}

module.exports = { requireUser, buildBasicAuthHeader };
