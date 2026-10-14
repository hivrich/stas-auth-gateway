// window→bulk-delete shim for /gw/icu/events
// Если DELETE без id, но с external_id_prefix + oldest + newest:
//  - dry_run: вернём список id
//  - real: PUT /api/v1/athlete/0/events/bulk-delete с OAuth Bearer (fallback Basic API_KEY)
const { getIcuRequestAuth } = require('./icu-request-auth');
const { getRequestUserId } = require('./request-auth');
const { getRequestSource, isStasServerRequest } = require('./request-source');
const { getStasRequestId } = require('./request-id');
const { fetchIntervals, forwardRetryAfter } = require('./icu-attempt-ledger');
const { reportPlanChange } = require('./plan-change-callback');

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
// Окно и external_id: защищённое событие можно удалить только по id. Явный id не от сайта: только с сайта STAS.
const PROTECTED_REASON = 'calendar_range_event_delete_by_id_only';
const PROTECTED_REASON_SITE_ONLY = 'calendar_range_event_site_only';

// Id события для чтения и удаления: только цифры, безопасное целое; возвращает каноническую строку или null.
function canonicalEventId(id) {
  const raw = String(id);
  if (!/^\d+$/.test(raw)) return null;
  const n = Number(raw);
  return Number.isSafeInteger(n) ? String(n) : null;
}

function isProtectedRangeEvent(event) {
  const category = String(event?.category || '').trim().toUpperCase();
  return PROTECTED_CATEGORIES.has(category) || PROTECTED_EXTERNAL_ID_RE.test(eventExternalId(event));
}

// Разделяет подходящие под predicate события на удаляемые id и защищённые id.
// rowsById (необязательно): запоминаем строки удаляемых событий, чтобы потом сообщить STAS, что удалено.
function splitIdsFromEvents(events, predicate, rowsById = null) {
  if (!Array.isArray(events)) return { ids: [], protectedIds: [] };

  const ids = [];
  const protectedIds = [];
  for (const event of events) {
    if (!predicate(event)) continue;
    const id = String(event?.id || '').trim();
    if (!id) continue;
    if (isProtectedRangeEvent(event)) {
      protectedIds.push(id);
      continue;
    }
    ids.push(id);
    if (rowsById && !rowsById.has(id)) rowsById.set(id, event);
  }

  return { ids: Array.from(new Set(ids)), protectedIds: Array.from(new Set(protectedIds)) };
}

function protectedField(protectedIds, reason = PROTECTED_REASON) {
  return protectedIds.length > 0
    ? { protected: { count: protectedIds.length, ids: protectedIds, reason } }
    : {};
}

// Читает событие по id у Intervals (GET /athlete/0/events/{id}): Bearer, на 401/403 - Basic, как у sendBulkDelete.
// Возвращает { state:'ok', event } | { state:'not_found' } | { state:'failed', status, retryAfter }.
async function readEventForProtection({ apiBase, auth, id, req }) {
  const path = `${apiBase}/athlete/0/events/${encodeURIComponent(String(id))}`;
  const h = (mode) => ({
    Accept: 'application/json',
    Authorization: mode === 'bearer'
      ? `Bearer ${auth.token}`
      : `Basic ${Buffer.from(`API_KEY:${auth.token}`).toString('base64')}`,
  });
  try {
    let resp = await fetchIntervals(path, { method: 'GET', headers: h('bearer') }, { req, auth, kind: 'bearer' });
    if (auth.authMode !== 'intervals' && (resp.status === 401 || resp.status === 403)) {
      resp = await fetchIntervals(path, { method: 'GET', headers: h('basic') }, { req, auth, kind: 'basic' });
    }
    if (resp.status === 404) return { state: 'not_found' };
    if (!resp.ok) {
      return {
        state: 'failed',
        status: Number.isInteger(resp.status) ? resp.status : 502,
        retryAfter: resp.headers?.get?.('retry-after') ?? null,
      };
    }
    let event = null;
    try { event = await resp.json(); } catch {}
    if (!event || typeof event !== 'object' || Array.isArray(event)) return { state: 'failed', status: 502, retryAfter: null };
    return { state: 'ok', event };
  } catch {
    return { state: 'failed', status: 502, retryAfter: null };
  }
}

async function listIdsForExactExternalIds({ port, hopHeaders, externalIds, oldest, newest, rowsById = null }) {
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
    const split = splitIdsFromEvents(arr, event => eventExternalId(event) === externalId, rowsById);
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
      const rowsById = new Map();
      let precheckFailed = [];
      let auth = null;
      const API_BASE = process.env.INTERVALS_API_BASE_URL || 'https://intervals.icu/api/v1';

      // Явный id не от сайта (ИИ-чат, MCP): события «Болезнь/травма/поездка» удаляет только сайт STAS,
      // поэтому перед удалением читаем каждое событие. Сайт идёт как раньше, без чтений.
      const idByNonSite = hasId && getRequestSource(req) !== 'site';
      const protectedReason = hasId ? PROTECTED_REASON_SITE_ONLY : PROTECTED_REASON;
      const selectorOf = () => (hasId
        ? { id: explicitIds }
        : hasExactExternalId
          ? { external_ids: exactExternalIds }
          : { prefix:q.external_id_prefix, window:{ oldest:q.oldest, newest:q.newest } });
      if (idByNonSite) {
        auth = await getIcuRequestAuth(req);
        // Читаем и удаляем одну каноническую форму id; в ответе остаётся исходная строка из запроса.
        const queue = [];
        const seen = new Set();
        for (const id of explicitIds) {
          const canon = canonicalEventId(id);
          if (canon === null) {
            precheckFailed.push({ id, status: 400, reason: 'invalid_id' });
          } else if (!seen.has(canon)) {
            seen.add(canon);
            queue.push({ id, canon });
          }
        }
        const deletable = [];
        for (let i = 0; i < queue.length; i++) {
          const { id, canon } = queue[i];
          const read = await readEventForProtection({ apiBase: API_BASE, auth, id: canon, req });
          if (read.state === 'failed' && read.status === 429) {
            // Лимит Intervals: ничего не удаляем, отвечаем 429 с Retry-After; непроверенные id - в failed.
            const unchecked = queue.slice(i).map(item => ({ id: item.id, status: 429, reason: 'protection_check_failed' }));
            return sendRateLimited(res, read.retryAfter, {
              dry_run: isDryRun,
              selector: selectorOf(),
              deleted_count: 0, deleted_ids: [], failed: [...precheckFailed, ...unchecked],
              ...protectedField(protectedIds, protectedReason)
            });
          }
          if (read.state === 'failed') {
            precheckFailed.push({ id, status: read.status, reason: 'protection_check_failed' });
          } else if (read.state === 'ok' && isProtectedRangeEvent(read.event)) {
            protectedIds.push(id);
          } else {
            deletable.push(id);
          }
        }
        ids = deletable;
      }

      if (!hasId && hasExactExternalId) {
        ({ ids, protectedIds } = await listIdsForExactExternalIds({
          port,
          hopHeaders,
          externalIds: exactExternalIds,
          oldest: q.oldest,
          newest: q.newest,
          rowsById,
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
        ({ ids, protectedIds } = splitIdsFromEvents(arr, event => eventExternalId(event).startsWith(q.external_id_prefix), rowsById));
      }

      if (isDryRun){
        return res.json({
          ok:true, dry_run:true,
          uid: String(uid),
          selector: selectorOf(),
          to_delete:{ count:ids.length, ids },
          ...(precheckFailed.length > 0 ? { failed: precheckFailed } : {}),
          ...protectedField(protectedIds, protectedReason)
        });
      }
      if (ids.length===0){
        return res.json({
          ok: precheckFailed.length === 0, dry_run:false,
          ...(precheckFailed.length > 0 ? { error: 'delete_incomplete' } : {}),
          selector: selectorOf(),
          deleted_count:0, deleted_ids:[], failed: precheckFailed,
          ...protectedField(protectedIds, protectedReason)
        });
      }

      if (!auth) auth = await getIcuRequestAuth(req);

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
        // Id не от сайта (например '0123') уходят в bulk-delete как число 123: сверяем по канонической форме.
        const idKey = idByNonSite ? (id => canonicalEventId(id) ?? String(id)) : String;
        const confirmed = new Set(deleted_ids.map(idKey));
        if (deleted_ids.length > 0) {
          if (ids.some(id => !confirmed.has(idKey(id)))) {
            failed = ids
              .filter(id => !confirmed.has(idKey(id)))
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

      // id, которые не удалось проверить на защиту, не удалялись: показываем их в failed вместе с остальными.
      if (precheckFailed.length > 0) failed = [...precheckFailed, ...failed];

      // Журнал STAS: только реально удалённые id. Подтверждённые deleted_ids; если Intervals вернул
      // только счётчик и он закрывает все запрошенные id (ничего не failed/unconfirmed) - все ids.
      if (resp.ok) {
        const allConfirmed = failed.length === 0 && unconfirmed_ids.length === 0;
        const reportedIds = deleted_ids.length > 0 ? deleted_ids : (allConfirmed && deleted_count > 0 ? ids.map(String) : []);
        await reportPlanChange(req, {
          deleted: reportedIds.map(id => ({ id, row: rowsById.get(String(id)) })),
        });
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
        selector: selectorOf(),
        deleted_count, deleted_ids, failed,
        ...protectedField(protectedIds, protectedReason),
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
