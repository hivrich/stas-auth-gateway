'use strict';

function decodeJWT(token) {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const payload = JSON.parse(Buffer.from(parts[1], 'base64').toString());
    return {
      user_id: payload.sub,
      athlete_id: payload.athlete_id || null,
      api_key: payload.api_key || null
    };
  } catch (e) {
    return null;
  }
}

function requireUser(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'No token provided' });
  }
  const token = authHeader.substring(7);
  const payload = decodeJWT(token);
  if (!payload || !payload.user_id) {
    return res.status(401).json({ error: 'Invalid token or missing user_id' });
  }
  req.user_id = payload.user_id;
  next();
}

function buildBasicAuthHeader(user, pass) {
  return 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64');
}

module.exports = { requireUser, buildBasicAuthHeader };
