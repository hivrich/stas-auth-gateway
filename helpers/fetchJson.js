const http=require('http'); const https=require('https'); const {URL}=require('url');
function fetchJson(url,{headers={}}={}) {
  return new Promise((resolve,reject)=>{
    const u=new URL(url); const c=u.protocol==='https:'?https:http;
    const req=c.request({hostname:u.hostname,port:u.port|| (u.protocol==='https:'?443:80),
      path:u.pathname+u.search,method:'GET',headers},(res)=>{
        let data=''; res.setEncoding('utf8');
        res.on('data',(ch)=>data+=ch);
        res.on('end',()=>{ try{ resolve({status:res.statusCode,headers:res.headers,json:JSON.parse(data||'{}')}); }
                           catch(e){ reject(new Error(`bad_json status=${res.statusCode} body=${data}`)); }});
    });
    req.on('error',reject); req.end();
  });
}
module.exports={fetchJson};
