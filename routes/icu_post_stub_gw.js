module.exports = function (app) {
  console.log('[v2][load] icu_post_stub_gw');
  app.get('/gw/icu/ping', (req,res)=>{
    const uid=(res.locals&&res.locals.user_id)||null;
    res.json({ok:true,uid: uid && String(uid)});
  });
  app.post('/gw/icu/events', (req,res)=>{
    const a=req.get('authorization')||''; const has=/^bearer\s+/i.test(a);
    const uid=(req.query&&req.query.user_id)||(res.locals&&res.locals.user_id)||null;
    const dry=String(req.query.dry_run??'true')!=='false';
    const ev=Array.isArray(req.body&&req.body.events)?req.body.events:[]; const n=ev.length;
    console.log('[v2][stub][in]', req.method, req.originalUrl, 'hasAuth=',has,'uid=',uid,'count=',n);
    if(!has||!uid) return res.status(401).json({status:401,error:'missing_or_invalid_token'});
    console.log('[v2][stub][ok]', 'uid=',uid,'count=',n,'dry_run=',dry);
    res.json({ok:true,dry_run:dry,count:n});
  });
};
