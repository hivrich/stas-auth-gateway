const express = require('express');

// base64url для Bearer t_<payload>
function b64url(s){
  return Buffer.from(s).toString('base64')
    .replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
}
const esc = (v)=>String(v??'').replace(/[&<>"']/g, m=>({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;', "'":'&#39;' }[m]));

// Рендер формы. ВАЖНО: скрытые поля сносят в POST все OAuth-параметры из query.
function renderForm(q={}, showErr=false){
  const err = showErr
    ? '<div class="err">ID должен содержать только цифры и быть не короче 3 символов</div>'
    : '<div class="err" style="display:none"></div>';
  return `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>STAS — Вход</title>
<style>
*{box-sizing:border-box}
body{margin:0;font-family:system-ui,-apple-system,Segoe UI,Roboto,Ubuntu,Arial,sans-serif;background:#f8f9fa;color:#003330}
.wrap{min-height:100dvh;display:flex;align-items:center;justify-content:center;padding:16px}
.card{width:100%;max-width:420px}
.avatar{width:96px;height:96px;border-radius:9999px;overflow:hidden;margin:0 auto 16px}
h1{margin:0 0 8px 0;color:#6b7280;font-size:18px;font-weight:600;text-align:center;letter-spacing:.02em}
.input{width:100%;height:52px;border:2px solid #2563eb33;border-radius:12px;background:#eef3ff;padding:0 16px;color:#003330;font-size:18px;outline:none}
.input:focus{border-color:#2563eb;background:#fff}
.btn{width:100%;height:56px;border:0;border-radius:12px;background:#00f9de;color:#003330;font-weight:700;cursor:pointer;font-size:20px}
.btn:hover{background:#00e6cb}
.mt-3{margin-top:12px}.mt-4{margin-top:16px}.center{text-align:center}
.muted{color:#b9bbbb;font-size:13px}
a{color:inherit}
.err{color:#dc2626;font-size:13px;margin-top:8px}
</style>
</head>
<body>
  <div class="wrap">
    <div class="card">
      <div class="avatar">
        <img alt="STAS Profile"
             src="https://hebbkx1anhila5yf.public.blob.vercel-storage.com/Frame%2056-GrnXAETxJu1Yb83h8yanH4qnZOTDp6.png"
             style="width:100%;height:100%;object-fit:cover"/>
      </div>
      <h1>ВВЕДИТЕ ВАШ STAS ID</h1>
      <form method="post" novalidate>
        <!-- скрытые OAuth-поля -->
        <input type="hidden" name="response_type" value="${esc(q.response_type)}"/>
        <input type="hidden" name="client_id"     value="${esc(q.client_id)}"/>
        <input type="hidden" name="redirect_uri"  value="${esc(q.redirect_uri)}"/>
        <input type="hidden" name="scope"         value="${esc(q.scope)}"/>
        <input type="hidden" name="state"         value="${esc(q.state)}"/>
        <!-- ввод ID -->
        <input name="user_id" type="text" inputmode="numeric" pattern="[0-9]*" class="input" placeholder="" aria-label="STAS ID"/>
        ${err}
        <div class="mt-3"><button class="btn" type="submit">Войти</button></div>
      </form>
      <div class="center mt-4">
        <p class="muted">Подробнее: <a class="muted" href="https://stas.run" target="_blank" rel="noreferrer">stas.run</a></p>
      </div>
    </div>
  </div>
</body>
</html>`;
}

module.exports = function oauthPage(){
  const r = express.Router();

  // Прокидываем Bearer из cookie → Authorization
  r.use((req,res,next)=>{
    const bearer = req.cookies && req.cookies.STAS_BEARER;
    if (bearer && !req.headers.authorization) req.headers.authorization = `Bearer ${bearer}`;
    next();
  });

  // GET: форма только если нет code/error и нет Bearer
  r.get('/authorize', (req,res,next)=>{
    const hasAuth = (req.headers.authorization||'').startsWith('Bearer ');
    if (hasAuth || 'code' in req.query || 'error' in req.query) return next();
    res.set('Cache-Control','no-store, no-cache, must-revalidate');
    res.set('Pragma','no-cache'); res.set('Expires','0');
    res.type('html').status(200).send(renderForm(req.query, false));
  });

  // POST: валидируем ID, сохраняем Bearer в cookie, прокидываем дальше (next)
  r.post('/authorize', express.urlencoded({extended:false}), (req,res,next)=>{
    const raw = String((req.body && (req.body.user_id || req.body.uid)) || '').trim();
    const digits = raw.replace(/\D+/g,'');
    if (!digits || digits.length < 3) {
      res.set('Cache-Control','no-store, no-cache, must-revalidate');
      res.set('Pragma','no-cache'); res.set('Expires','0');
      return res.type('html').status(400).send(renderForm(req.query, true));
    }
    const token = 't_' + b64url(JSON.stringify({ uid: digits }));
    // Куки на /gw
    res.cookie('STAS_BEARER', token, { httpOnly:true, sameSite:'lax', path:'/gw', maxAge:7*24*60*60*1000 });
    res.cookie('STAS_UID',    digits,{ httpOnly:true, sameSite:'lax', path:'/gw', maxAge:7*24*60*60*1000 });

    // Для совместимости
    if (!req.headers.authorization) req.headers.authorization = 'Bearer ' + token;
    if (req.body) { req.body.user_id = digits; req.body.uid = digits; }

    // НЕ редиректим сами — отдаём в исходный обработчик, который вернёт в GPT
    return next();
  });

  return r;
};
