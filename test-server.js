const http = require('http');

const server = http.createServer((req, res) => {
  console.log('Request:', req.method, req.url);
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ ok: true, url: req.url }));
});

server.listen(3338, '127.0.0.1', () => {
  console.log('Test server listening on 127.0.0.1:3338');
});
