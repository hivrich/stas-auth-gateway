function envFlagEnabled(...names) {
  return names.some((name) => /^(1|true|yes|on)$/i.test(String(process.env[name] || '').trim()));
}

function isLegacyStasIdOauthEnabled() {
  return envFlagEnabled('ENABLE_LEGACY_STAS_ID_OAUTH', 'LEGACY_STAS_ID_OAUTH_ENABLED');
}

module.exports = function oauthPage() {
  return function (req, res, next) {
    const ou = String(req.originalUrl || '');
    const isAuthorize = ou.startsWith('/gw/oauth/authorize') || ou === '/oauth/authorize';
    if (!isAuthorize || !isLegacyStasIdOauthEnabled()) return next();

    const hasUid = /[?&](uid|user_id)=\d+/.test(ou);
    const q = new URL('http://x' + ou).searchParams;
    const hasIntervalsScope = /\b(?:ACTIVITY|WELLNESS|CALENDAR|CHATS|LIBRARY|SETTINGS):(?:READ|WRITE)\b/.test(String(q.get('scope') || ''));

    if (hasUid || hasIntervalsScope) return next();         // отдаём в реальный oauth-роутер

    // соберём исходные параметры, чтобы вернуть их при сабмите
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
<style>
  * { box-sizing: border-box; }
  body {
    min-height: 100vh;
    margin: 0;
    background: #f8f9fa;
    color: #003330;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 16px;
    font-family: Arial, sans-serif;
  }
  .wrap { width: 100%; max-width: 360px; }
  .mark {
    width: 88px;
    height: 88px;
    border-radius: 999px;
    background: #00f9de;
    color: #003330;
    display: flex;
    align-items: center;
    justify-content: center;
    margin: 0 auto 20px;
    font-weight: 700;
    letter-spacing: 0;
  }
  h1 {
    margin: 0 0 16px;
    color: #6b7280;
    font-size: 16px;
    font-weight: 600;
    text-align: center;
    letter-spacing: 0;
  }
  input, button {
    width: 100%;
    height: 48px;
    border-radius: 8px;
    font: inherit;
  }
  input {
    border: 1px solid #e5e7eb;
    padding: 0 14px;
    background: #fff;
    color: #003330;
  }
  button {
    margin-top: 10px;
    border: 0;
    background: #00f9de;
    color: #003330;
    font-weight: 600;
    cursor: pointer;
  }
  p { margin: 14px 0 0; color: #6b7280; font-size: 14px; text-align: center; }
  a { color: inherit; }
</style>
</head>
<body>
  <div class="wrap">
    <div class="mark">STAS</div>
    <h1>ВВЕДИТЕ ВАШ STAS ID</h1>
    <input id="uid" type="text" inputmode="numeric" pattern="\\d*" placeholder="например, 95192039"/>
    <button id="go">Войти</button>
    <p>Подробнее: <a href="https://stas.run">stas.run</a></p>
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
    res.setHeader('content-security-policy', "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'none'; img-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'");
    res.setHeader('content-type','text/html; charset=utf-8');
    return res.status(200).send(html);
  };
};
