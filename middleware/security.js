'use strict';

const helmet = require('helmet');
const rateLimit = require('express-rate-limit');

const DEFAULT_OAUTH_RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000;
const DEFAULT_OAUTH_RATE_LIMIT_MAX = 120;

const PUBLIC_DISCOVERY_PATHS = new Set([
  '/.well-known/oauth-authorization-server',
  '/gw/openapi.json',
  '/gw/openapi.actions.json',
]);

const SENSITIVE_OAUTH_PATH_RE = /^\/gw\/oauth\/(?:authorize|callback|register|revoke|token)(?:[/?#]|$)/;

function positiveIntegerEnv(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

function pathnameFor(req) {
  try {
    return new URL(req.originalUrl || req.url || '/', 'http://gateway.local').pathname;
  } catch {
    return req.path || '/';
  }
}

function securityHeaders() {
  return helmet({
    contentSecurityPolicy: false,
    crossOriginEmbedderPolicy: false,
  });
}

function publicDiscoveryCors() {
  return function publicDiscoveryCorsMiddleware(req, res, next) {
    const pathname = pathnameFor(req);
    if (!PUBLIC_DISCOVERY_PATHS.has(pathname)) return next();

    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.setHeader('Vary', 'Origin');

    if (req.method === 'OPTIONS') return res.status(204).end();
    return next();
  };
}

function sensitiveOAuthCorsGuard() {
  return function sensitiveOAuthCorsGuardMiddleware(req, res, next) {
    if (!SENSITIVE_OAUTH_PATH_RE.test(pathnameFor(req))) return next();

    res.removeHeader('Access-Control-Allow-Origin');
    res.removeHeader('Access-Control-Allow-Credentials');
    res.removeHeader('Access-Control-Allow-Headers');
    res.removeHeader('Access-Control-Allow-Methods');

    if (req.method === 'OPTIONS') {
      res.setHeader('Allow', 'GET, POST');
      return res.status(204).end();
    }

    return next();
  };
}

function sensitiveOAuthRateLimit() {
  const limiter = rateLimit({
    windowMs: positiveIntegerEnv('OAUTH_RATE_LIMIT_WINDOW_MS', DEFAULT_OAUTH_RATE_LIMIT_WINDOW_MS),
    limit: positiveIntegerEnv('OAUTH_RATE_LIMIT_MAX', DEFAULT_OAUTH_RATE_LIMIT_MAX),
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    skip: (req) => !SENSITIVE_OAUTH_PATH_RE.test(pathnameFor(req)),
    handler: (_req, res) => res.status(429).json({ error: 'rate_limited' }),
  });

  return function sensitiveOAuthRateLimitMiddleware(req, res, next) {
    return limiter(req, res, next);
  };
}

module.exports = {
  publicDiscoveryCors,
  securityHeaders,
  sensitiveOAuthCorsGuard,
  sensitiveOAuthRateLimit,
};
