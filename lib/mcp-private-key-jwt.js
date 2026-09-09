const crypto = require('node:crypto');
const jwt = require('jsonwebtoken');
const { fetchPublicJson, parsePublicJsonUrl, normalizePublicJwks } = require('./mcp-client-registration');
const { consumeMcpClientAssertion, getIssuer } = require('./mcp-oauth-tokens');

const ASSERTION_TYPE = 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer';
const CLOCK_SKEW_SECONDS = 30;
const MAX_LIFETIME_SECONDS = 300;
const KEY_TTL_MS = 5 * 60 * 1000;
const REFRESH_COOLDOWN_MS = 60 * 1000;
const MAX_KEY_SOURCES = 256;
const MAX_PENDING_FETCHES = 16;

// Entries, including failures and rotation cooldowns, cannot be evicted while
// live: random kids/URLs must not bypass the network-work bound.
function createPrivateKeyJwtVerifier(options = {}) {
  const keyCache = new Map();
  let pendingFetches = 0;
  const nowMs = options.now || (() => Date.now());
  const fetchJson = options.fetchJson || ((url) => fetchPublicJson(url, undefined, ['application/json', 'application/jwk-set+json']));
  const consume = options.consume || consumeMcpClientAssertion;

  async function keysFor(client, refresh = false) {
    if (client.jwks) return normalizePublicJwks(client.jwks);
    const url = parsePublicJsonUrl(client.jwksUri);
    if (!url) return null;
    const source = url.toString();
    const now = nowMs();
    let entry = keyCache.get(source);
    if (entry?.pending) return entry.pending;
    if (entry && now < entry.retryAt) return entry.keys;
    if (entry && !refresh && now < entry.expiresAt) return entry.keys;
    if (pendingFetches >= MAX_PENDING_FETCHES) return null;
    if (!entry) {
      for (const [key, cached] of keyCache) {
        if (!cached.pending && cached.expiresAt <= now && cached.retryAt <= now) keyCache.delete(key);
      }
      if (keyCache.size >= MAX_KEY_SOURCES) return null;
      entry = { keys: null, expiresAt: 0, retryAt: 0 };
      keyCache.set(source, entry);
    }
    entry.retryAt = now + REFRESH_COOLDOWN_MS;
    pendingFetches += 1;
    entry.pending = (async () => {
      try {
        const result = await fetchJson(url);
        const keys = result.ok ? normalizePublicJwks(result.body) : null;
        // An unavailable or malformed source never extends the old keys' TTL.
        if (keys) {
          entry.keys = keys;
          entry.expiresAt = nowMs() + KEY_TTL_MS;
        } else {
          entry.keys = null;
          entry.expiresAt = entry.retryAt;
        }
        return entry.keys;
      } catch {
        entry.keys = null;
        entry.expiresAt = entry.retryAt;
        return null;
      } finally {
        pendingFetches -= 1;
        entry.pending = null;
      }
    })();
    return entry.pending;
  }

  function verifyWithKeys(assertion, decoded, keys, clientId, now) {
    if (!keys) return null;
    const matching = decoded.header.kid === undefined
      ? (keys.keys.length === 1 ? keys.keys : [])
      : keys.keys.filter((key) => key.kid === decoded.header.kid);
    if (matching.length !== 1) return null;
    try {
      const publicKey = crypto.createPublicKey({ key: matching[0], format: 'jwk' });
      return jwt.verify(assertion, publicKey, {
        algorithms: ['RS256'], issuer: clientId, subject: clientId,
        audience: `${getIssuer()}/gw/oauth/token`,
        clockTimestamp: now, clockTolerance: CLOCK_SKEW_SECONDS,
      });
    } catch { return null; }
  }

  async function preparePrivateKeyJwt(req, client) {
    try {
      const body = req.body || {};
      const assertion = body.client_assertion;
      if (body.client_id !== client.clientId || body.client_assertion_type !== ASSERTION_TYPE
        || typeof assertion !== 'string' || assertion.length > 16 * 1024
        || Object.hasOwn(body, 'client_secret') || req.headers?.authorization) return false;
      if (client.tokenEndpointAuthSigningAlg !== 'RS256') return false;
      const decoded = jwt.decode(assertion, { complete: true });
      if (!decoded || decoded.header.alg !== 'RS256'
        || Object.keys(decoded.header).some((key) => !['alg', 'typ', 'kid'].includes(key))
        || (decoded.header.typ !== undefined && decoded.header.typ !== 'JWT')
        || (decoded.header.kid !== undefined && (typeof decoded.header.kid !== 'string' || !decoded.header.kid || decoded.header.kid.length > 256))) return false;
      const claims = decoded.payload;
      const now = Math.floor(nowMs() / 1000);
      const audience = `${getIssuer()}/gw/oauth/token`;
      if (!claims || typeof claims !== 'object' || claims.iss !== client.clientId || claims.sub !== client.clientId
        || !(claims.aud === audience || (Array.isArray(claims.aud) && claims.aud.length === 1 && claims.aud[0] === audience))
        || !Number.isSafeInteger(claims.exp) || !Number.isSafeInteger(claims.iat)
        || claims.exp <= claims.iat || claims.exp - claims.iat > MAX_LIFETIME_SECONDS
        || claims.exp <= now - CLOCK_SKEW_SECONDS || claims.iat > now + CLOCK_SKEW_SECONDS
        || claims.iat < now - MAX_LIFETIME_SECONDS - CLOCK_SKEW_SECONDS
        || (claims.nbf !== undefined && (!Number.isSafeInteger(claims.nbf) || claims.nbf > now + CLOCK_SKEW_SECONDS || claims.nbf >= claims.exp))
        || typeof claims.jti !== 'string' || !claims.jti || claims.jti.length > 256) return false;
      let keys = await keysFor(client);
      let verified = verifyWithKeys(assertion, decoded, keys, client.clientId, Math.floor(nowMs() / 1000));
      if (!verified && !client.jwks) {
        keys = await keysFor(client, true);
        verified = verifyWithKeys(assertion, decoded, keys, client.clientId, Math.floor(nowMs() / 1000));
      }
      if (!verified) return false;
      // One client/JTI namespace across token and revocation endpoints; only
      // the verified hash and expiry reach the durable store.
      const hash = crypto.createHash('sha256').update(JSON.stringify([client.clientId, claims.jti])).digest('hex');
      const expiresAt = new Date((claims.exp + CLOCK_SKEW_SECONDS) * 1000);
      // Preparing a signature must not consume replay state before the grant
      // is validated and exclusively reserved by the token endpoint.
      return async () => {
        try {
          if (expiresAt.getTime() <= nowMs()) return false;
          return await consume(hash, expiresAt, new Date(nowMs()));
        } catch { return false; }
      };
    } catch {
      // Network, signature, and replay-store failures share a non-leaking
      // invalid_client response. In particular a missing table fails closed.
      return false;
    }
  }
  const verifyPrivateKeyJwt = async (req, client) => {
    const consumeVerified = await preparePrivateKeyJwt(req, client);
    return consumeVerified ? consumeVerified() : false;
  };
  verifyPrivateKeyJwt.prepare = preparePrivateKeyJwt;
  return verifyPrivateKeyJwt;
}

module.exports = {
  ASSERTION_TYPE,
  createPrivateKeyJwtVerifier,
  verifyPrivateKeyJwt: createPrivateKeyJwtVerifier(),
};
