'use strict';

// Минимальный OAuth-стаб: страница авторизации с input user_id,
// выдаёт code=c_<b64>{"uid": "..."} и токен t_<b64>{"uid":"..."}

const encode = obj => Buffer.from(JSON.stringify(obj)).toString('base64url');
const decode = b64 => { try { return JSON.parse(Buffer.from(b64, 'base64url').toString('utf8')); } catch { return null; } };
const isUid = s => /^\d{3,}$/.test(String(s||'').trim());

module.exports = app => {
  // GET /gw/oauth/authorize — форма + принятие GET с готовым uid (?uid=)
  app.get('/gw/oauth/authorize', (req, res) => {
    const { redirect_uri='', state='' } = req.query;
    const uid = (req.query.uid||'').trim();

    // Если прислали валидный uid прямо в GET — сразу редиректим с code
    if (isUid(uid) && redirect_uri) {
      const code = 'c_' + encode({ uid, ts: Date.now() });
      const loc = new URL(redirect_uri);
      loc.searchParams.set('code', code);
      if (state) loc.searchParams.set('state', state);
      return res.redirect(loc.toString());
    }

    // Иначе — рендерим простую форму
    const err = req.query.err ? 'ID должен содержать только цифры и быть не короче 3 символов' : '';
    const qstr = new URLSearchParams({
      response_type: String(req.query.response_type||'code'),
      client_id: String(req.query.client_id||''),
      redirect_uri: String(redirect_uri||''),
      scope: String(req.query.scope||''),
      state: String(state||''),
    }).toString();

    return res.type('html').send(`<!doctype html>
<html lang="ru"><head><meta charset="utf-8"><title>Вход</title>
<style>
body{font:16px/1.4 -apple-system,BlinkMacSystemFont,Segoe UI,Roboto,Ubuntu,Helvetica,Arial,sans-serif;margin:40px;}
form{max-width:420px}
label{display:block;margin:.2rem 0 .4rem}
input[type=text]{width:100%;padding:.6rem;border:1px solid #ccc;border-radius:8px}
.err{color:#c00;margin:.5rem 0 .75rem}
.btn{margin-top:.8rem;padding:.6rem 1rem;border:0;border-radius:8px;background:#111;color:#fff;cursor:pointer}
.small{color:#666;font-size:.9rem;margin-top:.5rem}
</style></head><body>
<h1>Авторизация</h1>
${err?`<div class="err">${err}</div>`:''}
<form method="post" action="/gw/oauth/authorize?${qstr}">
  <label for="uid">Ваш user_id</label>
  <input id="uid" name="uid" type="text" placeholder="например, 95192039" required>
  <button class="btn" type="submit">Продолжить</button>
  <div class="small">Мы используем только ваш числовой user_id.</div>
</form>
</body></html>`);
  });

  // POST /gw/oauth/authorize — принимает uid из формы и редиректит на redirect_uri с code
  app.post('/gw/oauth/authorize', (req, res) => {
    const { redirect_uri='', state='' } = req.query;
    const uid = (req.body.uid||'').trim();
    if (!redirect_uri) return res.status(400).json({ status:400, error:'invalid_redirect_uri' });
    if (!isUid(uid))   return res.redirect(`/gw/oauth/authorize?${new URLSearchParams({...req.query, err: '1'}).toString()}`);

    const code = 'c_' + encode({ uid, ts: Date.now() });
    const loc = new URL(redirect_uri);
    loc.searchParams.set('code', code);
    if (state) loc.searchParams.set('state', state);
    return res.redirect(loc.toString());
  });

  // POST /gw/oauth/token — обмен code -> access_token
  // expects: grant_type=authorization_code&code=c_<...>
  app.post('/gw/oauth/token', (req, res) => {
    const gt = String(req.body.grant_type||'');
    const code = String(req.body.code||'');
    if (gt !== 'authorization_code' || !code.startsWith('c_')) {
      return res.status(400).json({ status:400, error:'unsupported_grant_or_code' });
    }
    const obj = decode(code.slice(2));
    if (!obj || !isUid(obj.uid)) {
      return res.status(400).json({ status:400, error:'invalid_code' });
    }
    const access_token = 't_' + encode({ uid: String(obj.uid) });
    return res.json({
      access_token,
      token_type: 'bearer',
      expires_in: 315360000 // 10 лет, как стаб
    });
  });
};
