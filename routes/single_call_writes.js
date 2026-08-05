'use strict';

const express = require('express');
const { getRequestUserId } = require('../lib/request-auth');
const { buildStasSourceHeaders } = require('../lib/request-source');

const router = express.Router();
const STAS_BASE = process.env.STAS_BASE || 'http://127.0.0.1:3336';
const STAS_KEY = process.env.STAS_KEY || '';
const UPSTREAM_TIMEOUT_MS = 45_000;

function isPlainObject(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

async function callStas(req, userId, path, options = {}) {
  const url = new URL(`/api/db/${String(path).replace(/^\/+/, '')}`, STAS_BASE);
  url.searchParams.set('user_id', String(userId));
  const method = String(options.method || 'GET').toUpperCase();
  const headers = buildStasSourceHeaders(req, {
    'X-API-Key': STAS_KEY,
    Accept: 'application/json',
  });
  const init = {
    method,
    headers,
    signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
  };

  if (options.body !== undefined) {
    headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(options.body);
  }

  const response = await fetch(url, init);
  const text = await response.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = null;
  }

  return {
    ok: response.ok,
    status: response.status,
    body,
    raw: body === null ? text : null,
  };
}

function sendUpstreamFailure(res, result, fallbackError) {
  if (isPlainObject(result.body)) return res.status(result.status).json(result.body);
  return res.status(result.status || 502).json({
    error: fallbackError,
    ...(result.raw ? { detail: String(result.raw).slice(0, 400) } : {}),
  });
}

function profileChangeId(preview) {
  const value = preview?.change?.id ?? preview?.changeId;
  return Number.isInteger(value) && value > 0 ? value : null;
}

function isValidProfileSection(value, expectedSection) {
  return isPlainObject(value)
    && value.section === expectedSection
    && typeof value.targetField === 'string'
    && typeof value.text === 'string'
    && typeof value.hash === 'string'
    && typeof value.enabled === 'boolean';
}

function isValidGoalCommit(value, expectedChangeId) {
  const state = value?.state;
  const hashPattern = /^[0-9a-f]{64}$/;
  return isPlainObject(value)
    && value.ok === true
    && value.changeId === expectedChangeId
    && typeof value.replay === 'boolean'
    && isPlainObject(state)
    && state.version === 2
    && hashPattern.test(state.dataVersion)
    && Array.isArray(state.items)
    && Number.isInteger(state.omittedCount)
    && state.omittedCount >= 0
    && (state.bestResultVersion === null || hashPattern.test(state.bestResultVersion))
    && Array.isArray(state.manualResults)
    && Array.isArray(state.legacyResults);
}

async function saveProfileSection(req, res) {
  const userId = getRequestUserId(req);
  if (!userId) return res.status(401).json({ status: 401, error: 'missing_or_invalid_token' });

  const body = req.body;
  if (!isPlainObject(body) || !['profile', 'rules'].includes(body.section)) {
    return res.status(400).json({ error: 'section must be profile or rules' });
  }
  if (!isPlainObject(body.structured)) {
    return res.status(400).json({ error: 'structured must be an object' });
  }
  if (body.diffSummary !== undefined && typeof body.diffSummary !== 'string') {
    return res.status(400).json({ error: 'diffSummary must be a string' });
  }

  try {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const current = await callStas(req, userId, 'profile_sections');
      if (!current.ok) return sendUpstreamFailure(res, current, 'profile_read_failed');

      const sections = Array.isArray(current.body?.sections) ? current.body.sections : [];
      const section = sections.find((item) => item?.section === body.section);
      if (!section || typeof section.hash !== 'string' || !section.hash) {
        return res.status(502).json({ error: 'profile_section_missing' });
      }

      const preview = await callStas(req, userId, 'profile_sections/preview', {
        method: 'POST',
        body: {
          section: body.section,
          structured: body.structured,
          previousHash: section.hash,
          ...(body.diffSummary?.trim() ? { diffSummary: body.diffSummary.trim() } : {}),
        },
      });

      if (preview.status === 409 && attempt === 0) continue;
      if (!preview.ok) return sendUpstreamFailure(res, preview, 'profile_preview_failed');
      if (preview.body?.noChange === true) {
        if (!isValidProfileSection(preview.body.section, body.section)) {
          return res.status(502).json({ error: 'profile_preview_invalid' });
        }
        return res.json({
          ok: true,
          saved: false,
          noChange: true,
          section: preview.body.section,
        });
      }

      const changeId = profileChangeId(preview.body);
      if (!changeId) return res.status(502).json({ error: 'profile_preview_invalid' });

      const commit = await callStas(req, userId, 'profile_sections/commit', {
        method: 'POST',
        body: { changeId },
      });
      if (!commit.ok) return sendUpstreamFailure(res, commit, 'profile_commit_failed');
      if (commit.body?.ok !== true
        || !isPlainObject(commit.body.change)
        || !isValidProfileSection(commit.body.section, body.section)) {
        return res.status(502).json({ error: 'profile_commit_invalid' });
      }

      return res.json({
        ...commit.body,
        ok: true,
        saved: true,
        noChange: false,
      });
    }

    return res.status(409).json({ error: 'profile_conflict' });
  } catch (error) {
    const timeout = error?.name === 'TimeoutError' || error?.name === 'AbortError';
    return res.status(timeout ? 504 : 502).json({
      error: timeout ? 'gateway_timeout' : 'bad_gateway',
      retryable: true,
    });
  }
}

async function applyGoalResultChange(req, res) {
  const userId = getRequestUserId(req);
  if (!userId) return res.status(401).json({ status: 401, error: 'missing_or_invalid_token' });
  if (!isPlainObject(req.body) || !isPlainObject(req.body.command)) {
    return res.status(400).json({ error: 'command must be an object' });
  }

  try {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const editable = await callStas(req, userId, 'goals/editable');
      if (!editable.ok) return sendUpstreamFailure(res, editable, 'goals_read_failed');

      const dataVersion = editable.body?.dataVersion;
      if (typeof dataVersion !== 'string' || !dataVersion) {
        return res.status(502).json({ error: 'goals_version_missing' });
      }

      const preview = await callStas(req, userId, 'goals/changes/preview', {
        method: 'POST',
        body: {
          expectedDataVersion: dataVersion,
          command: req.body.command,
        },
      });

      if (preview.status === 409 && attempt === 0) continue;
      if (!preview.ok) return sendUpstreamFailure(res, preview, 'goal_preview_failed');

      const changeId = preview.body?.preview?.changeId;
      if (!Number.isInteger(changeId) || changeId < 1) {
        return res.status(502).json({ error: 'goal_preview_invalid' });
      }

      const commit = await callStas(req, userId, 'goals/changes/commit', {
        method: 'POST',
        body: { changeId },
      });
      if (!commit.ok) return sendUpstreamFailure(res, commit, 'goal_commit_failed');
      if (!isValidGoalCommit(commit.body, changeId)) {
        return res.status(502).json({ error: 'goal_commit_invalid' });
      }

      return res.json(commit.body);
    }

    return res.status(409).json({ error: 'goals_conflict' });
  } catch (error) {
    const timeout = error?.name === 'TimeoutError' || error?.name === 'AbortError';
    return res.status(timeout ? 504 : 502).json({
      error: timeout ? 'gateway_timeout' : 'bad_gateway',
      retryable: true,
    });
  }
}

router.post('/api/db/profile_sections/save', saveProfileSection);
router.post('/api/db/goals/changes/apply', applyGoalResultChange);

module.exports = router;
module.exports.__testing = {
  UPSTREAM_TIMEOUT_MS,
  applyGoalResultChange,
  callStas,
  saveProfileSection,
};
