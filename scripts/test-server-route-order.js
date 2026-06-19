#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');

const { createApp, startServer } = require('../server');

function stackFor(app) {
  const stack = app.router?.stack || app._router?.stack;
  assert.ok(Array.isArray(stack), 'expected Express app router stack');
  return stack;
}

function layerMatches(layer, path) {
  if (typeof layer.match !== 'function') return false;
  try {
    return Boolean(layer.match(path));
  } catch {
    return false;
  }
}

function handlerSource(layer) {
  return Function.prototype.toString.call(layer.handle);
}

function isRouteLayer(layer, method, path) {
  return Boolean(layer.route?.path === path && layer.route.methods?.[method.toLowerCase()]);
}

function routerHasRoute(layer, method, path) {
  return Array.isArray(layer.handle?.stack) && layer.handle.stack.some((child) => isRouteLayer(child, method, path));
}

function routeLayerMatchesPath(layer, method, path) {
  if (!layer.route?.methods?.[method.toLowerCase()]) return false;
  if (layer.route.path === path) return true;
  return layerMatches(layer, path);
}

function routeMatchesUnderMount(layer, method, targetPath) {
  if (!Array.isArray(layer.handle?.stack) || !layerMatches(layer, targetPath)) return [];

  const mountPath = layer.path || '';
  let childPath = targetPath.slice(mountPath.length);
  if (!childPath) childPath = '/';
  if (!childPath.startsWith('/')) childPath = `/${childPath}`;

  return layer.handle.stack
    .filter((child) => routeLayerMatchesPath(child, method, childPath))
    .map((child) => ({ layer: child, mountPath, routePath: child.route.path }));
}

function findRoutesForPath(stack, method, path) {
  const matches = [];
  for (const layer of stack) {
    if (routeLayerMatchesPath(layer, method, path)) {
      matches.push({ layer, mountPath: '', routePath: layer.route.path });
      continue;
    }
    matches.push(...routeMatchesUnderMount(layer, method, path));
  }
  return matches;
}

function describeRouteMatch(match) {
  const mountedPath = `${match.mountPath}${match.routePath === '/' ? '' : match.routePath}`;
  return mountedPath || match.routePath;
}

function routeLayerHasHandlerSource(layer, text) {
  return Array.isArray(layer.route?.stack) && layer.route.stack.some((child) => handlerSource(child).includes(text));
}

function findIndex(stack, label, predicate) {
  const index = stack.findIndex(predicate);
  assert.notEqual(index, -1, `expected ${label} to be mounted`);
  return index;
}

function assertBefore(stack, beforeIndex, afterIndex, message) {
  assert.ok(beforeIndex < afterIndex, `${message}: ${beforeIndex} should be before ${afterIndex}`);
}

async function main() {
  assert.equal(typeof createApp, 'function');
  assert.equal(typeof startServer, 'function');

  const app = createApp();
  const stack = stackFor(app);

  const securityHeadersIndex = findIndex(stack, 'security headers middleware', (layer) => layer.name === 'helmetMiddleware');
  const publicDiscoveryCorsIndex = findIndex(stack, 'public discovery CORS middleware', (layer) => layer.name === 'publicDiscoveryCorsMiddleware');
  const sensitiveOAuthCorsGuardIndex = findIndex(stack, 'sensitive OAuth CORS guard', (layer) => layer.name === 'sensitiveOAuthCorsGuardMiddleware');
  const sensitiveOAuthRateLimitIndex = findIndex(stack, 'sensitive OAuth rate limit', (layer) => layer.name === 'sensitiveOAuthRateLimitMiddleware');
  const oauthPageIndex = findIndex(stack, 'legacy OAuth page middleware', (layer, index) => (
    !layer.route &&
    !Array.isArray(layer.handle?.stack) &&
    layerMatches(layer, '/gw/oauth/authorize') &&
    !layerMatches(layer, '/gw/openapi.json') &&
    handlerSource(layer).includes('STAS Login')
  ));
  const cookieParserIndex = findIndex(stack, 'cookie parser', (layer) => layer.name === 'cookieParser');
  const jsonParserIndex = findIndex(stack, 'JSON body parser', (layer) => layer.name === 'jsonParser');
  const urlencodedParserIndex = findIndex(stack, 'URL-encoded body parser', (layer) => layer.name === 'urlencodedParser');

  assertBefore(stack, securityHeadersIndex, publicDiscoveryCorsIndex, 'security headers must run before public CORS');
  assertBefore(stack, publicDiscoveryCorsIndex, sensitiveOAuthCorsGuardIndex, 'public CORS must run before OAuth CORS guard');
  assertBefore(stack, sensitiveOAuthCorsGuardIndex, sensitiveOAuthRateLimitIndex, 'OAuth CORS guard must run before OAuth rate limit');
  assertBefore(stack, sensitiveOAuthRateLimitIndex, oauthPageIndex, 'OAuth rate limit must run before legacy OAuth page');
  assertBefore(stack, oauthPageIndex, cookieParserIndex, 'legacy OAuth page middleware must stay before cookie parser');
  assertBefore(stack, oauthPageIndex, jsonParserIndex, 'legacy OAuth page middleware must stay before JSON parser');
  assertBefore(stack, oauthPageIndex, urlencodedParserIndex, 'legacy OAuth page middleware must stay before URL-encoded parser');

  const healthIndex = findIndex(stack, 'health route', (layer) => isRouteLayer(layer, 'GET', '/gw/healthz'));
  const versionIndex = findIndex(stack, 'version route', (layer) => isRouteLayer(layer, 'GET', '/gw/version'));
  const wellKnownOauthIndex = findIndex(stack, 'OAuth authorization server discovery route', (layer) => (
    isRouteLayer(layer, 'GET', '/.well-known/oauth-authorization-server')
  ));
  const openapiIndex = findIndex(stack, 'OpenAPI router', (layer) => routerHasRoute(layer, 'GET', '/openapi.json'));
  const agentIndex = findIndex(stack, 'Agent Auth router', (layer) => routerHasRoute(layer, 'POST', '/agent/identity'));
  const bearerIndex = findIndex(stack, 'bearer auth middleware', (layer) => (
    !layer.route &&
    !Array.isArray(layer.handle?.stack) &&
    layerMatches(layer, '/gw/api/me') &&
    handlerSource(layer).includes('resolveRequestAuth(req)')
  ));
  const readOnlyGuardIndex = findIndex(stack, 'Agent Auth read-only guard', (layer) => layer.name === 'guardAgentReadOnly');

  assertBefore(stack, healthIndex, bearerIndex, 'health route must stay before bearer auth');
  assertBefore(stack, versionIndex, bearerIndex, 'version route must stay before bearer auth');
  assertBefore(stack, wellKnownOauthIndex, bearerIndex, 'OAuth discovery route must stay before bearer auth');
  assertBefore(stack, openapiIndex, bearerIndex, 'OpenAPI routes must stay before bearer auth');
  assertBefore(stack, agentIndex, bearerIndex, 'Agent/discovery routes must stay before bearer auth');
  assertBefore(stack, bearerIndex, readOnlyGuardIndex, 'bearer auth must stay before Agent Auth read-only guard');

  const trainingsIndex = findIndex(stack, 'trainings router', (layer) => routerHasRoute(layer, 'GET', '/trainings'));
  const oauthRouterIndex = findIndex(stack, 'OAuth router', (layer) => routerHasRoute(layer, 'POST', '/oauth/register'));
  const legacyAliasesIndex = findIndex(stack, 'legacy aliases router', (layer) => routerHasRoute(layer, 'GET', '/user_summary'));
  assert.ok(routerHasRoute(stack[oauthRouterIndex], 'GET', '/oauth/authorize'), 'expected OAuth authorize route to stay mounted');
  assert.ok(routerHasRoute(stack[oauthRouterIndex], 'GET', '/oauth/callback'), 'expected OAuth callback route to stay mounted');
  assert.ok(routerHasRoute(stack[oauthRouterIndex], 'POST', '/oauth/revoke'), 'expected OAuth revoke route to stay mounted');
  assert.ok(routerHasRoute(stack[oauthRouterIndex], 'POST', '/oauth/token'), 'expected OAuth token route to stay mounted');
  assert.ok(routerHasRoute(stack[legacyAliasesIndex], 'GET', '/trainings'), 'expected legacy trainings alias to stay mounted');
  assert.ok(routerHasRoute(stack[legacyAliasesIndex], 'GET', '/icu/plan'), 'expected legacy ICU plan alias to stay mounted');
  const icuPostRoutes = findRoutesForPath(stack, 'POST', '/gw/icu/events');
  assert.equal(
    icuPostRoutes.length,
    1,
    `expected exactly one POST-capable /gw/icu/events handler, found ${icuPostRoutes.map(describeRouteMatch).join(', ')}`,
  );
  assert.ok(
    routeLayerHasHandlerSource(icuPostRoutes[0].layer, 'body.events[] is required'),
    'lib/icu_post_exact must be the only POST /gw/icu/events handler',
  );
  const apiMeIndex = findIndex(stack, '/gw/api/me route', (layer) => isRouteLayer(layer, 'GET', '/gw/api/me'));
  const strategyIndex = findIndex(stack, '/gw/strategy route', (layer) => isRouteLayer(layer, 'POST', '/gw/strategy'));
  const uidInjectDbIndex = findIndex(stack, 'DB UID injector middleware', (layer) => (
    !layer.route &&
    !Array.isArray(layer.handle?.stack) &&
    layerMatches(layer, '/gw/api/db/activity_detail') &&
    handlerSource(layer).includes('[uid_inject_db][auth_failed]')
  ));
  const dbProxyIndex = findIndex(stack, 'DB proxy router', (layer) => (
    Array.isArray(layer.handle?.stack) &&
    layerMatches(layer, '/gw/api/db/activity_detail') &&
    layer.handle.stack.some((child) => handlerSource(child).includes('[db_proxy][REQ]'))
  ));
  const stasApiIndex = findIndex(stack, 'STAS API router', (layer) => routerHasRoute(layer, 'GET', '/db/user_summary'));

  for (const [label, index] of [
    ['trainings router', trainingsIndex],
    ['OAuth router', oauthRouterIndex],
    ['legacy aliases router', legacyAliasesIndex],
    ['/gw/api/me route', apiMeIndex],
    ['/gw/strategy route', strategyIndex],
    ['DB UID injector middleware', uidInjectDbIndex],
    ['DB proxy router', dbProxyIndex],
    ['STAS API router', stasApiIndex],
  ]) {
    assertBefore(stack, bearerIndex, index, `bearer auth must stay before ${label}`);
    assertBefore(stack, readOnlyGuardIndex, index, `Agent Auth read-only guard must stay before ${label}`);
  }

  assertBefore(stack, trainingsIndex, oauthRouterIndex, 'trainings router must keep its position before OAuth router');
  assertBefore(stack, oauthRouterIndex, legacyAliasesIndex, 'OAuth router must keep its position before legacy aliases');
  assertBefore(stack, legacyAliasesIndex, apiMeIndex, 'legacy aliases must keep their position before /gw/api/me');
  assertBefore(stack, uidInjectDbIndex, dbProxyIndex, 'DB UID injector must stay before DB proxy');

  const server = await new Promise((resolve) => {
    const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
  });

  const oldGatewayBaseUrl = process.env.GATEWAY_BASE_URL;
  process.env.GATEWAY_BASE_URL = 'https://intervals.stas.run';

  try {
    const address = server.address();
    const baseUrl = `http://${address.address}:${address.port}`;

    let response = await fetch(`${baseUrl}/gw/healthz`);
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(response.headers.get('x-frame-options'), 'SAMEORIGIN');

    response = await fetch(`${baseUrl}/.well-known/oauth-authorization-server`, {
      headers: { Origin: 'https://example.test' },
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('access-control-allow-origin'), '*');
    const metadata = await response.json();
    assert.equal(metadata.issuer, 'https://intervals.stas.run');
    assert.equal(metadata.authorization_endpoint, 'https://intervals.stas.run/gw/oauth/authorize');
    assert.equal(JSON.stringify(metadata).includes(address.address), false);

    response = await fetch(`${baseUrl}/gw/oauth/token`, {
      method: 'OPTIONS',
      headers: {
        Origin: 'https://example.test',
        'Access-Control-Request-Method': 'POST',
      },
    });
    assert.equal(response.status, 204);
    assert.equal(response.headers.get('access-control-allow-origin'), null);
  } finally {
    if (oldGatewayBaseUrl === undefined) delete process.env.GATEWAY_BASE_URL;
    else process.env.GATEWAY_BASE_URL = oldGatewayBaseUrl;
    server.close();
  }

  console.log('ok - server route order uses real app wiring');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
