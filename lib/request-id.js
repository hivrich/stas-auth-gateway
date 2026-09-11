const { randomUUID } = require('node:crypto');

// STAS attaches x-stas-request-id to correlate gateway log records with the
// caller's own records. Only canonical UUIDs are accepted; anything absent,
// malformed or overlong is replaced with a gateway-generated UUID, so no
// arbitrary client-controlled value can reach logs, responses or upstreams.
const STAS_REQUEST_ID_HEADER = 'x-stas-request-id';
const STAS_REQUEST_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STAS_REQUEST_ID_MAX_LENGTH = 64;

function acceptedRequestId(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > STAS_REQUEST_ID_MAX_LENGTH) return null;
  return STAS_REQUEST_ID_RE.test(trimmed) ? trimmed : null;
}

function requestIdIngress(req, res, next) {
  req.stasRequestId = acceptedRequestId(req.headers[STAS_REQUEST_ID_HEADER]) || randomUUID();
  res.setHeader(STAS_REQUEST_ID_HEADER, req.stasRequestId);
  return next();
}

function getStasRequestId(req) {
  return req?.stasRequestId || null;
}

function stasRequestIdField(req) {
  return { stas_request_id: getStasRequestId(req) };
}

function stasRequestIdForwardHeaders(req) {
  const id = getStasRequestId(req);
  return id ? { [STAS_REQUEST_ID_HEADER]: id } : {};
}

module.exports = {
  STAS_REQUEST_ID_HEADER,
  getStasRequestId,
  requestIdIngress,
  stasRequestIdField,
  stasRequestIdForwardHeaders,
  __testing: { acceptedRequestId },
};
