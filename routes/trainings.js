const express = require('express');
const router  = express.Router();

async function readDbBridgeApiKey() {
  const fs = require('fs');
  if (process.env.DB_BRIDGE_API_KEY) return process.env.DB_BRIDGE_API_KEY;
  try {
    const raw = fs.readFileSync('/opt/stas-db-bridge/.env', 'utf8');
    const line = (raw.split(/\r?\n/).find(x => /^API_KEY=/.test(x)) || '').split('=',2)[1] || '';
    return String(line).trim();
  } catch { return ''; }
}

function uidFromReq(req) {
  return req.user_id || (req.bearer && req.bearer.uid) || req.query.user_id || null;
}

/**
 * GET /gw/trainings
 * - default: компактный список как было ранее (массива объектов из /gw/api/db/trainings)
 * - full=1: детальный список из DB-Bridge /api/db/activities_full (если недоступно — мягкий фоллбек)
 */
router.get('/trainings', async (req, res) => {
  try {
    const { URLSearchParams } = require('node:url');
    const uid = uidFromReq(req);
    if (!uid) return res.json([]);

    const qs = new URLSearchParams();
    qs.set('user_id', String(uid));
    for (const k of ['days','oldest','newest','limit','offset']) {
      if (req.query[k] != null && req.query[k] !== '') qs.set(k, String(req.query[k]));
    }

    // full=1 → сначала пытаемся детальные активности
    const wantFull = String(req.query.full || '') === '1' || String(req.query.full || '').toLowerCase() === 'true';
    if (wantFull) {
      try {
        const apiKey = await readDbBridgeApiKey();
        if (apiKey) {
          const url2 = `http://127.0.0.1:3336/api/db/activities_full?${qs.toString()}`;
          const r2 = await fetch(url2, { headers: { 'X-API-Key': apiKey, 'Accept': 'application/json' } });
          if (r2.ok) {
            const j2 = await r2.json();
            const arr = Array.isArray(j2.activities) ? j2.activities
                      : Array.isArray(j2.trainings)  ? j2.trainings : [];
            // возвращаем как массив объектов (без изменения формы), но уже с полным набором полей
            return res.json(arr);
          }
        }
      } catch (e) {
        // мягкий фоллбек ниже
      }
    }

    // обычный путь: через локальный GW-прокси к /gw/api/db/trainings
    const url1 = `http://127.0.0.1:3338/gw/api/db/trainings?${qs.toString()}`;
    const r1 = await fetch(url1, { headers: { 'Authorization': req.headers['authorization'] || '' } });
    if (!r1.ok) return res.json([]);
    const j1 = await r1.json();
    return res.json(Array.isArray(j1.trainings) ? j1.trainings : []);

  } catch (e) {
    return res.json([]);
  }
});

module.exports = router;
