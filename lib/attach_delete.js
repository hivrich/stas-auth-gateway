// window→bulk-delete shim for /gw/icu/events
// Если DELETE без id, но с external_id_prefix + oldest + newest:
//  - dry_run: вернём список id
//  - real: PUT /api/v1/athlete/0/events/bulk-delete с OAuth Bearer (fallback Basic API_KEY)

function decodeUidFromBearer(auth){
  try{
    if(!auth) return null;
    const m = String(auth).match(/Bearer\s+t_([A-Za-z0-9_-]+)/i);
    if(!m) return null;
    let b64 = m[1].replace(/-/g,'+').replace(/_/g,'/'); while(b64.length%4!==0) b64+='=';
    const obj = JSON.parse(Buffer.from(b64,'base64').toString('utf8'));
    const uid = (obj && (obj.uid||obj.user_id)) ? String(obj.uid||obj.user_id) : null;
    return uid && /^\d+$/.test(uid) ? uid : null;
  }catch(_){ return null; }
}

async function sendBulkDelete({apiBase, token, items, prefer='bearer'}){
  const path = `${apiBase}/athlete/0/events/bulk-delete`;
  const body = JSON.stringify(items.map(id => ({ id: Number(id) })));
  const h = (mode)=> {
    const headers = { 'Accept':'application/json', 'Content-Type':'application/json' };
    if (mode==='bearer') headers['Authorization'] = `Bearer ${token}`;
    else headers['Authorization'] = `Basic ${Buffer.from(`API_KEY:${token}`).toString('base64')}`;
    return headers;
  };
  // попытка prefer, затем альтернатива на 401/403
  let resp = await fetch(path, { method:'PUT', headers: h(prefer), body });
  if (resp.status===401 || resp.status===403){
    const alt = prefer==='bearer' ? 'basic' : 'bearer';
    resp = await fetch(path, { method:'PUT', headers: h(alt), body });
    resp._used_alt = alt;
  }
  return resp;
}

module.exports = function(app){
  app.delete('/gw/icu/events', async (req, res, next) => {
    try{
      const q = req.query || {};
      const hasId = !!q.id;
      const hasPrefix = typeof q.external_id_prefix === 'string' && q.external_id_prefix.length>0;
      const hasWindow = !!(q.oldest && q.newest);
      if (hasId || !hasPrefix || !hasWindow) return next();

      // dry-run по умолчанию: если ChatGPT-User — real; иначе — dry
      const ua = (req.get && req.get('user-agent')) || req.headers['user-agent'] || '';
      const askedDry = Object.prototype.hasOwnProperty.call(q,'dry_run');
      const isGPT = /ChatGPT-User/i.test(ua);
      const isDryRun = askedDry ? (String(q.dry_run).toLowerCase() !== 'false') : !isGPT;

      // 1) ids через локальный GET с тем же Authorization
      const port = process.env.PORT || '3338';
      const listUrl = new URL(`http://127.0.0.1:${port}/gw/icu/events`);
      listUrl.searchParams.set('external_id_prefix', q.external_id_prefix);
      listUrl.searchParams.set('oldest', q.oldest);
      listUrl.searchParams.set('newest', q.newest);
      const authIn = (req.get && req.get('authorization')) || req.headers['authorization'];
      const lr = await fetch(listUrl, { headers: authIn ? { Authorization: authIn } : {} });
      if (!lr.ok) return res.status(502).json({ ok:false, error:'events_fetch_failed', status:lr.status });
      const arr = await lr.json();
      const ids = Array.isArray(arr) ? arr.map(e => String(e.id)).filter(Boolean) : [];

      if (isDryRun){
        return res.json({
          ok:true, dry_run:true,
          uid:String(q.user_id || decodeUidFromBearer(authIn) || ''),
          prefix:q.external_id_prefix,
          window:{ oldest:q.oldest, newest:q.newest },
          to_delete:{ count:ids.length, ids }
        });
      }
      if (ids.length===0){
        return res.json({
          ok:true, dry_run:false,
          prefix:q.external_id_prefix,
          window:{ oldest:q.oldest, newest:q.newest },
          deleted_count:0, deleted_ids:[], failed:[]
        });
      }

      // 2) ключ/токен из DB-bridge
      const STAS_BASE = process.env.STAS_BASE || 'http://127.0.0.1:3336';
      const STAS_KEY  = process.env.STAS_KEY  || '';
      const uid = String(q.user_id || decodeUidFromBearer(authIn) || '').trim();
      if (!uid) return res.status(400).json({ ok:false, error:'missing_user_id' });

      const credsUrl = new URL(`${STAS_BASE}/api/db/icu_creds`); credsUrl.searchParams.set('user_id', uid);
      const cr = await fetch(credsUrl, { headers: STAS_KEY ? { 'X-API-Key': STAS_KEY } : {} });
      if (!cr.ok) return res.status(502).json({ ok:false, error:'icu_creds_fetch_failed', status:cr.status });
      const cj = await cr.json();
      if (!cj || !cj.ok || !cj.api_key) return res.status(400).json({ ok:false, error:'invalid_icu_creds' });

      const API_BASE = process.env.INTERVALS_API_BASE_URL || 'https://intervals.icu/api/v1';
      const apiKey = String(cj.api_key);

      // 3) bulk-delete (athlete=0): Bearer -> (при необходимости) Basic
      let resp = await sendBulkDelete({ apiBase: API_BASE, token: apiKey, items: ids, prefer:'bearer' });

      let deleted_ids = [];
      let failed = [];
      let deleted_count = 0;
      let body = null;

      try { body = await resp.clone().json(); } catch { try { body = await resp.text(); } catch(_){} }

      if (resp.ok){
        if (typeof body === 'number') deleted_count = body;
        else if (body && typeof body === 'object' && ('deleted_count' in body)) deleted_count = Number(body.deleted_count)||0;
        else if (body && typeof body === 'object' && Array.isArray(body.deleted_ids)) {
          deleted_ids = body.deleted_ids.map(String);
          deleted_count = deleted_ids.length;
        } else {
          deleted_count = ids.length;
          deleted_ids = ids.slice();
        }
      } else {
        failed = ids.map(id => ({ id, status: resp.status }));
      }

      return res.json({
        ok: resp.ok, dry_run:false,
        prefix:q.external_id_prefix,
        window:{ oldest:q.oldest, newest:q.newest },
        deleted_count, deleted_ids, failed,
        mode_hint: resp._used_alt ? `auth:${resp._used_alt}` : 'auth:bearer'
      });
    }catch(e){
      console.error('[icu][DELETE][shim] error:', e && e.stack || e);
      return res.status(500).json({ ok:false, error:'window_shim_failed' });
    }
  });
};
