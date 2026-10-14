// window→bulk-delete shim for /gw/icu/events
// Если DELETE без id, но с external_id_prefix + oldest + newest:
//  - dry_run: вернём список id
//  - real: PUT /api/v1/athlete/0/events/bulk-delete с OAuth Bearer (fallback Basic API_KEY)
const { getIcuRequestAuth } = require('./icu-request-auth');
const { getRequestUserId } = require('./request-auth');
const { getRequestSource, isStasServerRequest } = require('./request-source');
const { getStasRequestId } = require('./request-id');
const { fetchIntervals, forwardRetryAfter } = require('./icu-attempt-ledger');

// Log-safe upstream error category: timeout vs any other upstream failure.
function upstreamErrorCategory(error) {
  const name = String(error?.name || '');
  const message = String(error?.message || '');
  return (name === 'AbortError' || name === 'TimeoutError' ||
    /\b(abort|aborted|timeout|timed out)\b/i.test(message)) ? 'upstream_timeout' : 'upstream_error';
}

function icuDeleteLogFields(req, extra = {}) {
  return JSON.stringify({
    stas_request_id: getStasRequestId(req),
    method: req.method,
    path: req.path,
    ...extra,
  });
}

// Лимит Intervals (429): отдаём честный 429 с Retry-After (секунды или HTTP-дата), если он разбирается.
function sendRateLimited(res, retryAfter, extra = {}) {
  const retryAfterMs = forwardRetryAfter(res, retryAfter);
  return res.status(429).json({
    ok: false,
    error: 'rate_limited',
    ...(retryAfterMs !== null ? { retry_after_ms: retryAfterMs } : {}),
    ...extra,
  });
}

// Отказ Intervals по запросу (400, 409, 422 и прочие 4xx, кроме auth/not found/429): статус отдаём как есть.
function isRejectionStatus(status) {
  return status >= 400 && status < 500 && ![401, 403, 404, 429].includes(status);
}

// Заголовки внутренних запросов к нашему же GET/DELETE /gw/icu/events: Authorization, проверенный источник,
// id запроса и номер попытки; X-API-Key - только если исходный запрос был проверенным серверным вызовом STAS.
function localHopHeaders(req) {
  const authIn = (req.get && req.get('authorization')) || req.headers['authorization'];
  const attempt = (req.get && req.get('x-stas-attempt')) || req.headers['x-stas-attempt'];
  const requestId = getStasRequestId(req);
  return {
    ...(authIn ? { Authorization: authIn } : {}),
    'x-stas-source': getRequestSource(req),
    ...(requestId ? { 'x-stas-request-id': requestId } : {}),
    ...(attempt ? { 'x-stas-attempt': String(attempt) } : {}),
    ...(isStasServerRequest(req) ? { 'X-API-Key': process.env.STAS_KEY } : {}),
  };
}

async function sendBulkDelete({apiBase, token, items, prefer='bearer', allowBasicFallback=true, ledger={}}){
  const path = `${apiBase}/athlete/0/events/bulk-delete`;
  const body = JSON.stringify(items.map(id => ({ id: Number(id) })));
  const h = (mode)=> {
    const headers = { 'Accept':'application/json', 'Content-Type':'application/json' };
    if (mode==='bearer') headers['Authorization'] = `Bearer ${token}`;
    else headers['Authorization'] = `Basic ${Buffer.from(`API_KEY:${token}`).toString('base64')}`;
    return headers;
  };
  // попытка prefer, затем альтернатива на 401/403
  let resp = await fetchIntervals(path, { method:'PUT', headers: h(prefer), body }, { ...ledger, kind: prefer });
  if (allowBasicFallback && (resp.status===401 || resp.status===403)){
    const alt = prefer==='bearer' ? 'basic' : 'bearer';
    resp = await fetchIntervals(path, { method:'PUT', headers: h(alt), body }, { ...ledger, kind: alt });
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

function eventExternalId(event) {
  return String(event?.external_id || event?.externalId || '').trim();
}

// События «Болезнь / травма / поездка» (диапазоны календаря STAS) удаляются только явно по id.
const PROTECTED_CATEGORIES = new Set(['SICK', 'INJURED', 'HOLIDAY']);
const PROTECTED_EXTERNAL_ID_RE = /^note:\d{4}-\d{2}-\d{2}:range-/;
const PROTECTED_REASON = 'calendar_range_event_delete_by_id_only';

function isProtectedRangeEvent(event) {
  const category = String(event?.category || '').trim().toUpperCase();
  return PROTECTED_CATEGORIES.has(category) || PROTECTED_EXTERNAL_ID_RE.test(eventExternalId(event));
}

// Разделяет подходящие под predicate события на удаляемые id и защищённые id.
function splitIdsFromEvents(events, predicate) {
  if (!Array.isArray(events)) return { ids: [], protectedIds: [] };

  const ids = [];
  const protectedIds = [];
  for (const event of events) {
    if (!predicate(event)) continue;
    const id = String(event?.id || '').trim();
    if (!id) continue;
    (isProtectedRangeEvent(event) ? protectedIds : ids).push(id);
  }

  return { ids: Array.from(new Set(ids)), protectedIds: Array.from(new Set(protectedIds)) };
}

function protectedField(protectedIds) {
  return protectedIds.length > 0
    ? { protected: { count: protectedIds.length, ids: protectedIds, reason: PROTECTED_REASON } }
    : {};
}

async function listIdsForExactExternalIds({ port, hopHeaders, externalIds, oldest, newest }) {
  const ids = [];
  const protectedIds = [];

  for (const externalId of externalIds) {
    const listUrl = new URL(`http://127.0.0.1:${port}/gw/icu/events`);
    listUrl.searchParams.set('external_id', externalId);

    const fallbackDate = dateFromExternalId(externalId);
    if (oldest || fallbackDate) listUrl.searchParams.set('oldest', oldest || fallbackDate);
    if (newest || fallbackDate) listUrl.searchParams.set('newest', newest || fallbackDate);

    const lr = await fetch(listUrl, { headers: hopHeaders });
    if (!lr.ok) {
      const e = new Error('events_fetch_failed');
      e.status = 502;
      e.fetchStatus = lr.status;
      e.retryAfter = lr.headers?.get?.('retry-after') ?? null;
      throw e;
    }

    const arr = await lr.json();
    const split = splitIdsFromEvents(arr, event => eventExternalId(event) === externalId);
    ids.push(...split.ids);
    protectedIds.push(...split.protectedIds);
  }

  return { ids: Array.from(new Set(ids)), protectedIds: Array.from(new Set(protectedIds)) };
}

module.exports = function(app){
  app.get('/gw/icu/events/delete-preview', async (req, res) => {
    try {
      const port = process.env.PORT || '3338';
      const previewUrl = new URL(`http://127.0.0.1:${port}/gw/icu/events`);

      for (const [key, value] of Object.entries(req.query || {})) {
        for (const item of collectQueryValues(value)) previewUrl.searchParams.append(key, item);
      }
      previewUrl.searchParams.set('dry_run', 'true');

      const preview = await fetch(previewUrl, {
        method: 'DELETE',
        headers: localHopHeaders(req),
      });
      const body = await preview.json();
      return res.status(preview.status).json(body);
    } catch (e) {
      try { console.error(`[icu][DELETE][preview][ERR] ${icuDeleteLogFields(req, {
        status: 500,
        category: upstreamErrorCategory(e),
      })}`); } catch {}
      return res.status(500).json({ ok: false, error: 'delete_preview_failed' });
    }
  });

  app.delete('/gw/icu/events', async (req, res, next) => {
    try{
      const q = req.query || {};
      const explicitIds = [...new Set(collectQueryValues(q.id))];
      const exactExternalIds = [
        ...collectQueryValues(q.external_id),
        ...collectQueryValues(q.external_ids),
      ];
      const hasId = explicitIds.length > 0;
      const hasExactExternalId = exactExternalIds.length > 0;
      const hasPrefix = typeof q.external_id_prefix === 'string' && q.external_id_prefix.length>0;
      const hasWindow = !!(q.oldest && q.newest);
      if (!hasId && !hasExactExternalId && (!hasPrefix || !hasWindow)) return next();
      const uid = getRequestUserId(req);
      if (!uid) return res.status(401).json({ ok:false, error:'missing_or_invalid_token' });

      // dry-run по умолчанию: если ChatGPT-User — real; иначе — dry
      const ua = (req.get && req.get('user-agent')) || req.headers['user-agent'] || '';
      const askedDry = Object.prototype.hasOwnProperty.call(q,'dry_run');
      const isGPT = /ChatGPT-User/i.test(ua);
      const isDryRun = askedDry ? (String(q.dry_run).toLowerCase() !== 'false') : !isGPT;

      // 1) ids через точный id, exact external_id или локальный GET с тем же Authorization
      const port = process.env.PORT || '3338';
      const hopHeaders = localHopHeaders(req);
      let ids = explicitIds;
      let protectedIds = [];

      if (!hasId && hasExactExternalId) {
        ({ ids, protectedIds } = await listIdsForExactExternalIds({
          port,
          hopHeaders,
          externalIds: exactExternalIds,
          oldest: q.oldest,
          newest: q.newest,
        }));
      }

      if (!hasId && !hasExactExternalId) {
        const listUrl = new URL(`http://127.0.0.1:${port}/gw/icu/events`);
        listUrl.searchParams.set('external_id_prefix', q.external_id_prefix);
        listUrl.searchParams.set('oldest', q.oldest);
        listUrl.searchParams.set('newest', q.newest);
        const lr = await fetch(listUrl, { headers: hopHeaders });
        if (lr.status === 429) return sendRateLimited(res, lr.headers?.get?.('retry-after'));
        if (!lr.ok) return res.status(isRejectionStatus(lr.status) ? lr.status : 502).json({ ok:false, error:'events_fetch_failed', status:lr.status });
        const arr = await lr.json();
        ({ ids, protectedIds } = splitIdsFromEvents(arr, event => eventExternalId(event).startsWith(q.external_id_prefix)));
      }

      if (isDryRun){
        return res.json({
          ok:true, dry_run:true,
          uid: String(uid),
          selector: hasId
            ? { id: explicitIds }
            : hasExactExternalId
              ? { external_ids: exactExternalIds }
              : { prefix:q.external_id_prefix, window:{ oldest:q.oldest, newest:q.newest } },
          to_delete:{ count:ids.length, ids },
          ...protectedField(protectedIds)
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
          deleted_count:0, deleted_ids:[], failed:[],
          ...protectedField(protectedIds)
        });
      }

      const auth = await getIcuRequestAuth(req);

      const API_BASE = process.env.INTERVALS_API_BASE_URL || 'https://intervals.icu/api/v1';

      // 3) bulk-delete (athlete=0): Bearer -> (при необходимости) Basic
      let resp = await sendBulkDelete({
        apiBase: API_BASE,
        token: auth.token,
        items: ids,
        prefer:'bearer',
        allowBasicFallback: auth.authMode !== 'intervals',
        ledger: { req, auth },
      });

      let deleted_ids = [];
      let failed = [];
      let unconfirmed_ids = [];
      let deleted_count = 0;
      let body = null;
      let retryAfterBody = {};

      try { body = await resp.clone().json(); } catch { try { body = await resp.text(); } catch(_){} }

      if (resp.ok){
        if (typeof body === 'number') deleted_count = body;
        else if (body && typeof body === 'object' && ('deleted_count' in body)) {
          deleted_count = Number(body.deleted_count)||0;
          if (Array.isArray(body.deleted_ids)) deleted_ids = body.deleted_ids.map(String);
        }
        else if (body && typeof body === 'object' && Array.isArray(body.deleted_ids)) {
          deleted_ids = body.deleted_ids.map(String);
          deleted_count = deleted_ids.length;
        } else {
          deleted_count = ids.length;
          deleted_ids = ids.slice();
        }
        // 200 не значит «удалено всё». С deleted_ids: failed = запрошенные id, которых там нет.
        // Только счётчик: при 0 удалённых точно ничего не удалено (все id в failed);
        // при 0 < счётчик < запрошенного какие именно удалились — неизвестно, поэтому
        // id не называем неудачными, а отдаём как unconfirmed_ids.
        const confirmed = new Set(deleted_ids);
        if (deleted_ids.length > 0) {
          if (ids.some(id => !confirmed.has(String(id)))) {
            failed = ids
              .filter(id => !confirmed.has(String(id)))
              .map(id => ({ id, status: resp.status, reason: 'not_deleted_by_intervals' }));
          }
        } else if (deleted_count <= 0 && ids.length > 0) {
          failed = ids.map(id => ({ id, status: resp.status, reason: 'not_deleted_by_intervals' }));
        } else if (deleted_count < ids.length) {
          unconfirmed_ids = ids.map(String);
        }
      } else {
        failed = ids.map(id => ({ id, status: resp.status }));
      }

      // Intervals ответил 429: тот же ответ, но HTTP 429 и Retry-After, чтобы вызывающий мог подождать.
      if (!resp.ok && resp.status === 429) {
        const retryAfterMs = forwardRetryAfter(res, resp.headers?.get?.('retry-after'));
        res.status(429);
        retryAfterBody = { error: 'rate_limited', ...(retryAfterMs !== null ? { retry_after_ms: retryAfterMs } : {}) };
      } else if (!resp.ok && isRejectionStatus(resp.status)) {
        res.status(resp.status);
      }
      return res.json({
        ok: resp.ok && failed.length === 0 && unconfirmed_ids.length === 0, dry_run:false,
        ...retryAfterBody,
        ...(resp.ok && failed.length > 0 ? { error: 'delete_incomplete' } : {}),
        ...(resp.ok && unconfirmed_ids.length > 0 ? { error: 'delete_unconfirmed' } : {}),
        selector: hasId
          ? { id: explicitIds }
          : hasExactExternalId
            ? { external_ids: exactExternalIds }
            : { prefix:q.external_id_prefix, window:{ oldest:q.oldest, newest:q.newest } },
        deleted_count, deleted_ids, failed,
        ...protectedField(protectedIds),
        ...(unconfirmed_ids.length > 0 ? { unconfirmed_ids, requested_count: ids.length } : {}),
        mode_hint: resp._used_alt ? `auth:${resp._used_alt}` : `auth:${auth.authMode === 'intervals' ? 'intervals-bearer' : 'bearer'}`
      });
    }catch(e){
      if (e?.status === 401) {
        return res.status(401).json({ ok:false, error:'missing_or_invalid_token' });
      }
      if (e?.status === 404) {
        return res.status(404).json({ ok:false, error:'icu_creds_not_found' });
      }
      if (e?.fetchStatus === 429) return sendRateLimited(res, e.retryAfter);
      if (isRejectionStatus(e?.fetchStatus)) {
        return res.status(e.fetchStatus).json({ ok:false, error:'events_fetch_failed', status:e.fetchStatus });
      }
      try { console.error(`[icu][DELETE][shim][ERR] ${icuDeleteLogFields(req, {
        status: 500,
        category: upstreamErrorCategory(e),
      })}`); } catch {}
      return res.status(500).json({ ok:false, error:'window_shim_failed' });
    }
  });
};
