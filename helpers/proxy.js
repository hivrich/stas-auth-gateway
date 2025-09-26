'use strict';
const { Readable } = require('stream');

function copyResponseHeaders(res, r) {
  const pass = ['content-type','content-length','content-encoding','cache-control','etag','last-modified','date','vary'];
  for (const [k, v] of r.headers) if (pass.includes(k.toLowerCase())) res.setHeader(k, v);
}

async function sendProxied(res, r, { method='GET' } = {}) {
  res.status(r.status); copyResponseHeaders(res, r);
  const nodeStream = (typeof Readable.fromWeb==='function' && r.body && typeof r.body.getReader==='function') ? Readable.fromWeb(r.body) : r.body;
  nodeStream.on('error', ()=>{ try { res.end(); } catch(_){} });
  nodeStream.pipe(res);
}

function withTimeout(ms=15000) { const ac=new AbortController(); const to=setTimeout(()=>ac.abort('proxy_timeout'),ms); return { signal:ac.signal, clear:()=>clearTimeout(to) }; }

module.exports = { sendProxied, withTimeout };
