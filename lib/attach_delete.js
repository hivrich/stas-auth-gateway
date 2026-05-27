// window→bulk-delete shim for /gw/icu/events
// Если DELETE без id, но с external_id_prefix + oldest + newest:
//  - dry_run: вернём список id
//  - real: PUT /api/v1/athlete/0/events/bulk-delete с OAuth Bearer (fallback Basic API_KEY)
const { getIcuRequestAuth } = require('./icu-request-auth');
const { getRequestUserId } = require('./request-auth');

async function sendBulkDelete({apiBase, token, items, prefer='bearer', allowBasicFallback=true}){
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
  if (allowBasicFallback && (resp.status===401 || resp.status===403)){
    const alt = prefer==='bearer' ? 'basic' : 'bearer';
    resp = await fetch(path, { method:'PUT', headers: h(alt), body });
    resp._used_alt = alt;
  }
  return resp;
}

function collectQueryValues(value) {
  const raw = Array.isArray(value) ? value : [value];
  return raw
    .flatMap(item => String(item ?? '').split(','))
    .map(item => item.trim())
    .filter(Boolean);
}

function dateFromExternalId(externalId) {
  const match = String(externalId || '').match(/^(?:plan|note):(\d{4}-\d{2}-\d{2}):/);
  return match ? match[1] : null;
}

async function listIdsForExactExternalIds({ port, authIn, externalIds, oldest, newest }) {
  const ids = [];

  for (const externalId of externalIds) {
    const listUrl = new URL(`http://127.0.0.1:${port}/gw/icu/events`);
    listUrl.searchParams.set('external_id', externalId);

    const fallbackDate = dateFromExternalId(externalId);
    if (oldest || fallbackDate) listUrl.searchParams.set('oldest', oldest || fallbackDate);
    if (newest || fallbackDate) listUrl.searchParams.set('newest', newest || fallbackDate);

    const lr = await fetch(listUrl, { headers: authIn ? { Authorization: authIn } : {} });
    if (!lr.ok) {
      const e = new Error('events_fetch_failed');
      e.status = 502;
      e.fetchStatus = lr.status;
      throw e;
    }

    const arr = await lr.json();
    if (Array.isArray(arr)) {
      ids.push(...arr.map(e => String(e.id)).filter(Boolean));
    }
  }

  return Array.from(new Set(ids));
}

module.exports = function(app){
  app.delete('/gw/icu/events', async (req, res, next) => {
    try{
      const q = req.query || {};
      const explicitIds = collectQueryValues(q.id);
      const exactExternalIds = [
        ...collectQueryValues(q.external_id),
        ...collectQueryValues(q.external_ids),
      ];
      const hasId = explicitIds.length > 0;
      const hasExactExternalId = exactExternalIds.length > 0;
      const hasPrefix = typeof q.external_id_prefix === 'string' && q.external_id_prefix.length>0;
      const hasWindow = !!(q.oldest && q.newest);
      if (!hasId && !hasExactExternalId && (!hasPrefix || !hasWindow)) return next();

      // dry-run по умолчанию: если ChatGPT-User — real; иначе — dry
      const ua = (req.get && req.get('user-agent')) || req.headers['user-agent'] || '';
      const askedDry = Object.prototype.hasOwnProperty.call(q,'dry_run');
      const isGPT = /ChatGPT-User/i.test(ua);
      const isDryRun = askedDry ? (String(q.dry_run).toLowerCase() !== 'false') : !isGPT;

      // 1) ids через точный id, exact external_id или локальный GET с тем же Authorization
      const port = process.env.PORT || '3338';
      const authIn = (req.get && req.get('authorization')) || req.headers['authorization'];
      let ids = explicitIds;

      if (!hasId && hasExactExternalId) {
        ids = await listIdsForExactExternalIds({
          port,
          authIn,
          externalIds: exactExternalIds,
          oldest: q.oldest,
          newest: q.newest,
        });
      }

      if (!hasId && !hasExactExternalId) {
        const listUrl = new URL(`http://127.0.0.1:${port}/gw/icu/events`);
        listUrl.searchParams.set('external_id_prefix', q.external_id_prefix);
        listUrl.searchParams.set('oldest', q.oldest);
        listUrl.searchParams.set('newest', q.newest);
        const lr = await fetch(listUrl, { headers: authIn ? { Authorization: authIn } : {} });
        if (!lr.ok) return res.status(502).json({ ok:false, error:'events_fetch_failed', status:lr.status });
        const arr = await lr.json();
        ids = Array.isArray(arr) ? arr.map(e => String(e.id)).filter(Boolean) : [];
      }
      const uid = String(q.user_id || getRequestUserId(req) || '').trim();

      if (isDryRun){
        return res.json({
          ok:true, dry_run:true,
          uid,
          selector: hasId
            ? { id: explicitIds }
            : hasExactExternalId
              ? { external_ids: exactExternalIds }
              : { prefix:q.external_id_prefix, window:{ oldest:q.oldest, newest:q.newest } },
          to_delete:{ count:ids.length, ids }
        });
      }
      if (ids.length===0){
        return res.json({
          ok:true, dry_run:false,
          selector: hasId
            ? { id: explicitIds }
            : hasExactExternalId
              ? { external_ids: exactExternalIds }
              : { prefix:q.external_id_prefix, window:{ oldest:q.oldest, newest:q.newest } },
          deleted_count:0, deleted_ids:[], failed:[]
        });
      }

      if (!uid) return res.status(400).json({ ok:false, error:'missing_user_id' });
      const auth = await getIcuRequestAuth(req);

      const API_BASE = process.env.INTERVALS_API_BASE_URL || 'https://intervals.icu/api/v1';

      // 3) bulk-delete (athlete=0): Bearer -> (при необходимости) Basic
      let resp = await sendBulkDelete({
        apiBase: API_BASE,
        token: auth.token,
        items: ids,
        prefer:'bearer',
        allowBasicFallback: auth.authMode !== 'intervals',
      });

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
        selector: hasId
          ? { id: explicitIds }
          : hasExactExternalId
            ? { external_ids: exactExternalIds }
            : { prefix:q.external_id_prefix, window:{ oldest:q.oldest, newest:q.newest } },
        deleted_count, deleted_ids, failed,
        mode_hint: resp._used_alt ? `auth:${resp._used_alt}` : `auth:${auth.authMode === 'intervals' ? 'intervals-bearer' : 'bearer'}`
      });
    }catch(e){
      if (e?.status === 401) {
        return res.status(401).json({ ok:false, error:'missing_or_invalid_token' });
      }
      if (e?.status === 404) {
        return res.status(404).json({ ok:false, error:'icu_creds_not_found' });
      }
      console.error('[icu][DELETE][shim] error:', e && e.stack || e);
      return res.status(500).json({ ok:false, error:'window_shim_failed' });
    }
  });
};
