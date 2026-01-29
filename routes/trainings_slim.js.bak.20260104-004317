const express = require('express');
const fetch = global.fetch || ((...a)=>import('node-fetch').then(m=>m.default(...a)));
const router = express.Router();

const STAS_BASE = process.env.STAS_INTERNAL_BASE_URL || 'http://127.0.0.1:3336';
const STAS_KEY  = process.env.STAS_API_KEY ;

// хелперы
const iso = (d)=> new Date(d).toISOString().slice(0,10);
const toDate = (v)=> {
  if (!v) return null;
  const d = new Date(v);
  return isNaN(+d) ? null : d;
};
function pickFields(row){
  // отдаем только пригодные для UI/коннектора поля
  return {
    id: row.id,
    date: row.date,
    workout_type: row.workout_type,
    distance: row.distance,
    training_load: row.training_load,
    intensity: row.intensity,
    user_report: row.user_report
  };
}

router.get('/db/trainings', async (req, res) => {
  // user_id должен быть подставлен мидлварью шлюза
  const uid = String((req.query && req.query.user_id) || '').trim();
  if (!uid) return res.status(400).json({ error: 'user_id (integer) is required' });

  // читаем фильтры
  const days = req.query.days ? Math.max(1, Math.min(365, parseInt(String(req.query.days), 10) || 7)) : null;
  const from = toDate(req.query.from);
  const to   = toDate(req.query.to);

  // дергаем STAS (он пока не фильтрует)
  const url = new URL('/api/db/trainings', STAS_BASE);
  url.searchParams.set('user_id', uid);
  if (days) url.searchParams.set('days', String(days)); // на будущее, когда починим мост
  if (from) url.searchParams.set('from', iso(from));
  if (to)   url.searchParams.set('to', iso(to));

  const stas = await fetch(url, { headers: { 'X-API-Key': STAS_KEY, 'Accept': 'application/json' }});
  const text = await stas.text();
  if (!stas.ok) {
    return res.status(stas.status).type(stas.headers.get('content-type') || 'application/json').send(text);
  }

  let data;
  try { data = JSON.parse(text); } catch(_e){ return res.status(502).json({ error:'bad_gateway', detail:'invalid JSON from STAS' }); }
  if (!data || !Array.isArray(data.items || data.trainings || data)) {
    // поддержим и плоский массив, и обертку { items: [...] }
    if (Array.isArray(data)) data = { items: data };
    else data = { items: [] };
  }

  const list = Array.isArray(data.items) ? data.items : (Array.isArray(data.trainings) ? data.trainings : []);

  // применяем фильтр дат на шлюзе
  let fromCut = from, toCut = to;
  if (!fromCut && days) {
    const d = new Date();
    d.setHours(0,0,0,0);
    d.setDate(d.getDate() - days + 1);
    fromCut = d;
  }
  // если задан только to — норм, если нет — берем сегодня
  if (!toCut) {
    const d = new Date();
    d.setHours(23,59,59,999);
    toCut = d;
  }

  const filtered = list.filter(r => {
    const rd = toDate(r.date);
    if (!rd) return false;
    return (!fromCut || rd >= fromCut) && (!toCut || rd <= toCut);
  });

  // сужаем поля
  const slim = filtered.map(pickFields);

  // можно добавить «safety» LIMIT (например, 200 элементов)
  const LIMIT = 200;
  const out = slim.slice(0, LIMIT);

  // финальный ответ
  res.set('X-Gateway-Filtered', 'true');
  res.set('X-Gateway-Items-Total', String(list.length));
  res.set('X-Gateway-Items-AfterFilter', String(out.length));
  return res.json(out);
});

module.exports = router;
