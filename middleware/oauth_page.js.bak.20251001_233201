module.exports = function oauthPage() {
  return function (req, res, next) {
    const ou = String(req.originalUrl || '');
    const accept = String(req.headers['accept'] || '');
    const isAuthorize = ou.startsWith('/gw/oauth/authorize') || ou === '/oauth/authorize';
    const hasUid = /[?&](uid|user_id)=\d+/.test(ou);

    if (!isAuthorize || hasUid) return next();         // отдаём в реальный oauth-роутер

    // соберём исходные параметры, чтобы вернуть их при сабмите
    const q = new URL('http://x' + ou).searchParams;
    const qp = ['response_type','client_id','redirect_uri','state','scope']
      .map(k => q.get(k) ? `${k}=${encodeURIComponent(q.get(k))}` : '')
      .filter(Boolean)
      .join('&');

    const html = `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>STAS Login</title>
<script src="https://cdn.tailwindcss.com"></script>
</head>
<body class="min-h-screen bg-[#f8f9fa] flex items-center justify-center p-4 font-sans">
  <div class="w-full max-w-sm space-y-4">
    <div class="flex justify-center">
      <div class="w-24 h-24 rounded-full overflow-hidden">
        <img src="https://hebbkx1anhila5yf.public.blob.vercel-storage.com/Frame%2056-GrnXAETxJu1Yb83h8yanH4qnZOTDp6.png" alt="STAS Profile" class="w-full h-full object-cover"/>
      </div>
    </div>
    <div class="text-center">
      <h1 class="text-[#6b7280] text-base font-medium">ВВЕДИТЕ ВАШ STAS ID</h1>
    </div>
    <div>
      <input id="uid" type="text" inputmode="numeric" pattern="\\d*" class="w-full h-12 bg-white border border-[#e5e7eb] rounded-lg px-4 text-[#003330] placeholder-[#b9bbbb]" placeholder="например, 95192039"/>
    </div>
    <div class="-mt-2">
      <button id="go" class="w-full h-12 bg-[#00f9de] hover:bg-[#00e6cb] text-[#003330] font-medium rounded-lg border-0">Войти</button>
    </div>
    <div class="text-center pt-2">
      <p class="text-[#b9bbbb] text-sm">Подробнее: <a href="https://stas.run" class="underline">stas.run</a></p>
    </div>
  </div>
<script>
  const btn = document.getElementById('go');
  btn.onclick = function () {
    const v = (document.getElementById('uid').value||'').trim();
    if(!/^[0-9]+$/.test(v)) { alert('Введите числовой STAS ID'); return; }
    const base = '/gw/oauth/authorize';
    const qp = '${qp}';
    const glue = qp ? (base + '?' + qp + '&uid=' + encodeURIComponent(v)) : (base + '?uid=' + encodeURIComponent(v));
    location.href = glue;
  };
</script>
</body>
</html>`;
    res.setHeader('content-type','text/html; charset=utf-8');
    return res.status(200).send(html);
  };
};
