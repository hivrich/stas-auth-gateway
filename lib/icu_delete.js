const http = require('http');
const https = require('https');
const { normalizeSource } = require('./request-source');

function b64(s){ return Buffer.from(s,'utf8').toString('base64'); }

function httpJSON(url, { headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https:') ? https : http;
    const req = lib.get(url, { headers }, res => {
      let data=''; res.on('data', c => data+=c);
      res.on('end', () => {
        try {
          const j = data ? JSON.parse(data) : [];
          if (res.statusCode>=200 && res.statusCode<300) return resolve(j);
          const e = new Error((j && (j.error||j.message)) || `http_${res.statusCode}`);
          e.status=res.statusCode; e.body=j; return reject(e);
        } catch {
          const e=new Error('bad_json'); e.status=res.statusCode; e.raw=data; return reject(e);
        }
      });
    });
    req.on('error', reject);
  });
}

function httpDelete(url, { headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https:') ? https : http;
    const u = new URL(url);
    const req = lib.request({
      method:'DELETE', protocol:u.protocol, hostname:u.hostname,
      port: u.port || (u.protocol==='https:'?443:80), path: u.pathname+(u.search||''), headers
    }, res => {
      let data=''; res.on('data', c => data+=c);
      res.on('end', () => {
        if (res.statusCode>=200 && res.statusCode<300) return resolve({ ok:true, status:res.statusCode });
        try { const j=JSON.parse(data||'{}'); const e=new Error(j.error||j.message||`http_${res.statusCode}`); e.status=res.statusCode; e.body=j; return reject(e); }
        catch { const e=new Error('http_error'); e.status=res.statusCode; e.raw=data; return reject(e); }
      });
    });
    req.on('error', reject); req.end();
  });
}

// ICU creds via DB Bridge
async function getIcuCredsForUid(uid, source = 'gpt') {
  const base = process.env.STAS_BASE || 'http://127.0.0.1:3336';
  const key  = process.env.STAS_KEY;
  if (!key) { const e=new Error('missing_stas_key'); e.status=500; throw e; }
  const url = `${base.replace(/\/+$/,'')}/api/db/icu_creds?user_id=${encodeURIComponent(uid)}`;
  const creds = await httpJSON(url, {
    headers: {
      'X-API-Key': key,
      Accept: 'application/json',
      'x-stas-source': normalizeSource(source),
    },
  });
  const apiKey    = creds.api_key    || (creds.ok && creds.api_key)    || creds.api_key;
  const athlete_id = creds.athlete_id || (creds.ok && creds.athlete_id) || creds.athlete_id;
  if (!apiKey || !athlete_id) { const e=new Error('icu_credentials_not_found'); e.status=404; e.details=creds; throw e; }
  return { apiKey, athlete_id };
}

// List events DIRECTLY from Intervals.icu (for dedupe/delete)
async function icuListEvents({ apiKey, athlete_id, q = {}, allowBasicFallback = true }) {
  const u = new URL(`https://intervals.icu/api/v1/athlete/${encodeURIComponent(athlete_id)}/events`);
  for (const [k,v] of Object.entries(q)) if (v!=null && v!=='') u.searchParams.set(k, String(v));
  // Try Bearer (OAuth) first, fallback to Basic (API key)
  try {
    const r = await httpJSON(u.toString(), { headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' } });
    return r;
  } catch (_e) {
    if (!allowBasicFallback) throw _e;
    const auth = 'Basic ' + b64(`API_KEY:${apiKey}`);
    return await httpJSON(u.toString(), { headers: { Authorization: auth, Accept: 'application/json' } });
  }
}

// List via this Gateway (used by DELETE dry-run UX)
async function gwListByPrefix({ authHeader, q }) {
  const port = process.env.PORT || 3337;
  const url = new URL(`http://127.0.0.1:${port}/gw/icu/events`);
  for (const [k,v] of Object.entries(q||{})) if (v!=null && v!=='') url.searchParams.set(k, v);
  return await httpJSON(url.toString(), { headers: { Authorization: authHeader, Accept: 'application/json', "X-API-Key": getStasKey(), "Accept": "application/json" } });
}

// Delete by ICU numeric id
async function icuDeleteEventById({ apiKey, athlete_id, id, allowBasicFallback = true }) {
  const url  = `https://intervals.icu/api/v1/athlete/${encodeURIComponent(athlete_id)}/events/${encodeURIComponent(id)}`;
  // Try Bearer (OAuth) first, fallback to Basic (API key)
  try {
    return await httpDelete(url, { headers: { Authorization: `Bearer ${apiKey}`, Accept:'application/json' } });
  } catch (_e) {
    if (!allowBasicFallback) throw _e;
    const auth = 'Basic ' + b64(`API_KEY:${apiKey}`);
    return await httpDelete(url, { headers: { Authorization: auth, Accept:'application/json' } });
  }
}
const getStasKey = require("./get_stas_key");

module.exports = { getIcuCredsForUid, icuListEvents, gwListByPrefix, icuDeleteEventById };
