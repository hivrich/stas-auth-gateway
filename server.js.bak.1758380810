const express = require('express');
const bodyParser = require('body-parser');

const PORT = process.env.PORT || 3337;

const app = express();
app.set('trust proxy', 1);
app.use(bodyParser.json({ limit: '256kb' }));
app.use(express.urlencoded({ extended: false }));

// health
app.get('/gw/healthz', (req, res) => {
  res.json({ ok: true, ts: new Date().toISOString() });
});

// oauth: authorize (заглушка странички — чтобы не падать)
app.get('/gw/oauth/authorize', (req, res) => {
  const client_id = req.query.client_id || 'unknown_client';
  res
    .status(200)
    .type('html')
    .send(`<!doctype html><html><body>
      <h3>Auth OK (stub)</h3>
      <p>client_id=${client_id}</p>
      <p>Для out-of-band верните этот код в клиент:</p>
      <pre>test_code_${Date.now()}</pre>
    </body></html>`);
});

// oauth: token — корректный JSON ответ (400 invalid_request если нет данных)
app.post('/gw/oauth/token', (req, res) => {
  const { grant_type } = req.body || {};
  if (!grant_type) {
    return res.status(400).json({
      error: 'invalid_request',
      error_description: 'grant_type required',
    });
  }
  // заглушка — чтобы НЕ 502 и не падать; реальную логику добавим позже
  return res.status(400).json({
    error: 'unsupported_grant_type',
    error_description: `grant_type=${grant_type} not supported in stub`,
  });
});

// версия
app.get('/gw/version', (_req, res) => {
  res.json({ version: 'stub-1', build_at: new Date().toISOString() });
});

// 404 JSON по умолчанию, чтобы не улетать 502
app.use((req, res) => {
  res.status(404).json({ error: 'not_found', path: req.path });
});

// soft error handler в JSON
app.use((err, _req, res, _next) => {
  console.error('[ERR]', err && err.stack || err);
  res.status(500).json({ error: 'internal_error' });
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
