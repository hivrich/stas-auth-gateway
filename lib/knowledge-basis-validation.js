const getStasKey = require('./get_stas_key');
const { getRequestUserId } = require('./request-auth');

const MAX_CHANGE_BASIS_CHARS = 16000;
const MAX_CHANGE_BASIS_ITEMS = 100;
const STAS_BASE = process.env.STAS_BASE || 'http://127.0.0.1:3336';

function parseChangeBasis(raw) {
  if (typeof raw !== 'string' || raw.length > MAX_CHANGE_BASIS_CHARS) return null;
  let items;
  try { items = JSON.parse(raw); } catch { return null; }
  if (!Array.isArray(items) || items.length < 1 || items.length > MAX_CHANGE_BASIS_ITEMS) return null;

  for (const item of items) {
    if (!item || typeof item !== 'object' || Array.isArray(item)
      || Object.keys(item).length !== 4
      || typeof item.external_id !== 'string' || item.external_id.length < 1 || item.external_id.length > 200
      || typeof item.frame_id !== 'string' || !/^F-[a-z0-9]+(?:-[a-z0-9]+)*$/.test(item.frame_id)
      || !Number.isInteger(item.frame_version) || item.frame_version <= 0
      || typeof item.decision_id !== 'string' || !/^D\d+$/.test(item.decision_id)) return null;
  }
  return items;
}

async function responseBody(response) {
  try { return await response.json(); } catch { return { error: 'knowledge_basis_unavailable' }; }
}

async function validateChangeBasis(req) {
  const query = req?.query || {};
  if (!Object.prototype.hasOwnProperty.call(query, 'change_basis')) return { ok: true, present: false };

  const items = parseChangeBasis(query.change_basis);
  if (!items) return { ok: false, status: 400, body: { error: 'invalid_change_basis' } };

  const userId = getRequestUserId(req);
  if (!userId) return { ok: false, status: 401, body: { error: 'missing_or_invalid_token' } };
  const stasKey = getStasKey();
  if (!stasKey) return { ok: false, status: 503, body: { error: 'knowledge_basis_unavailable' } };

  try {
    const url = new URL(`${STAS_BASE.replace(/\/+$/, '')}/api/db/knowledge/basis`);
    url.searchParams.set('user_id', String(userId));
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'X-API-Key': stasKey, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ items }),
      signal: AbortSignal.timeout(3000),
    });
    if (!response.ok) {
      const status = response.status >= 400 && response.status <= 599 ? response.status : 502;
      const retryAfter = response.headers?.get?.('retry-after');
      return {
        ok: false,
        status,
        body: await responseBody(response),
        ...(retryAfter ? { retryAfter } : {}),
      };
    }

    const result = await response.json();
    if (result?.ok !== true || typeof result.change_basis !== 'string' || !parseChangeBasis(result.change_basis)) {
      return { ok: false, status: 502, body: { error: 'knowledge_basis_unavailable' } };
    }
    // Downstream callback receives only the app-validated, canonical basis.
    req.changeBasisValidated = result.change_basis;
    return { ok: true, present: true };
  } catch {
    return { ok: false, status: 503, body: { error: 'knowledge_basis_unavailable' } };
  }
}

function sendBasisFailure(res, result) {
  if (result.retryAfter) res.set('Retry-After', result.retryAfter);
  return res.status(result.status).json(result.body);
}

module.exports = { validateChangeBasis, sendBasisFailure, __testing: { parseChangeBasis } };
