const http = require('http'); const https = require('https'); const { URL } = require('url');
function stripHopByHop(h) {
  const out = {...h};
  for (const k of ['connection','keep-alive','proxy-authenticate','proxy-authorization','te','trailers','transfer-encoding','upgrade','content-length']) {
    delete out[k.toLowerCase()];
    delete out[k];
  }
  return out;
}
function pipeProxy(targetBase, req, res, extraHeaders = {}, pathRewrite = (p)=>p) {
  const base = new URL(targetBase);
  const client = base.protocol === 'https:' ? https : http;
  const rewrittenPath = pathRewrite(req.originalUrl || req.url);
  const u = new URL(rewrittenPath, base);

  const headers = { ...stripHopByHop(req.headers), ...extraHeaders, host: base.host, connection: 'close' };
  const opts = {
    protocol: base.protocol,
    hostname: base.hostname,
    port: base.port || (base.protocol === 'https:' ? 443 : 80),
    method: req.method,
    path: u.pathname + u.search,
    headers
  };

  const upstream = client.request(opts, (r) => {
    const pass = stripHopByHop(r.headers);
    res.writeHead(r.statusCode || 502, pass);
    r.pipe(res);
  });

  upstream.on('error', (e) => {
    res.status(502).json({ error: 'bad_gateway', message: e.message });
  });

  if (req.readable) req.pipe(upstream); else upstream.end();
}
module.exports = { pipeProxy };
