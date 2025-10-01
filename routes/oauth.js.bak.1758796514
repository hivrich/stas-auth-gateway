const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const router = express.Router();

const DATA_DIR     = '/var/lib/stas-auth-gateway';
const CODES_FILE   = path.join(DATA_DIR, 'oauth-codes.json');
const TOKENS_FILE  = path.join(DATA_DIR, 'oauth-tokens.json');

function nowMs(){ return Date.now(); }
function nowSec(){ return Math.floor(nowMs()/1000); }
function rndHex(n=16){ return crypto.randomBytes(n).toString('hex'); }
function loadJson(file){ try{ return JSON.parse(fs.readFileSync(file,'utf8')); } catch{ return []; } }
function saveJson(file, arr){ fs.writeFileSync(file, JSON.stringify(arr, null, 2)); }
function prune(){
  const codes = loadJson(CODES_FILE).filter(c => c.exp_ms > nowMs()); saveJson(CODES_FILE, codes);
  const toks  = loadJson(TOKENS_FILE).filter(t => t.exp > nowSec());  saveJson(TOKENS_FILE, toks);
}
function urlSafe(b){ return Buffer.from(b).toString('base64').replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,''); }
function b64urlToUtf8(s){ return Buffer.from(s.replace(/-/g,'+').replace(/_/g,'/'),'base64').toString('utf8'); }
function htmlEscape(s){ return String(s||'').replace(/[&<>"']/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m])); }

const REDIRECT_ALLOW = ['chat.openai.com','chatgpt.com','localhost','127.0.0.1'];
function isRedirectAllowed(urlStr){ try{ const u = new URL(urlStr); return REDIRECT_ALLOW.includes(u.hostname); } catch{ return false; } }

// HTML форма user_id → POST /authorize
router.get('/authorize', (req, res) => {
  const { response_type='code', client_id='', redirect_uri='', state='', scope='' } = req.query;
  if (response_type !== 'code') return res.status(400).json({status:400,error:'unsupported_response_type'});
  const page = `
<!doctype html><html><head><meta charset="utf-8"><title>Authorize</title>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<style>body{font-family:system-ui,Segoe UI,Roboto,Arial;margin:2rem} .card{max-width:560px;border:1px solid #ddd;border-radius:12px;padding:20px} input,button{padding:10px;font-size:16px;width:100%} .row{margin:10px 0}</style>
</head><body>
<div class="card">
  <h2>STAS Auth — Connect</h2>
  <p>App: <b>${htmlEscape(client_id||'chatgpt-actions')}</b></p>
  <p>Scopes: <code>${htmlEscape(scope||'read:me icu')}</code></p>
  <form method="POST" action="/gw/oauth/authorize">
    <input type="hidden" name="response_type" value="${htmlEscape(response_type)}"/>
    <input type="hidden" name="client_id"     value="${htmlEscape(client_id)}"/>
    <input type="hidden" name="redirect_uri"  value="${htmlEscape(redirect_uri)}"/>
    <input type="hidden" name="state"         value="${htmlEscape(state)}"/>
    <input type="hidden" name="scope"         value="${htmlEscape(scope)}"/>
    <div class="row"><label>User ID<br><input type="text" name="user_id" placeholder="" required></label></div>
    <div class="row"><button type="submit">Authorize</button></div>
  </form>
</div>
</body></html>`;
  res.status(200).type('html').send(page);
});

// Принять user_id → СРАЗУ 302 на redirect_uri с ?code (&state)
router.post('/authorize', express.urlencoded({extended:true}), (req, res) => {
  prune();
  const { response_type='code', client_id='', redirect_uri='', state='', scope='', user_id='' } = req.body || {};
  if (response_type !== 'code') return res.status(400).json({status:400,error:'unsupported_response_type'});
  const uid = String(user_id||'').trim();
  if (!uid) return res.status(400).json({status:400,error:'missing_user_id'});
  if (!redirect_uri || !isRedirectAllowed(redirect_uri)) return res.status(400).json({status:400,error:'invalid_redirect_uri'});
  const code = `c_${Date.now()}_${rndHex(8)}_${uid}`;
  const exp  = nowMs() + 5*60*1000;
  const codes = loadJson(CODES_FILE); codes.push({ code, uid, client_id, scope, redirect_uri, exp_ms: exp }); saveJson(CODES_FILE, codes);
  const u = new URL(redirect_uri); u.searchParams.set('code', code); if (state) u.searchParams.set('state', state);
  res.redirect(302, u.toString());
});

// Обмен кода на токен; Bearer несёт uid
router.post('/token', express.urlencoded({extended:true}), (req, res) => {
  prune();
  const { grant_type, code, redirect_uri } = req.body || {};
  if (grant_type !== 'authorization_code') return res.status(400).json({ error: 'unsupported_grant_type', error_description: 'use authorization_code' });
  if (!code) return res.status(400).json({ error:'invalid_request', error_description:'missing code' });
  const codes = loadJson(CODES_FILE);
  const idx = codes.findIndex(c => c.code === code);
  if (idx < 0) return res.status(400).json({ error:'invalid_grant', error_description:'code not found' });
  const rec = codes[idx];
  if (rec.exp_ms <= nowMs()) { codes.splice(idx,1); saveJson(CODES_FILE, codes); return res.status(400).json({ error:'invalid_grant', error_description:'code expired' }); }
  if (redirect_uri && rec.redirect_uri && redirect_uri !== rec.redirect_uri) return res.status(400).json({ error:'invalid_grant', error_description:'redirect_uri mismatch' });
  const payload = { uid: rec.uid, scope: rec.scope||'', iat: Math.floor(Date.now()/1000), exp: Math.floor(Date.now()/1000)+3600 };
  const token = 't_' + Buffer.from(JSON.stringify(payload)).toString('base64').replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
  const toks = loadJson(TOKENS_FILE); toks.push({ token, uid: payload.uid, scope: payload.scope, iat: payload.iat, exp: payload.exp }); saveJson(TOKENS_FILE, toks);
  codes.splice(idx,1); saveJson(CODES_FILE, codes);
  res.status(200).json({ access_token: token, token_type: 'Bearer', expires_in: 3600, scope: payload.scope });
});

// Отладка
router.get('/me', (req,res)=>{
  const auth = String(req.headers['authorization']||'');
  const m = auth.match(/^Bearer\s+t_([A-Za-z0-9\-_]+)$/);
  if (!m) return res.status(401).json({status:401,error:'missing_or_invalid_token'});
  try {
    const json = JSON.parse(Buffer.from(m[1].replace(/-/g,'+').replace(/_/g,'/'),'base64').toString('utf8'));
    if (json.exp <= Math.floor(Date.now()/1000)) return res.status(401).json({status:401,error:'token_expired'});
    return res.status(200).json({ ok:true, user_id: json.uid, scope: json.scope, exp: json.exp });
  } catch(e){
    return res.status(401).json({status:401,error:'invalid_token'});
  }
});

module.exports = router;
