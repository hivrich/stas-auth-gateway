'use strict';

const encode = obj => Buffer.from(JSON.stringify(obj)).toString('base64url');
const decode = b64 => { try { return JSON.parse(Buffer.from(b64, 'base64url').toString('utf8')); } catch { return null; } };
const isUid  = s => /^\d{3,}$/.test(String(s||'').trim());
const safeDecode = v => { try { return decodeURIComponent(String(v||'')); } catch { return String(v||''); } };

function renderLoginHTML(qstr, errMsg){
  const css = [
    ':root{--bg:#f8f9fa;--panel:#fff;--muted:#6b7280;--fg:#003330;--teal:#00f9de;--tealH:#00e6cb;--bd:#e5e7eb;--ph:#b9bbbb}',
    '*{box-sizing:border-box}','html,body{height:100%}',
    'body{margin:0;font:16px/1.4,-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Ubuntu,Helvetica,Arial}',
    '.minh{min-height:100vh;background:var(--bg);display:flex;align-items:center;justify-content:center;padding:16px}',
    '.card{width:100%;max-width:420px}','.space>*{margin-top:16px}.space>*:first-child{margin-top:0}',
    '.center{text-align:center}','.avatar{width:96px;height:96px;border-radius:9999px;overflow:hidden;margin:0 auto}',
    '.title{color:var(--muted);font-size:14px;letter-spacing:.04em}','form{margin:0}',
    '.input{display:block;width:100%;height:48px;padding:0 16px;border:1px solid var(--bd);border-radius:12px;background:#fff;color:var(--fg);font-size:16px;outline:none}',
    '.input::placeholder{color:var(--ph)}',
    '.btn{display:block;width:100%;height:48px;border:0;border-radius:12px;background:var(--teal);color:var(--fg);font-weight:600;cursor:pointer;transition:background .15s}',
    '.btn:hover{background:var(--tealH)}','.foot{color:var(--ph);font-size:14px}.foot a{color:inherit}',
    '.err{color:#b91c1c;font-size:14px;margin-top:8px}'
  ].join('');
  const avatar='https://hebbkx1anhila5yf.public.blob.vercel-storage.com/Frame%2056-GrnXAETxJu1Yb83h8yanH4qnZOTDp6.png';
  return [
    '<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">',
    '<title>STAS — авторизация</title><style>',css,'</style></head><body>',
    '<div class="minh"><div class="card space">',
    '<div class="center"><div class="avatar"><img src="',avatar,'" alt="STAS Profile" style="width:100%;height:100%;object-fit:cover"></div></div>',
    '<div class="center"><h1 class="title">ВВЕДИТЕ ВАШ STAS ID</h1></div>',
    '<form method="post" action="/gw/oauth/authorize?',qstr,'">',
    '<input class="input" name="uid" type="text" inputmode="numeric" placeholder="например, 95192039" required>',
    errMsg?'<div class="err">ID должен содержать только цифры и быть не короче 3 символов</div>':'',
    '<button class="btn" type="submit">Войти</button>',
    '</form><div class="center foot">Подробнее: <a href="https://stas.run" target="_blank" rel="noopener">stas.run</a></div>',
    '</div></div></body></html>'
  ].join('');
}

module.exports = app => {
  // GET /gw/oauth/authorize
  app.get('/gw/oauth/authorize', (req, res) => {
    const redirect_raw = String(req.query.redirect_uri||'');
    const redirect_uri = safeDecode(redirect_raw);            // << decode
    const state = String(req.query.state||'');
    const uid = (req.query.uid||'').trim();

    if (isUid(uid) && redirect_uri) {
      try {
        const code = 'c_' + encode({ uid, ts: Date.now() });
        const loc = new URL(redirect_uri);                    // uses decoded URL
        loc.searchParams.set('code', code);
        if (state) loc.searchParams.set('state', state);
        return res.redirect(loc.toString());
      } catch {
        // если redirect_uri битый — просто показываем форму
      }
    }

    const qstr = new URLSearchParams({
      response_type: String(req.query.response_type||'code'),
      client_id: String(req.query.client_id||''),
      redirect_uri: redirect_raw,                             // в action оставляем encoded
      scope: String(req.query.scope||''),
      state
    }).toString();

    return res.type('html').send(renderLoginHTML(qstr, !!req.query.err));
  });

  // POST /gw/oauth/authorize
  app.post('/gw/oauth/authorize', (req, res) => {
    const redirect_raw = String(req.query.redirect_uri||'');
    const redirect_uri = safeDecode(redirect_raw);
    const state = String(req.query.state||'');
    const uid = (req.body.uid||'').trim();

    if (!redirect_uri) return res.status(400).json({ status:400, error:'invalid_redirect_uri' });
    if (!isUid(uid))   return res.redirect('/gw/oauth/authorize?' + new URLSearchParams({ ...req.query, err:'1' }).toString());

    try {
      const code = 'c_' + encode({ uid, ts: Date.now() });
      const loc = new URL(redirect_uri);
      loc.searchParams.set('code', code);
      if (state) loc.searchParams.set('state', state);
      return res.redirect(loc.toString());
    } catch {
      return res.status(400).json({ status:400, error:'invalid_redirect_uri' });
    }
  });

  // POST /gw/oauth/token
  app.post('/gw/oauth/token', (req, res) => {
    const gt = String(req.body.grant_type||'');
    const code = String(req.body.code||'');
    if (gt !== 'authorization_code' || !code.startsWith('c_')) {
      return res.status(400).json({ status:400, error:'unsupported_grant_or_code' });
    }
    const obj = decode(code.slice(2));
    if (!obj || !isUid(obj.uid)) return res.status(400).json({ status:400, error:'invalid_code' });
    const access_token = 't_' + encode({ uid: String(obj.uid) });
    return res.json({ access_token, token_type: 'bearer', expires_in: 315360000 });
  });
};
