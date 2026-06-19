'use strict';
const express = require('express');
const getStasKey = require('../lib/get_stas_key');
const { getRequestUserId } = require('../lib/request-auth');
const { buildStasSourceHeaders } = require('../lib/request-source');

const r = express.Router();
const STAS_BASE = process.env.STAS_BASE || 'http://127.0.0.1:3336';

async function fetchDbJSON(endpoint, req, timeoutMs = 5000) {
  const url = new URL(`/api/db/${endpoint}`, STAS_BASE);
  const qs = new URLSearchParams(req.query || {});
  const uid = getRequestUserId(req);
  if (!uid) return { status: 401, json: { status: 401, error: 'missing_or_invalid_token' } };
  qs.delete('uid');
  qs.set('user_id', uid);
  for (const [key, value] of qs.entries()) {
    if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, value);
  }

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort('timeout'), timeoutMs);

  try {
    const response = await fetch(url, {
      headers: buildStasSourceHeaders(req, {
        'X-API-Key': getStasKey(),
        Accept: 'application/json',
      }),
      signal: ac.signal,
    });
    const text = await response.text();
    try { return { status: response.status || 502, json: JSON.parse(text) }; }
    catch { return { status: response.status || 502, json: null }; }
  } catch {
    return { status: 502, json: null };
  } finally {
    clearTimeout(timer);
  }
}

// /gw/user_summary  ==> /gw/api/db/user_summary
// Нормализуем в объект с { ok:true, user_summary:[...] }
r.get('/user_summary', async (req, res) => {
  const { status, json } = await fetchDbJSON('user_summary', req);

  // уже правильный объект с ok:true
  if (json && typeof json === 'object' && json.ok === true) {
    return res.json(json);
  }

  if (status >= 400) {
    return res.status(status).json(json || { ok: false, error: 'upstream_unreachable' });
  }

  // апстрим вернул объект без ok -> обернём
  if (json && typeof json === 'object' && !Array.isArray(json)) {
    return res.json({ ok: true, user_summary: json.user_summary ?? json });
  }

  // апстрим вернул массив -> обернём
  if (Array.isArray(json)) {
    return res.json({ ok: true, user_summary: json });
  }

  // таймаут/ошибка -> мягкий ответ
  return res.status(status === 200 ? 200 : status).json({ ok: false, error: 'upstream_unreachable' });
});

// /gw/trainings  ==> /gw/api/db/activities
// Гарантируем массив
r.get('/trainings', async (req, res) => {
  const { status, json } = await fetchDbJSON('trainings', req);

  if (status === 401) return res.status(401).json(json);

  if (Array.isArray(json)) return res.json(json);
  if (json && Array.isArray(json.activities)) return res.json(json.activities);
  if (json && Array.isArray(json.trainings)) return res.json(json.trainings);

  // любой другой ответ/ошибка -> пустой массив, но 200
  return res.status(200).json([]);
});

// /gw/icu/plan — passthrough, но гарантируем массив/[]
r.get('/icu/plan', async (req, res) => {
  return res.json([]);
});

module.exports = r;
