const crypto = require('node:crypto');
const jwt = require('jsonwebtoken');
const { Pool } = require('pg');
const { normalizeMcpScopes } = require('./mcp-oauth-scopes');

const ACCESS_TOKEN_PREFIX = 'stas_mcp_at_';
const REFRESH_TOKEN_PREFIX = 'stas_mcp_rt_';
const DEFAULT_ACCESS_TTL_SECONDS = 60 * 60;
const DEFAULT_REFRESH_TTL_SECONDS = 30 * 24 * 60 * 60;
const TOKEN_KEY_CONTEXT = 'stas-mcp-oauth-token-v1';
const PLACEHOLDER_SECRETS = new Set([
  'changeme', 'change-me', 'change_me', 'dev', 'development', 'placeholder',
  'replace-me', 'replace_me', 'secret', 'stas-oauth-state-dev-secret', 'test',
]);
const PLACEHOLDER_MARKERS = ['change-me', 'changeme', 'generate-with', 'openssl', 'placeholder', 'replace-me', 'todo', 'your-'];

let pool;
let tokenStoreOverride;

function trimToString(value) {
  if (value === null || value === undefined) return '';
  return String(value).trim();
}

function getIssuer() {
  return trimToString(process.env.GATEWAY_BASE_URL).replace(/\/+$/, '') || 'https://intervals.stas.run';
}

function getMcpResource() {
  return trimToString(process.env.MCP_RESOURCE_URL).replace(/\/+$/, '') || 'https://stas.run/api/mcp';
}

function getTokenSecret() {
  const candidates = [
    process.env.MCP_OAUTH_TOKEN_SECRET,
    process.env.OAUTH_STATE_SECRET,
    process.env.INTERVALS_CLIENT_SECRET,
  ];
  for (const candidate of candidates) {
    const raw = trimToString(candidate);
    const normalized = raw.toLowerCase();
    const usable = raw.length >= 32
      && !PLACEHOLDER_SECRETS.has(normalized)
      && !PLACEHOLDER_MARKERS.some((marker) => normalized.includes(marker));
    if (usable) return raw;
  }
  if (process.env.NODE_ENV === 'test') return 'stas-mcp-oauth-test-secret-32-bytes-minimum';
  const error = new Error('mcp_oauth_token_secret_not_configured');
  error.status = 500;
  throw error;
}

function getSigningKey() {
  return crypto.createHmac('sha256', getTokenSecret()).update(TOKEN_KEY_CONTEXT).digest();
}

function hashToken(token) {
  return `sha256:${crypto.createHash('sha256').update(trimToString(token)).digest('hex')}`;
}

function getAccessTtlSeconds() {
  return Math.max(300, Number(process.env.MCP_ACCESS_TOKEN_TTL_SECONDS || DEFAULT_ACCESS_TTL_SECONDS));
}

function getRefreshTtlSeconds() {
  return Math.max(3600, Number(process.env.MCP_REFRESH_TOKEN_TTL_SECONDS || DEFAULT_REFRESH_TTL_SECONDS));
}

function signToken(prefix, payload, expiresIn) {
  return `${prefix}${jwt.sign(payload, getSigningKey(), {
    algorithm: 'HS256',
    issuer: getIssuer(),
    audience: payload.resource,
    expiresIn,
  })}`;
}

function verifyToken(rawToken, prefix, resource = getMcpResource()) {
  const token = trimToString(rawToken);
  if (!token.startsWith(prefix)) return null;
  try {
    return jwt.verify(token.slice(prefix.length), getSigningKey(), {
      algorithms: ['HS256'],
      issuer: getIssuer(),
      audience: resource,
    });
  } catch {
    return null;
  }
}

function createTokenRecord(params) {
  const accessJti = crypto.randomUUID();
  const refreshJti = crypto.randomUUID();
  const scopes = normalizeMcpScopes(params.scopes);
  if (!scopes) {
    const error = new Error('invalid_mcp_token_scope');
    error.status = 500;
    throw error;
  }
  const resource = trimToString(params.resource) || getMcpResource();
  const common = {
    sub: trimToString(params.subject),
    uid: Number(params.userId),
    client_id: trimToString(params.clientId),
    source: 'mcp',
    resource,
    scope: scopes.join(' '),
    ...(params.clientName ? { cn: trimToString(params.clientName) } : {}),
    ...(params.clientHost ? { ch: trimToString(params.clientHost) } : {}),
  };
  const accessToken = signToken(ACCESS_TOKEN_PREFIX, { ...common, jti: accessJti, token_use: 'access' }, getAccessTtlSeconds());
  const allowRefresh = params.allowRefresh === true;
  const refreshToken = allowRefresh
    ? signToken(REFRESH_TOKEN_PREFIX, { ...common, jti: refreshJti, token_use: 'refresh' }, getRefreshTtlSeconds())
    : null;
  const now = Date.now();
  return {
    accessToken,
    refreshToken,
    db: {
      accessTokenHash: hashToken(accessToken),
      refreshTokenHash: refreshToken ? hashToken(refreshToken) : `disabled:${accessJti}`,
      userId: Number(params.userId),
      scopes,
      accessJti,
      clientId: trimToString(params.clientId),
      accessExpiresAt: new Date(now + getAccessTtlSeconds() * 1000),
      refreshExpiresAt: refreshToken ? new Date(now + getRefreshTtlSeconds() * 1000) : new Date(now),
    },
    response: {
      access_token: accessToken,
      token_type: 'Bearer',
      expires_in: getAccessTtlSeconds(),
      scope: scopes.join(' '),
      ...(refreshToken ? { refresh_token: refreshToken } : {}),
    },
  };
}

class PgTokenStore {
  constructor(poolOverride = null) {
    this.poolOverride = poolOverride;
  }

  getPool() {
    if (this.poolOverride) return this.poolOverride;
    if (!pool) {
      const connectionString = trimToString(process.env.STAS_PGURL);
      if (!connectionString) {
        const error = new Error('mcp_oauth_store_not_configured');
        error.status = 500;
        throw error;
      }
      pool = new Pool({ connectionString });
    }
    return pool;
  }

  async insert(record, client = this.getPool()) {
    await client.query(
      `INSERT INTO gw_oauth_tokens
       (access_token, refresh_token_hash, user_id, scopes, access_jti, client_id, access_expires_at, refresh_expires_at, revoked_at)
       VALUES ($1, $2, $3, $4::text[], $5::uuid, $6, $7, $8, NULL)`,
      [record.accessTokenHash, record.refreshTokenHash, record.userId, record.scopes, record.accessJti, record.clientId, record.accessExpiresAt, record.refreshExpiresAt],
    );
  }

  async findAccess(accessTokenHash) {
    const { rows } = await this.getPool().query(
      `SELECT access_token, refresh_token_hash, user_id, scopes, access_jti, client_id, access_expires_at, refresh_expires_at, revoked_at
       FROM gw_oauth_tokens WHERE access_token = $1 LIMIT 1`,
      [accessTokenHash],
    );
    return rows[0] || null;
  }

  async rotateRefresh(refreshTokenHash, clientId, buildNext) {
    const client = await this.getPool().connect();
    try {
      await client.query('BEGIN');
      const { rows } = await client.query(
        `SELECT access_token, refresh_token_hash, user_id, scopes, access_jti, client_id, access_expires_at, refresh_expires_at, revoked_at
         FROM gw_oauth_tokens WHERE refresh_token_hash = $1 FOR UPDATE`,
        [refreshTokenHash],
      );
      const current = rows[0];
      if (!current || current.revoked_at || new Date(current.refresh_expires_at).getTime() <= Date.now() || current.client_id !== clientId) {
        await client.query('ROLLBACK');
        return null;
      }
      const revoked = await client.query(
        `UPDATE gw_oauth_tokens SET revoked_at = NOW()
         WHERE refresh_token_hash = $1 AND revoked_at IS NULL
         RETURNING access_token`,
        [refreshTokenHash],
      );
      if (revoked.rowCount !== 1) {
        await client.query('ROLLBACK');
        return null;
      }
      const next = buildNext(current);
      await this.insert(next.db, client);
      await client.query('COMMIT');
      return next;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  async revokeAccess(accessTokenHash) {
    await this.getPool().query('UPDATE gw_oauth_tokens SET revoked_at = COALESCE(revoked_at, NOW()) WHERE access_token = $1', [accessTokenHash]);
  }

  async revokeRefresh(refreshTokenHash) {
    await this.getPool().query('UPDATE gw_oauth_tokens SET revoked_at = COALESCE(revoked_at, NOW()) WHERE refresh_token_hash = $1', [refreshTokenHash]);
  }
}

class MemoryTokenStore {
  constructor() { this.records = []; }
  async insert(record) { this.records.push({ ...record, revoked_at: null }); }
  async findAccess(hash) { return this.records.find((record) => record.accessTokenHash === hash || record.access_token === hash) || null; }
  async rotateRefresh(hash, clientId, buildNext) {
    const current = this.records.find((record) => (record.refreshTokenHash === hash || record.refresh_token_hash === hash) && !record.revoked_at);
    if (!current || current.clientId !== clientId || new Date(current.refreshExpiresAt).getTime() <= Date.now()) return null;
    current.revoked_at = new Date();
    const next = buildNext(current);
    await this.insert(next.db);
    return next;
  }
  async revokeAccess(hash) {
    const record = await this.findAccess(hash);
    if (record) record.revoked_at = record.revoked_at || new Date();
  }
  async revokeRefresh(hash) {
    const record = this.records.find((entry) => entry.refreshTokenHash === hash || entry.refresh_token_hash === hash);
    if (record) record.revoked_at = record.revoked_at || new Date();
  }
}

function getStore() {
  if (tokenStoreOverride) return tokenStoreOverride;
  if (process.env.NODE_ENV === 'test') {
    tokenStoreOverride = new MemoryTokenStore();
    return tokenStoreOverride;
  }
  tokenStoreOverride = new PgTokenStore();
  return tokenStoreOverride;
}

async function issueMcpTokens(params) {
  if (!trimToString(params.subject) || !Number.isInteger(Number(params.userId)) || !trimToString(params.clientId)) {
    const error = new Error('invalid_mcp_token_subject');
    error.status = 500;
    throw error;
  }
  const tokens = createTokenRecord(params);
  await getStore().insert(tokens.db);
  return tokens.response;
}

async function resolveMcpAccessToken(token, options = {}) {
  if (!trimToString(token).startsWith(ACCESS_TOKEN_PREFIX)) return { matched: false, auth: null };
  const payload = verifyToken(token, ACCESS_TOKEN_PREFIX, options.resource || getMcpResource());
  if (!payload || payload.token_use !== 'access' || payload.source !== 'mcp') return { matched: true, auth: null };
  const record = await getStore().findAccess(hashToken(token));
  const expiresAt = record?.access_expires_at || record?.accessExpiresAt;
  const accessJti = trimToString(record?.access_jti || record?.accessJti);
  const recordClientId = trimToString(record?.client_id || record?.clientId);
  const recordUserId = Number(record?.user_id ?? record?.userId);
  const scopes = normalizeMcpScopes(payload.scope, { useDefault: false });
  if (
    !record
    || record.revoked_at
    || !expiresAt
    || new Date(expiresAt).getTime() <= Date.now()
    || accessJti !== payload.jti
    || recordClientId !== payload.client_id
    || recordUserId !== Number(payload.uid)
    || !scopes
  ) return { matched: true, auth: null };

  return {
    matched: true,
    auth: {
      userId: trimToString(payload.sub),
      athleteId: Number(payload.uid),
      authMode: 'mcp',
      source: 'mcp',
      resource: trimToString(payload.resource),
      scopes,
      clientId: trimToString(payload.client_id),
      clientName: trimToString(payload.cn) || undefined,
      clientHost: trimToString(payload.ch) || undefined,
    },
  };
}

async function refreshMcpTokens(refreshToken, params = {}) {
  const resource = trimToString(params.resource) || getMcpResource();
  const payload = verifyToken(refreshToken, REFRESH_TOKEN_PREFIX, resource);
  const clientId = trimToString(params.clientId);
  if (!payload || payload.token_use !== 'refresh' || payload.source !== 'mcp' || !clientId || payload.client_id !== clientId) return null;
  const currentHash = hashToken(refreshToken);
  return getStore().rotateRefresh(currentHash, clientId, () => createTokenRecord({
    subject: payload.sub,
    userId: payload.uid,
    clientId,
    resource,
    scopes: payload.scope,
    allowRefresh: true,
    clientName: payload.cn,
    clientHost: payload.ch,
  }));
}

async function revokeMcpToken(token) {
  const raw = trimToString(token);
  if (raw.startsWith(ACCESS_TOKEN_PREFIX)) {
    await getStore().revokeAccess(hashToken(raw));
    return true;
  }
  if (raw.startsWith(REFRESH_TOKEN_PREFIX)) {
    await getStore().revokeRefresh(hashToken(raw));
    return true;
  }
  return false;
}

function resetTokenStoreForTests() {
  tokenStoreOverride = new MemoryTokenStore();
  return tokenStoreOverride;
}

module.exports = {
  ACCESS_TOKEN_PREFIX,
  REFRESH_TOKEN_PREFIX,
  __testing: {
    MemoryTokenStore,
    PgTokenStore,
    hashToken,
    resetTokenStore: resetTokenStoreForTests,
    verifyToken,
  },
  getIssuer,
  getMcpResource,
  issueMcpTokens,
  refreshMcpTokens,
  resolveMcpAccessToken,
  revokeMcpToken,
};
