module.exports = function (app) {
  console.log('[v2][load] debug_gw');
  app.get('/gw/debug/echo_auth', (req,res)=>{
    const a=req.get('authorization')||''; const ok=/^bearer\s+/i.test(a);
    res.json({ok:true,has_auth:ok,authorization: ok ? (a.split(' ')[0]+' …'+a.slice(-6)) : null});
  });
  app.get('/gw/debug/echo_uid', (req,res)=>{
    const uid=(req.query&&req.query.user_id)||(res.locals&&res.locals.user_id)||null;
    res.json({ok:true,has_user_id:!!uid,user_id: uid && String(uid)});
  });
};
