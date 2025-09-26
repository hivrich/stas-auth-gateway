'use strict';
const m = require('../metrics');
module.exports = app => {
  app.get('/gw/debug/stats', (_req, res)=> res.json({ ok:true, ...m.snapshot() }));
  app.post('/gw/debug/stats/reset', (_req, res)=> { m.reset(); res.json({ ok:true, reset:true }); });
};
