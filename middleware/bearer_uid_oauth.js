const fs = require('fs');
const path = require('path');

function parseTokenToUid(auth) {
  if (!auth) return null;
  const m = auth.match(/^Bearer\s+(.+)$/i);
  if (!m) return null;
  const tok = m[1].trim();

  // Только OAuth из ~/.stas-gw/oauth-tokens.json
  try {
    const p = path.join(process.env.HOME || '', '.stas-gw', 'oauth-tokens.json');
    const arr = JSON.parse(fs.readFileSync(p,'utf8'));
    const rec = [...arr].reverse().find(r => r && r.access_token === tok);
    return rec ? String(rec.uid) : null;
  } catch {
    return null;
  }
}

module.exports = function bearer_uid_oauth() {
  return (req, res, next) => {
    const uid = parseTokenToUid(req.get('authorization') || '');
    if (uid) { req.query.user_id = uid; res.locals.user_id = uid; }
    next();
  };
};
