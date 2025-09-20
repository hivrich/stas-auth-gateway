'use strict';

const express = require('express');
const path = require('path');

const app = express();
app.use(/gw/icu, require(./routes/icu));
app.use(/gw/api, require(./routes/stas));

// Middleware
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// Static files (for OpenAPI schema and other assets)
app.use(express.static(path.join(__dirname, 'public')));

// Health check endpoint
app.get('/gw/healthz', (req, res) => {
  res.json({ ok: true, ts: new Date().toISOString() });
});

// Version endpoint
app.get('/gw/version', (req, res) => {
  res.json({
    version: '1.0.0',
    build_at: '2025-09-20',
    git_sha: 'fcc8ff8'
  });
});

// Catch-all handler for 404
app.use('*', (req, res) => {
  res.status(404).json({ error: 'not_found', path: req.originalUrl });
});

// Error handler
app.use((err, req, res, next) => {
  console.error('Server error:', err);
  res.status(500).json({ error: 'internal_error' });
});

const PORT = process.env.PORT || 3337;
app.listen(PORT, '127.0.0.1', () => {
  console.log(`🚀 STAS Auth Gateway listening on http://127.0.0.1:${PORT}`);
  console.log(`📊 Health check: http://127.0.0.1:${PORT}/gw/healthz`);
});

module.exports = app;
