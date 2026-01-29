const express = require('express');
const router = express.Router();

/**
 * /gw/trainings  → возвращает МАССИВ тренировок для текущего пользователя.
 * Источник: уже работающий GW-прокси /gw/api/db/trainings (object с trainings[]).
 * Авторизация: использует тот же Authorization: Bearer ... (gateway сам извлекает user_id).
 */
router.get('/trainings', async (req, res) => {
  try {
    const { URLSearchParams } = require('node:url');
    const uid = req.user_id || (req.bearer && req.bearer.uid) || req.query.user_id;
    if (!uid) return res.json([]); // bearerUid даёт 401 на /gw/* без токена, это только подстраховка

    const qs = new URLSearchParams();
    qs.set('user_id', String(uid));
    for (const k of ['days','oldest','newest','limit','offset']) {
      if (req.query[k] != null && req.query[k] !== '') qs.set(k, String(req.query[k]));
    }

    const url = 'http://127.0.0.1:3338/gw/api/db/trainings?' + qs.toString();
    const r = await fetch(url, { headers: { 'Authorization': req.headers['authorization'] || '' } });
    if (!r.ok) return res.json([]);
    const j = await r.json();
    return res.json(Array.isArray(j.trainings) ? j.trainings : []);
  } catch (e) {
    return res.json([]); // строго массив
  }
});

module.exports = router;
