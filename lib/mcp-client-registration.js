const crypto = require('node:crypto');
const dns = require('node:dns').promises;
const https = require('node:https');
const net = require('node:net');
const nodeFetch = require('node-fetch');

const MAX_REDIRECT_URIS = 3;
const MAX_REDIRECT_URI_LENGTH = 512;
const MAX_CLIENT_NAME_LENGTH = 80;
const MAX_CIMD_BYTES = 64 * 1024;
const CIMD_TIMEOUT_MS = 5000;
const CIMD_CACHE_TTL_MS = 5 * 60 * 1000;
const cimdCache = new Map();
let cimdOptionsOverride = null;

function trimToString(value) {
  if (value === null || value === undefined) return '';
  return String(value).trim();
}

function isLoopbackHostname(hostname) {
  const normalized = trimToString(hostname).toLowerCase().replace(/^\[|\]$/g, '');
  return normalized === '127.0.0.1'
    || normalized.startsWith('127.')
    || normalized === '::1';
}

function isPublicHostname(hostname) {
  const normalized = trimToString(hostname).toLowerCase().replace(/^\[|\]$/g, '');
  return Boolean(
    normalized
    && normalized.includes('.')
    && !normalized.endsWith('.')
    && normalized !== 'localhost'
    && !normalized.endsWith('.localhost')
    && !normalized.endsWith('.local')
    && !normalized.endsWith('.internal')
    && net.isIP(normalized) === 0
  );
}

function parseRedirectUri(value) {
  const raw = trimToString(value);
  if (!raw || raw.length > MAX_REDIRECT_URI_LENGTH) return null;

  try {
    const url = new URL(raw);
    if (url.username || url.password || url.hash) return null;
    if (url.protocol === 'https:' && isPublicHostname(url.hostname)) {
      return { raw, url, kind: 'web' };
    }
    if (url.protocol === 'http:' && isLoopbackHostname(url.hostname)) {
      return { raw, url, kind: 'native' };
    }
    return null;
  } catch {
    return null;
  }
}

function redirectUriMatches(registeredUri, requestedUri, applicationType) {
  const registered = parseRedirectUri(registeredUri);
  const requested = parseRedirectUri(requestedUri);
  if (!registered || !requested) return false;
  if (applicationType !== 'native' || registered.kind !== 'native' || requested.kind !== 'native') {
    return registered.raw === requested.raw;
  }

  return registered.url.protocol === requested.url.protocol
    && registered.url.hostname.toLowerCase() === requested.url.hostname.toLowerCase()
    && registered.url.pathname === requested.url.pathname
    && registered.url.search === requested.url.search;
}

function normalizeClientName(value, redirectUris) {
  const raw = trimToString(value).replace(/[\u0000-\u001f\u007f]/g, ' ');
  if (raw && raw.length <= MAX_CLIENT_NAME_LENGTH) return raw;
  try {
    return `MCP client (${new URL(redirectUris[0]).hostname})`;
  } catch {
    return 'MCP client';
  }
}

function invalid(reason, error = 'invalid_client_metadata') {
  return { ok: false, error, reason };
}

function readClientMetadata(body, options = {}) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return invalid('body_not_object');

  const redirectUris = Array.isArray(body.redirect_uris)
    ? body.redirect_uris.map(trimToString).filter(Boolean)
    : [];
  const uniqueRedirectUris = [...new Set(redirectUris)];
  if (uniqueRedirectUris.length === 0) return invalid('redirect_uris_missing', 'invalid_redirect_uri');
  if (uniqueRedirectUris.length !== redirectUris.length) return invalid('redirect_uris_duplicate', 'invalid_redirect_uri');
  if (uniqueRedirectUris.length > MAX_REDIRECT_URIS) return invalid('redirect_uris_too_many', 'invalid_redirect_uri');

  const parsedRedirects = uniqueRedirectUris.map(parseRedirectUri);
  if (parsedRedirects.some((entry) => !entry)) return invalid('redirect_uri_not_allowed', 'invalid_redirect_uri');

  const inferredType = parsedRedirects.every((entry) => entry.kind === 'native') ? 'native' : 'web';
  const applicationType = trimToString(body.application_type) || inferredType;
  if (!['web', 'native'].includes(applicationType)) return invalid('application_type_unsupported');
  // RFC 8252 section 7.2 allows native apps to use claimed HTTPS redirects.
  // Web clients still may not use native loopback redirects.
  if (applicationType === 'web' && parsedRedirects.some((entry) => entry.kind !== 'web')) {
    return invalid('redirect_uri_application_type_mismatch', 'invalid_redirect_uri');
  }

  const grantTypes = body.grant_types === undefined ? ['authorization_code'] : body.grant_types;
  if (!Array.isArray(grantTypes) || grantTypes.some((value) => typeof value !== 'string')) {
    return invalid('grant_types_invalid');
  }
  const uniqueGrantTypes = [...new Set(grantTypes)];
  if (uniqueGrantTypes.length !== grantTypes.length) return invalid('grant_types_duplicate');
  if (!uniqueGrantTypes.includes('authorization_code')) return invalid('authorization_code_required');
  if (uniqueGrantTypes.some((grant) => !['authorization_code', 'refresh_token'].includes(grant))) {
    return invalid('grant_type_unsupported');
  }

  const responseTypes = body.response_types === undefined ? ['code'] : body.response_types;
  if (!Array.isArray(responseTypes) || responseTypes.length !== 1 || responseTypes[0] !== 'code') {
    return invalid('response_types_unsupported');
  }

  const tokenEndpointAuthMethod = trimToString(body.token_endpoint_auth_method) || 'none';
  if (tokenEndpointAuthMethod !== 'none') return invalid('token_endpoint_auth_method_unsupported');

  const requestedClientName = trimToString(body.client_name);
  if (requestedClientName.length > MAX_CLIENT_NAME_LENGTH) return invalid('client_name_too_long');

  const clientId = trimToString(body.client_id);
  if (options.expectedClientId && clientId !== options.expectedClientId) {
    return invalid('client_id_self_reference_mismatch', 'invalid_client');
  }

  return {
    ok: true,
    metadata: {
      clientId: options.expectedClientId || clientId || null,
      redirectUris: uniqueRedirectUris,
      clientName: normalizeClientName(requestedClientName, uniqueRedirectUris),
      grantTypes: uniqueGrantTypes,
      responseTypes: ['code'],
      tokenEndpointAuthMethod: 'none',
      applicationType,
    },
  };
}

function isPrivateIpv4(address) {
  const parts = address.split('.').map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return true;
  const [a, b] = parts;
  return a === 0 || a === 10 || a === 127 || a >= 224
    || (a === 100 && b >= 64 && b <= 127)
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && (b === 0 || b === 168))
    || (a === 198 && (b === 18 || b === 19))
    || (a === 198 && b === 51)
    || (a === 203 && b === 0);
}

function parseIpv6Bytes(address) {
  let normalized = trimToString(address).toLowerCase().split('%')[0];
  if (net.isIP(normalized) !== 6) return null;

  const dottedMatch = normalized.match(/(?:^|:)(\d+\.\d+\.\d+\.\d+)$/);
  if (dottedMatch) {
    const parts = dottedMatch[1].split('.').map(Number);
    if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return null;
    normalized = normalized.slice(0, -dottedMatch[1].length)
      + `${((parts[0] << 8) | parts[1]).toString(16)}:${((parts[2] << 8) | parts[3]).toString(16)}`;
  }

  const halves = normalized.split('::');
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves[1] ? halves[1].split(':') : [];
  const missing = 8 - left.length - right.length;
  if ((halves.length === 1 && missing !== 0) || missing < 0) return null;
  const words = halves.length === 2
    ? [...left, ...Array(missing).fill('0'), ...right]
    : left;
  if (words.length !== 8 || words.some((word) => !/^[0-9a-f]{1,4}$/.test(word))) return null;
  return words.flatMap((word) => {
    const value = Number.parseInt(word, 16);
    return [value >> 8, value & 0xff];
  });
}

function embeddedIpv4IsPrivate(bytes, offset) {
  return isPrivateIpv4(bytes.slice(offset, offset + 4).join('.'));
}

function isPrivateAddress(address) {
  const normalized = trimToString(address).toLowerCase().replace(/^\[|\]$/g, '');
  if (net.isIP(normalized) === 4) return isPrivateIpv4(normalized);
  if (net.isIP(normalized) !== 6) return true;
  const bytes = parseIpv6Bytes(normalized);
  if (!bytes) return true;
  const allZeroPrefix96 = bytes.slice(0, 12).every((value) => value === 0);
  const mappedPrefix96 = bytes.slice(0, 10).every((value) => value === 0) && bytes[10] === 0xff && bytes[11] === 0xff;

  if (bytes.every((value) => value === 0) || (allZeroPrefix96 && bytes[15] === 1)) return true;
  if ((bytes[0] & 0xfe) === 0xfc || (bytes[0] === 0xfe && (bytes[1] & 0xc0) === 0x80) || bytes[0] === 0xff) return true;
  if (bytes[0] === 0x20 && bytes[1] === 0x01 && bytes[2] === 0x0d && bytes[3] === 0xb8) return true;
  if (bytes[0] === 0x20 && bytes[1] === 0x01 && bytes[2] === 0x00 && (bytes[3] === 0x02 || (bytes[3] & 0xf0) === 0x10)) return true;
  if (bytes[0] === 0x01 && bytes[1] === 0x00 && bytes.slice(2, 8).every((value) => value === 0)) return true;

  // Block legacy/translated IPv6 forms that can tunnel an otherwise private IPv4 target.
  if (allZeroPrefix96 || mappedPrefix96) return embeddedIpv4IsPrivate(bytes, 12) || allZeroPrefix96 || mappedPrefix96;
  if (bytes[0] === 0x20 && bytes[1] === 0x02) return embeddedIpv4IsPrivate(bytes, 2); // 6to4
  if (bytes[0] === 0x20 && bytes[1] === 0x01 && bytes[2] === 0x00 && bytes[3] === 0x00) return true; // Teredo
  if (bytes[0] === 0x00 && bytes[1] === 0x64 && bytes[2] === 0xff && bytes[3] === 0x9b) {
    if (bytes[4] === 0x00 && bytes[5] === 0x01) return true; // local-use NAT64 prefix
    if (bytes.slice(4, 12).every((value) => value === 0)) return embeddedIpv4IsPrivate(bytes, 12);
  }
  return false;
}

function parseCimdClientId(value) {
  const raw = trimToString(value);
  try {
    const url = new URL(raw);
    if (
      url.protocol !== 'https:'
      || !isPublicHostname(url.hostname)
      || url.username
      || url.password
      || url.hash
      || url.pathname === '/'
    ) return null;
    return url;
  } catch {
    return null;
  }
}

async function readLimitedBody(response) {
  const declaredLength = Number(response.headers?.get?.('content-length') || 0);
  if (declaredLength > MAX_CIMD_BYTES) throw new Error('cimd_body_too_large');
  const body = response.body;
  const chunks = [];
  let total = 0;

  const append = (chunk) => {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > MAX_CIMD_BYTES) throw new Error('cimd_body_too_large');
    chunks.push(buffer);
  };

  if (body && typeof body[Symbol.asyncIterator] === 'function') {
    try {
      for await (const chunk of body) append(chunk);
    } catch (error) {
      if (error?.message === 'cimd_body_too_large' && typeof body.destroy === 'function') body.destroy();
      throw error;
    }
    return Buffer.concat(chunks, total).toString('utf8');
  }

  if (body && typeof body.getReader === 'function') {
    const reader = body.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        append(value);
      }
    } catch (error) {
      if (error?.message === 'cimd_body_too_large') await reader.cancel().catch(() => {});
      throw error;
    } finally {
      reader.releaseLock();
    }
    return Buffer.concat(chunks, total).toString('utf8');
  }

  // Kept only for small synthetic/test responses that do not expose a body.
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length > MAX_CIMD_BYTES) throw new Error('cimd_body_too_large');
  return buffer.toString('utf8');
}

async function loadCimdClientMetadata(clientId, options = cimdOptionsOverride || {}) {
  const url = parseCimdClientId(clientId);
  if (!url) return invalid('cimd_client_id_invalid', 'invalid_client');

  const now = Date.now();
  const cached = cimdCache.get(url.toString());
  if (cached && cached.expiresAt > now) return cached.value;

  const lookup = options.lookup || dns.lookup;
  const fetchImpl = options.fetchImpl || nodeFetch;
  try {
    const addresses = await lookup(url.hostname, { all: true, verbatim: true });
    if (!Array.isArray(addresses) || addresses.length === 0 || addresses.some((entry) => isPrivateAddress(entry.address))) {
      return invalid('cimd_host_not_public', 'invalid_client');
    }

    const pinned = addresses[0];
    const agent = new https.Agent({
      keepAlive: false,
      lookup(_hostname, _lookupOptions, callback) {
        callback(null, pinned.address, pinned.family);
      },
    });
    const response = await fetchImpl(url.toString(), {
      method: 'GET',
      headers: { Accept: 'application/json' },
      redirect: 'error',
      signal: AbortSignal.timeout(CIMD_TIMEOUT_MS),
      agent,
    });
    if (!response.ok) return invalid('cimd_fetch_failed', 'invalid_client');
    const contentType = trimToString(response.headers?.get?.('content-type')).toLowerCase();
    if (!contentType.startsWith('application/json')) return invalid('cimd_content_type_invalid', 'invalid_client');

    const text = await readLimitedBody(response);
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      return invalid('cimd_json_invalid', 'invalid_client');
    }
    const result = readClientMetadata(body, { expectedClientId: url.toString() });
    if (!result.ok) return result;
    const value = { ...result, source: 'cimd' };
    if (cimdCache.size >= 256) cimdCache.delete(cimdCache.keys().next().value);
    cimdCache.set(url.toString(), { value, expiresAt: now + CIMD_CACHE_TTL_MS });
    return value;
  } catch (error) {
    const reason = error?.message === 'cimd_body_too_large' ? error.message : 'cimd_fetch_failed';
    return invalid(reason, 'invalid_client');
  }
}

function summarizeClientMetadataInput(body, result) {
  const redirects = Array.isArray(body?.redirect_uris) ? body.redirect_uris : [];
  const knownKeys = new Set([
    'application_type', 'client_id', 'client_name', 'grant_types', 'redirect_uris',
    'response_types', 'token_endpoint_auth_method',
  ]);
  const keys = body && typeof body === 'object' && !Array.isArray(body) ? Object.keys(body) : [];
  const summarizeEnumArray = (value, allowed) => {
    if (!Array.isArray(value)) return null;
    const supported = value.filter((item) => allowed.has(item));
    return {
      count: value.length,
      supported: [...new Set(supported)].slice(0, 4),
      hasUnsupported: supported.length !== value.length,
    };
  };
  return {
    reason: result?.reason || null,
    metadataKeyCount: keys.length,
    knownMetadataKeys: keys.filter((key) => knownKeys.has(key)).sort(),
    hasUnknownMetadataKeys: keys.some((key) => !knownKeys.has(key)),
    redirectCount: redirects.length,
    redirectHosts: redirects.slice(0, MAX_REDIRECT_URIS + 1).map((value) => {
      const parsed = parseRedirectUri(value);
      return parsed ? { scheme: parsed.url.protocol, hostname: parsed.url.hostname, kind: parsed.kind } : { invalid: true };
    }),
    grantTypes: summarizeEnumArray(body?.grant_types, new Set(['authorization_code', 'refresh_token'])),
    responseTypes: summarizeEnumArray(body?.response_types, new Set(['code'])),
    tokenEndpointAuthMethod: trimToString(body?.token_endpoint_auth_method) === 'none' ? 'none' : 'unsupported_or_missing',
    applicationType: ['web', 'native'].includes(trimToString(body?.application_type))
      ? trimToString(body.application_type)
      : 'unsupported_or_missing',
  };
}

function clientDiagnostic(metadata) {
  let host = null;
  try { host = new URL(metadata.redirectUris[0]).hostname; } catch {}
  return { clientName: metadata.clientName, clientHost: host };
}

function clearCimdCacheForTests() {
  cimdCache.clear();
}

function setCimdOptionsForTests(options) {
  cimdOptionsOverride = options || null;
  clearCimdCacheForTests();
}

module.exports = {
  __testing: {
    clearCimdCache: clearCimdCacheForTests,
    isPrivateAddress,
    loadCimdClientMetadata,
    setCimdOptions: setCimdOptionsForTests,
  },
  clientDiagnostic,
  isLoopbackHostname,
  loadCimdClientMetadata,
  parseCimdClientId,
  readClientMetadata,
  redirectUriMatches,
  summarizeClientMetadataInput,
};
