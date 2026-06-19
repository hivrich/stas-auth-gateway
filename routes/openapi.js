const express = require('express');
const path = require('path');
const router = express.Router();

const CANONICAL_OPENAPI_PATH = 'openapi.actions.json';
const CANONICAL_OPENAPI_ROUTE = '/gw/openapi.json';

function schemaHeaders(type) {
  return {
    'Content-Type': type + '; charset=utf-8',
    'Cache-Control': 'public, max-age=60',
    'Access-Control-Allow-Origin': '*'
  };
}

function sendFile(res, p, type) {
  res.set(schemaHeaders(type));
  res.sendFile(path.join(__dirname, '..', p));
}

function sendCanonical(res) {
  sendFile(res, CANONICAL_OPENAPI_PATH, 'application/json');
}

function sendGone(req, res) {
  res.set({
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*'
  });
  res.status(410).json({
    error: 'openapi_variant_gone',
    message: 'This OpenAPI variant is no longer served as a live contract.',
    canonical: CANONICAL_OPENAPI_ROUTE,
    path: req.originalUrl || req.path
  });
}

router.get('/openapi.json', (req, res) => sendCanonical(res));
router.get('/openapi.actions.json', (req, res) => sendCanonical(res));

router.get('/openapi.yaml', (req, res) => sendGone(req, res));
router.get('/openapi.min.json', (req, res) => sendGone(req, res));
router.get('/openapi.min.yaml', (req, res) => sendGone(req, res));

module.exports = router;
