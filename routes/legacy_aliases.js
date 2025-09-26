'use strict';
const express = require('express');
const http = require('http');

const r = express.Router();

function fetchJSON(path, auth, timeoutMs = 5000){
  return new Promise((resolve) => {
    const req = http.request({
      hostname: '127.0.0.1',
      port: 3338,
      path,
      method: 'GET',
      headers: { 'Authorization': auth || '' },
      timeout: timeoutMs,
    }, (res) => {
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', c => buf += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode || 502, json: JSON.parse(buf) }); }
        catch { resolve({ status: res.statusCode || 502, json: null }); }
      });
    });
    req.on('timeout', () => { req.destroy(); resolve({ status: 504, json: null }); });
    req.on('error',   ()   => { resolve({ status: 502, json: null }); });
    req.end();
  });
}

// /gw/user_summary  ==> /gw/api/db/user_summary
// Нормализуем в объект с { ok:true, user_summary:[...] }
r.get('/user_summary', async (req, res) => {
  const qs = req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '';
  const { status, json } = await fetchJSON('/gw/api/db/user_summary' + qs, req.headers.authorization);

  // уже правильный объект с ok:true
  if (json && typeof json === 'object' && json.ok === true) {
    return res.json(json);
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
  const qs = req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '';
  const { status, json } = await fetchJSON('/gw/api/db/activities' + qs, req.headers.authorization);

  if (Array.isArray(json)) return res.json(json);
  if (json && Array.isArray(json.activities)) return res.json(json.activities);
  if (json && Array.isArray(json.trainings)) return res.json(json.trainings);

  // любой другой ответ/ошибка -> пустой массив, но 200
  return res.status(200).json([]);
});

// /gw/icu/plan — passthrough, но гарантируем массив/[]
r.get('/icu/plan', async (req, res) => {
  const qs = req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '';
  const { status, json } = await fetchJSON('/gw/icu/plan' + qs, req.headers.authorization, 6000);
  if (status === 200 && Array.isArray(json)) return res.json(json);
  if (status === 504 || status === 502 || json === null) return res.json([]);
  return res.status(status === 200 ? 200 : status).json(Array.isArray(json) ? json : []);
});

module.exports = r;
