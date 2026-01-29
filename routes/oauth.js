const express = require('express');
const router  = express.Router();

// GET /oauth/authorize
// Если uid отсутствует — страницу логина отдаёт middleware/oauth_page.js (mounted before).
router.get('/oauth/authorize', (req, res, next) => {
  try {
    const q = req.query || {};
    const redirect_uri = String(q.redirect_uri || '');
    const state = q.state ? String(q.state) : '';
    const uid = q.uid || q.user_id || '';
    if (!/^[0-9]+$/.test(String(uid))) return next(); // пусть страница логина сработает

    const payload = JSON.stringify({ uid: String(uid), ts: Date.now() });
    const code = 'c_' + Buffer.from(payload,'utf8').toString('base64')
                       .replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
    const sep = redirect_uri.includes('?') ? '&' : '?';
    const url = `${redirect_uri}${sep}code=${encodeURIComponent(code)}${state ? `&state=${encodeURIComponent(state)}` : ''}`;
    try { console.log('[oauth][302]', url); } catch {}
    return res.redirect(302, url);
  } catch (e) {
    return res.status(500).json({ error: 'server_error' });
  }
});

// POST /oauth/token  → Bearer t_<base64>{"uid": "...", "ts": <unix>}
router.post('/oauth/token', (req, res) => {
  try {
    const b = Object.assign({}, req.body || {});
    const code = String(b.code || b.authorization_code || '');
    if (!code.startsWith('c_')) return res.status(400).json({ error: 'invalid_grant' });

    let uid = null;
    try {
      const json = Buffer.from(code.slice(2).replace(/-/g,'+').replace(/_/g,'/'), 'base64').toString('utf8');
      const obj = JSON.parse(json);
      uid = obj && obj.uid ? String(obj.uid) : null;
    } catch {}
    if (!uid || !/^[0-9]+$/.test(uid)) return res.status(400).json({ error: 'invalid_uid' });

    const now = Math.floor(Date.now()/1000);
    const acc = JSON.stringify({ uid, ts: now });
    const tok = 't_' + Buffer.from(acc,'utf8').toString('base64')
                            .replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
    return res.json({ access_token: tok, token_type:'Bearer', expires_in: 2592000, scope: String(b.scope || '') });
  } catch (e) {
    return res.status(500).json({ error: 'server_error' });
  }
});

module.exports = router;
