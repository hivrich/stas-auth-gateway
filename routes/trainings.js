const express = require('express');
const router  = express.Router();
const getStasKey = require('../lib/get_stas_key');
const { getRequestUserId } = require('../lib/request-auth');
const { buildStasSourceHeaders } = require('../lib/request-source');

const STAS_BASE = process.env.STAS_BASE || 'http://127.0.0.1:3336';
const TRAININGS_TIMEOUT_MS = 7000;

function isTransientUpstreamStatus(status) {
  return status === 408 || status === 409 || status === 425 || status === 429 || status >= 500;
}

function isTimeoutError(error) {
  const name = String(error?.name || '');
  const code = String(error?.code || '');
  const message = String(error?.message || error || '');
  return (
    name === 'AbortError' ||
    name === 'TimeoutError' ||
    code === 'ABORT_ERR' ||
    /\b(abort|aborted|timeout|timed out)\b/i.test(message)
  );
}

function sendTrainingsError(res, status, error, options = {}) {
  const body = { status, error };
  if (options.retryable !== undefined) body.retryable = Boolean(options.retryable);
  if (options.upstreamStatus !== undefined) body.upstream_status = options.upstreamStatus;
  return res.status(status).json(body);
}

/**
 * GET /gw/trainings
 * Backward-compatible training list route for Actions and MCP.
 */
router.get('/trainings', async (req, res) => {
  try {
    const { URLSearchParams } = require('node:url');
    const uid = getRequestUserId(req);
    if (!uid) return res.status(401).json({ status: 401, error: 'missing_or_invalid_token' });

    const qs = new URLSearchParams();
    qs.set('user_id', String(uid));
    for (const k of ['days','oldest','newest','limit','offset','full']) {
      if (req.query[k] != null && req.query[k] !== '') qs.set(k, String(req.query[k]));
    }

    const url = new URL(`/api/db/trainings?${qs.toString()}`, STAS_BASE);
    const stasKey = getStasKey();
    const response = await fetch(url, {
      headers: buildStasSourceHeaders(req, {
        'X-API-Key': stasKey,
        Accept: 'application/json',
      }),
      signal: AbortSignal.timeout(TRAININGS_TIMEOUT_MS),
    });
    const upstreamStatus = Number(response.status) || 502;
    const upstreamOk = typeof response.ok === 'boolean'
      ? response.ok
      : upstreamStatus >= 200 && upstreamStatus < 300;
    if (!upstreamOk) {
      const isAuthFailure = upstreamStatus === 401 || upstreamStatus === 403;
      return sendTrainingsError(res, 502, isAuthFailure ? 'auth_error' : 'upstream_error', {
        upstreamStatus,
        retryable: !isAuthFailure && isTransientUpstreamStatus(upstreamStatus),
      });
    }

    const json = await response.json().catch(() => null);
    if (Array.isArray(json)) return res.json(json);
    if (json && Array.isArray(json.trainings)) return res.json(json.trainings);
    if (json && Array.isArray(json.activities)) return res.json(json.activities);
    return sendTrainingsError(res, 502, 'invalid_upstream_response', { retryable: true });

  } catch (e) {
    if (isTimeoutError(e)) {
      return sendTrainingsError(res, 504, 'upstream_timeout', { retryable: true });
    }
    return sendTrainingsError(res, 502, 'upstream_error', { retryable: true });
  }
});

module.exports = router;
