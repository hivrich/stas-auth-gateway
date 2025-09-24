'use strict';
const decodeMaybe = b64 => { try { return JSON.parse(Buffer.from(b64, 'base64').toString('utf8')); } catch { return {}; } };

module.exports = function(){
  return function(req, res, next){
    const auth = req.get('authorization') || '';
    let uid = null;

    // t_<base64>{"uid":"95192039"}
    const m = auth.match(/^Bearer\s+t_([A-Za-z0-9_\-]+)$/i);
    if (m) {
      const payload = decodeMaybe(m[1].replace(/-/g,'+').replace(/_/g,'/'));
      if (payload && /^\d+$/.test(String(payload.uid||''))) uid = String(payload.uid);
    }

    // Фоллбек только через X-User-Id (для локальной отладки)
    if (!uid) {
      const hdrUid = req.get('x-user-id');
      if (hdrUid && /^\d+$/.test(hdrUid)) uid = String(hdrUid);
    }

    res.locals.user_id = uid || null;
    next();
  };
};
