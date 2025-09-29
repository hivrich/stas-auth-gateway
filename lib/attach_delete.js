function parseBearerUid(req){
  const h=req.get('authorization')||''; const m=h.match(/^\s*Bearer\s+t_([A-Za-z0-9\-_]+)\s*$/i);
  if(!m) throw Object.assign(new Error('missing_or_invalid_token'),{status:401});
  const b64=m[1].replace(/-/g,'+').replace(/_/g,'/'); const pad=b64.length%4? '='.repeat(4-(b64.length%4)) : '';
  let obj; try{ obj=JSON.parse(Buffer.from(b64+pad,'base64').toString('utf8')); }catch{ throw Object.assign(new Error('invalid_token_payload'),{status:401}); }
  const uid=obj && String(obj.uid||'').trim(); if(!uid||!/^[0-9]+$/.test(uid)) throw Object.assign(new Error('missing_user_id'),{status:401}); return uid;
}
module.exports = function attachDelete(app){
  const { getIcuCredsForUid, gwListByPrefix, icuDeleteEventById } = require('./icu_delete');

  app.delete('/gw/icu/events', async (req,res)=>{
    try{
      const uid = parseBearerUid(req);
      const dry = String(req.query.dry_run ?? 'true').toLowerCase()==='true';

      // допустимые параметры окна и фильтров
      const q = {}; ['days','oldest','newest','type','external_id','external_id_prefix','category'].forEach(k=>{
        if(req.query[k]!=null) q[k]=String(req.query[k]);
      });
      if(!q.external_id && !q.external_id_prefix) {
        return res.status(400).json({ error:'bad_request', message:'external_id or external_id_prefix required' });
      }

      // читаем список через шлюз и ФИЛЬТРУЕМ на стороне сервера
      const list = await gwListByPrefix({ authHeader: req.get('authorization')||'', q });
      const arr  = Array.isArray(list) ? list : [];

      const prefix  = q.external_id_prefix || '';
      const wantExact = q.external_id;
      const wantType  = q.type ? String(q.type) : '';
      const wantCat   = (q.category||'').toUpperCase();

      const targets = arr.filter(e=>{
        const ext = (e.external_id || '');
        const typeOk = !wantType || String(e.type) === wantType;
        const catOk  = !wantCat || String(e.category||'').toUpperCase() === wantCat;
        const idOk   = wantExact ? (ext === wantExact) : (prefix ? ext.startsWith(prefix) : false);
        return idOk && typeOk && catOk;
      });

      const ids = targets.map(e=>e.id).filter(Boolean);

      if (dry) {
        return res.json({
          ok:true, dry_run:true, count: ids.length,
          oldest: q.oldest||null, newest: q.newest||null,
          sample: targets.slice(0,5).map(e=>({id:e.id, external_id:e.external_id, start:e.start_date_local, type:e.type}))
        });
      }

      // реальные креды ICU и удаление по id
      const { apiKey, athlete_id } = await getIcuCredsForUid(uid);
      let ok=0, fail=[];
      for(const id of ids){
        try { await icuDeleteEventById({ apiKey, athlete_id, id }); ok++; }
        catch(e){ fail.push({id,status:e.status||0,error:e.message}); }
      }

      // ПОСТ-ВЕРИФИКАЦИЯ: повторное чтение того же окна и те же фильтры
      const after = await gwListByPrefix({ authHeader: req.get('authorization')||'', q });
      const left  = (Array.isArray(after)? after : []).filter(e=>{
        const ext = (e.external_id || '');
        const typeOk = !wantType || String(e.type) === wantType;
        const catOk  = !wantCat || String(e.category||'').toUpperCase() === wantCat;
        const idOk   = wantExact ? (ext === wantExact) : (prefix ? ext.startsWith(prefix) : false);
        return idOk && typeOk && catOk;
      });

      if (left.length>0) {
        return res.status(409).json({
          ok:false, error:'not_empty_after_delete',
          deleted: ok, failed: fail.length,
          remaining: left.length,
          remaining_sample: left.slice(0,5).map(e=>({id:e.id, external_id:e.external_id, start:e.start_date_local}))
        });
      }

      return res.json({ ok:true, deleted: ok, failed: fail.length });
    }catch(e){
      const code=e.status||500;
      return res.status(code).json({ error:e.message||'internal_error' });
    }
  });

  console.log('[icu][DELETE] exact /gw/icu/events attached BEFORE proxy (filtered + verify)');
};
