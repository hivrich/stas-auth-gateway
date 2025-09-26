'use strict';
const ok = new Map();      // user_id -> count
const err = new Map();     // user_id -> count
function inc(map, uid){ map.set(uid, (map.get(uid)||0)+1); }
module.exports = {
  incOk:(uid)=>inc(ok, String(uid||'')),
  incErr:(uid)=>inc(err, String(uid||'')),
  snapshot:()=>({
    ok: Object.fromEntries(ok.entries()),
    err: Object.fromEntries(err.entries()),
    ts: new Date().toISOString()
  }),
  reset:()=>{ ok.clear(); err.clear(); }
};
