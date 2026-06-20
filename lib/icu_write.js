const http = require('http');
const https = require('https');
function b64(s) { return Buffer.from(s, 'utf8').toString('base64'); }

function resolveAuth({ auth, apiKey, athlete_id }) {
  if (auth && auth.token && auth.athleteId) return auth;
  return {
    token: apiKey,
    athleteId: athlete_id,
    authMode: 'legacy',
  };
}

function buildAuthHeaders(auth, mode, extra = {}) {
  const headers = {
    Accept: 'application/json',
    ...extra,
  };
  if (mode === 'basic') {
    headers.Authorization = 'Basic ' + b64(`API_KEY:${auth.token}`);
  } else {
    headers.Authorization = `Bearer ${auth.token}`;
  }
  return headers;
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    signal: options.signal || AbortSignal.timeout(10000),
  });
  const text = await response.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = null;
  }
  if (response.ok) return body || {};

  const error = new Error((body && (body.error || body.message)) || `http_${response.status}`);
  error.status = response.status;
  error.body = body;
  error.raw = body ? undefined : text;
  return Promise.reject(error);
}

async function fetchWithIcuAuth(url, { auth, method = 'GET', body } = {}) {
  const baseHeaders = method === 'POST'
    ? { 'Content-Type': 'application/json' }
    : {};
  const request = (mode) => fetchJson(url, {
    method,
    headers: buildAuthHeaders(auth, mode, baseHeaders),
    ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }),
  });

  try {
    return await request('bearer');
  } catch (error) {
    if ((error.status === 401 || error.status === 403) && auth.authMode === 'legacy') {
      return request('basic');
    }
    error.authMode = auth.authMode;
    throw error;
  }
}

function getJSON(url, { headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https:') ? https : http;
    const req = lib.get(url, { headers }, res => {
      let data = '';
      res.on('data', c => (data += c));
      res.on('end', () => {
        try {
          const body = data ? JSON.parse(data) : {};
          if (res.statusCode >= 200 && res.statusCode < 300) return resolve(body);
          const err = new Error((body && (body.error || body.message)) || `http_${res.statusCode}`);
          err.status = res.statusCode; err.body = body; return reject(err);
        } catch {
          const err = new Error(`bad_json_${res.statusCode}`);
          err.status = res.statusCode; err.raw = data; return reject(err);
        }
      });
    });
    req.on('error', reject);
  });
}

function postJSON(url, { headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https:') ? https : http;
    const u = new URL(url);
    const payload = typeof body === 'string' ? body : JSON.stringify(body);
    const req = lib.request({
      method: 'POST',
      protocol: u.protocol,
      hostname: u.hostname,
      port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + (u.search || ''),
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
        ...headers
      }
    }, res => {
      let data = '';
      res.on('data', c => (data += c));
      res.on('end', () => {
        const sc = res.statusCode || 0;
        if (sc >= 200 && sc < 300) {
          if (!data) return resolve({});
          try { return resolve(JSON.parse(data)); } catch { return resolve({}); }
        }
        try { const j = JSON.parse(data || '{}'); const e = new Error(j.error || j.message || `http_${sc}`); e.status = sc; e.body = j; return reject(e); }
        catch { const e = new Error('http_error'); e.status = sc; e.raw = data; return reject(e); }
      });
    });
    req.on('error', reject);
    req.end(payload);
  });
}

async function getIcuCredsForUid(uid) {
  const base = process.env.STAS_BASE || 'http://127.0.0.1:3336';
  const key  = process.env.STAS_KEY;
  if (!key) { const e = new Error('missing_stas_key'); e.status = 500; throw e; }
  const url = `${base.replace(/\/+$/,'')}/api/db/icu_creds?user_id=${encodeURIComponent(uid)}`;
  const creds = await getJSON(url, { headers: { 'X-API-Key': key } });
  const apiKey    = creds.api_key    || (creds.ok && creds.api_key)    || creds.api_key;
  const athlete_id = creds.athlete_id || (creds.ok && creds.athlete_id) || creds.athlete_id;
  if (!apiKey || !athlete_id) { const e = new Error('icu_credentials_not_found'); e.status = 404; e.details = creds; throw e; }
  return { apiKey, athlete_id };
}

async function icuListEventsWithAuth({ auth, q = {} }) {
  const resolvedAuth = resolveAuth({ auth });
  const u = new URL(`https://intervals.icu/api/v1/athlete/${encodeURIComponent(resolvedAuth.athleteId)}/events`);
  for (const [key, value] of Object.entries(q)) {
    if (value !== null && value !== undefined && value !== '') u.searchParams.set(key, String(value));
  }
  return fetchWithIcuAuth(u.toString(), { auth: resolvedAuth });
}

// ICU принимает по одному событию (JSON-объект) на POST /events.
async function icuCreateEvents({ apiKey, athlete_id, auth, events }) {
  const resolvedAuth = resolveAuth({ auth, apiKey, athlete_id });
  const url = `https://intervals.icu/api/v1/athlete/${encodeURIComponent(resolvedAuth.athleteId)}/events`;
  const results = [];
  for (const e of events) {
    // e уже в snake_case (start_date_local, external_id, ...); шлём как есть
    const resp = await fetchWithIcuAuth(url, { method: 'POST', auth: resolvedAuth, body: e });
    results.push(resp);
  }
  return results;
}

module.exports = { getIcuCredsForUid, icuCreateEvents, icuListEventsWithAuth };
