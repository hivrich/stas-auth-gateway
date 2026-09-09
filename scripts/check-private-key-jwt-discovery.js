#!/usr/bin/env node
const { getIssuer, getMcpResource } = require('../lib/mcp-oauth-tokens');

function matchesSigningMetadata(metadata, issuer) {
  return metadata?.issuer === issuer
    && metadata.token_endpoint === `${issuer}/gw/oauth/token`
    && Array.isArray(metadata.token_endpoint_auth_methods_supported)
    && metadata.token_endpoint_auth_methods_supported.every((method) => typeof method === 'string')
    && metadata.token_endpoint_auth_methods_supported.includes('private_key_jwt')
    && Array.isArray(metadata.token_endpoint_auth_signing_alg_values_supported)
    && metadata.token_endpoint_auth_signing_alg_values_supported.length === 1
    && metadata.token_endpoint_auth_signing_alg_values_supported[0] === 'RS256';
}

async function fetchJson(url, fetcher) {
  const response = await fetcher(url, { redirect: 'error', signal: AbortSignal.timeout(5000), headers: { Accept: 'application/json', 'Cache-Control': 'no-cache' } });
  if (!response.ok || response.headers.get('content-type')?.split(';')[0].trim() !== 'application/json') throw new Error('metadata_unavailable');
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > 65536) throw new Error('metadata_too_large');
    chunks.push(Buffer.from(chunk));
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

async function checkDiscovery(options = {}) {
  const issuer = options.issuer || getIssuer();
  const resource = options.resource || getMcpResource();
  const appOrigin = new URL(resource).origin;
  if (new URL(issuer).protocol !== 'https:' || new URL(resource).protocol !== 'https:') return false;
  const urls = [
    `${issuer}/.well-known/oauth-authorization-server`,
    `${appOrigin}/.well-known/oauth-authorization-server`,
    `${appOrigin}/.well-known/oauth-protected-resource/api/mcp`,
  ];
  try {
    const docs = await Promise.all(urls.map((url) => fetchJson(url, options.fetcher || fetch)));
    return matchesSigningMetadata(docs[0], issuer) && matchesSigningMetadata(docs[1], issuer)
      && docs[2]?.resource === resource && Array.isArray(docs[2].authorization_servers)
      && docs[2].authorization_servers.every((server) => typeof server === 'string')
      && docs[2].authorization_servers.includes(issuer);
  } catch { return false; }
}

async function main() {
  const args = process.argv.slice(2);
  const waitSeconds = args.length === 2 && args[0] === '--wait-seconds' ? Number(args[1]) : 0;
  if ((args.length && !(args.length === 2 && args[0] === '--wait-seconds'))
    || !Number.isInteger(waitSeconds) || waitSeconds < 0 || waitSeconds > 360) {
    console.error('[oauth-discovery] invalid_arguments'); return 1;
  }
  const deadline = Date.now() + waitSeconds * 1000;
  do {
    if (await checkDiscovery()) { console.log('[oauth-discovery] gateway_app_and_resource_ready'); return 0; }
    if (Date.now() >= deadline) break;
    await new Promise((resolve) => setTimeout(resolve, Math.min(10000, deadline - Date.now())));
  } while (true);
  console.error('[oauth-discovery] capability_missing_or_unavailable');
  return 1;
}

if (require.main === module) main().then((code) => { process.exitCode = code; }).catch(() => { console.error('[oauth-discovery] invalid_configuration'); process.exitCode = 1; });
module.exports = { matchesSigningMetadata, checkDiscovery };
