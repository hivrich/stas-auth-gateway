const { randomUUID } = require('node:crypto');

// Only server-owned enums reach the log sink. Never pass request values,
// exception text, claims, credentials, URLs or derived credential hashes here.
const REASONS = Object.freeze({
  ingress: 'ingress', rate_limited: 'ingress', body_rejected: 'parsing',
  route_entered: 'grant', grant_unsupported: 'grant',
  agent_unconfigured: 'agent', agent_claim_missing: 'agent', agent_poll_rejected: 'agent',
  refresh_missing: 'refresh', refresh_invalid: 'refresh', refresh_rejected: 'refresh',
  code_missing: 'code', code_not_found: 'code', code_reserved: 'code', code_finalization: 'code',
  source_unknown: 'client', client_unresolved: 'client', client_mixed: 'client',
  client_method: 'client', client_credentials: 'client', client_binding: 'client',
  client_configuration: 'client', redirect_binding: 'binding', resource_binding: 'binding', pkce_binding: 'binding',
  assertion_missing: 'assertion', assertion_type: 'assertion', assertion_malformed: 'assertion',
  assertion_header: 'assertion', assertion_alg: 'assertion', assertion_kid: 'assertion',
  assertion_iss: 'assertion', assertion_sub: 'assertion', assertion_aud: 'assertion',
  assertion_time: 'assertion', assertion_jti: 'assertion', assertion_verification: 'assertion',
  jwks_unavailable: 'assertion', key_selection: 'assertion', signature_invalid: 'assertion',
  replay_expired: 'replay', replay_duplicate: 'replay', replay_unavailable: 'replay',
  upstream_rejected: 'upstream', upstream_unavailable: 'upstream',
  user_sync_failed: 'issuance', issuance_failed: 'issuance',
  legacy_disabled: 'legacy', legacy_removed: 'legacy',
  success: 'complete', unexpected_error: 'internal',
});
const METHODS = new Set(['none', 'private_key_jwt', 'client_secret_basic', 'client_secret_post']);
const requests = new WeakMap();

function safeLog(event, fields) {
  try { console.log(event, JSON.stringify(fields)); } catch { /* Diagnostics cannot alter authentication. */ }
}

function markToken(req, reason) {
  const state = requests.get(req);
  if (state) state.reason = Object.hasOwn(REASONS, reason) ? reason : 'unexpected_error';
}

function tokenContext(req, grant, method) {
  const state = requests.get(req);
  if (!state) return;
  if (grant !== undefined) state.grant = ['authorization_code', 'refresh_token', 'agent'].includes(grant) ? grant : (grant ? 'unsupported' : 'missing');
  if (method !== undefined) state.client_method = METHODS.has(method) ? method : 'unknown';
}

function durationBucket(start) {
  const ms = Number(process.hrtime.bigint() - start) / 1e6;
  return ms < 100 ? 'lt_100ms' : ms < 1000 ? 'lt_1s' : ms < 10000 ? 'lt_10s' : 'gte_10s';
}

function tokenIngress(req, res, next) {
  if (req.method !== 'POST' || !/^\/gw\/oauth\/token\/?$/i.test((req.originalUrl || req.url || '').split('?')[0]) || requests.has(req)) return next();
  const type = typeof req.headers['content-type'] === 'string' ? req.headers['content-type'].split(';')[0].trim().toLowerCase() : '';
  const common = { request_id: randomUUID(), method: 'POST', path: '/gw/oauth/token',
    content_type: type === 'application/json' ? 'json' : type === 'application/x-www-form-urlencoded' ? 'form' : type ? 'other' : 'missing' };
  const state = { reason: 'ingress', grant: 'unknown', client_method: 'unknown' };
  requests.set(req, state);
  const started = process.hrtime.bigint();
  let completed = false;
  safeLog('[oauth][token][ingress]', common);
  const finish = (closed = false) => {
    if (completed) return;
    completed = true;
    const reason = state.reason === 'ingress' && res.statusCode === 429 ? 'rate_limited' : state.reason;
    safeLog('[oauth][token][outcome]', { ...common, stage: REASONS[reason], reason,
      grant: state.grant, client_method: state.client_method,
      status: closed ? 0 : res.statusCode, completion: closed ? 'closed' : 'finished', duration: durationBucket(started) });
  };
  res.once('finish', () => finish());
  res.once('close', () => finish(!res.writableFinished));
  return next();
}

function tokenParserError(req, error) {
  if (!requests.has(req)) return false;
  markToken(req, new Set(['entity.parse.failed', 'entity.too.large', 'encoding.unsupported',
    'charset.unsupported', 'request.aborted', 'request.size.invalid', 'parameters.too.many']).has(error?.type)
    ? 'body_rejected' : 'unexpected_error');
  return true;
}

module.exports = { REASONS, markToken, tokenContext, tokenIngress, tokenParserError };
