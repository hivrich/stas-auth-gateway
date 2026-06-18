const express = require('express');
const {
  AGENT_INTERVALS_READ_SCOPE,
  completeAgentRegistration,
  consumeIntervalsClaimState,
  createAnonymousIdentity,
  createIntervalsClaimStateForUserCode,
  getClaimCeremony,
  isAgentAuthConfigured,
} = require('../lib/agent-auth');
const { resolveDirectIntervalsAuth } = require('../lib/request-auth');

const router = express.Router();
const INTERVALS_AUTH_URL = 'https://intervals.icu/oauth/authorize';
const INTERVALS_TOKEN_URL = 'https://intervals.icu/api/oauth/token';

function trimToString(value) {
  if (value === null || value === undefined) return '';
  return String(value).trim();
}

function requestOrigin(req) {
  return `${req.protocol}://${req.get('host')}`;
}

function featureUnavailable(res) {
  return res.status(503).json({ error: 'service_unavailable', reason: 'agent_auth_not_configured' });
}

function getIntervalsClientConfig() {
  const clientId = trimToString(process.env.INTERVALS_CLIENT_ID);
  const clientSecret = trimToString(process.env.INTERVALS_CLIENT_SECRET);
  if (!clientId || !clientSecret) return null;
  return { clientId, clientSecret };
}

function getAgentCallbackUrl(req) {
  return trimToString(process.env.INTERVALS_AGENT_CALLBACK_URL) || `${requestOrigin(req)}/gw/agent/callback`;
}

function renderClaimPage({ error = '' } = {}) {
  const errorHtml = error ? '<p role="alert">Код не подошел или истек. Проверьте код и попробуйте снова.</p>' : '';
  return `<!doctype html>
<html lang="ru">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>STAS Agent Auth</title>
  <style>
    body { font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; margin: 0; padding: 32px; background: #f7f7f2; color: #1d241f; }
    main { max-width: 420px; margin: 8vh auto; }
    label { display: block; font-weight: 650; margin-bottom: 8px; }
    input { box-sizing: border-box; width: 100%; font-size: 28px; letter-spacing: 0.08em; padding: 12px 14px; border: 1px solid #9aa39b; border-radius: 8px; background: #fff; }
    button { margin-top: 16px; width: 100%; border: 0; border-radius: 8px; padding: 13px 16px; font-weight: 700; background: #1f5f46; color: #fff; cursor: pointer; }
    p { line-height: 1.45; }
  </style>
</head>
<body>
  <main>
    <h1>STAS Agent Auth</h1>
    ${errorHtml}
    <form method="post" action="/gw/agent/claim">
      <label for="user_code">Код подключения</label>
      <input id="user_code" name="user_code" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}" maxlength="6" required>
      <button type="submit">Подключить через Intervals</button>
    </form>
  </main>
</body>
</html>`;
}

function renderConnectedPage() {
  return `<!doctype html>
<html lang="ru">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>STAS Agent Auth</title></head>
<body><main><h1>Подключено</h1><p>Можно вернуться к агенту.</p></main></body>
</html>`;
}

function renderErrorPage(status, res) {
  return res.status(status).type('html').send(renderClaimPage({ error: 'invalid' }));
}

router.post('/agent/identity', (req, res, next) => {
  try {
    if (!isAgentAuthConfigured()) return featureUnavailable(res);

    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const keys = Object.keys(body);
    if (keys.length !== 1 || body.type !== 'anonymous') {
      return res.status(400).json({ error: 'invalid_request' });
    }

    const identity = createAnonymousIdentity({
      origin: requestOrigin(req),
      ip: req.ip || req.get('x-forwarded-for') || 'unknown',
    });
    console.log('[agent_auth][identity_created]', JSON.stringify({ registration_id: identity.registration_id }));
    return res.json(identity);
  } catch (error) {
    return next(error);
  }
});

router.post('/agent/identity/claim', (req, res, next) => {
  try {
    if (!isAgentAuthConfigured()) return featureUnavailable(res);

    const claimToken = trimToString(req.body?.claim_token);
    if (!claimToken) return res.status(400).json({ error: 'invalid_request' });

    return res.json(getClaimCeremony(claimToken, { origin: requestOrigin(req) }));
  } catch (error) {
    if (error?.code === 'invalid_grant') return res.status(400).json({ error: 'invalid_grant' });
    return next(error);
  }
});

router.get('/agent/claim', (_req, res) => {
  if (!isAgentAuthConfigured()) {
    return res.status(503).type('html').send('<!doctype html><title>Unavailable</title><p>Agent Auth is not enabled.</p>');
  }
  return res.type('html').send(renderClaimPage());
});

router.post('/agent/claim', (req, res, next) => {
  try {
    if (!isAgentAuthConfigured()) return renderErrorPage(503, res);

    const client = getIntervalsClientConfig();
    if (!client) return renderErrorPage(503, res);

    const claim = createIntervalsClaimStateForUserCode(req.body?.user_code, {
      ip: req.ip || req.get('x-forwarded-for') || 'unknown',
    });
    const callbackUrl = getAgentCallbackUrl(req);
    const url = new URL(INTERVALS_AUTH_URL);
    url.searchParams.set('client_id', client.clientId);
    url.searchParams.set('redirect_uri', callbackUrl);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('scope', AGENT_INTERVALS_READ_SCOPE);
    url.searchParams.set('state', claim.state);

    console.log('[agent_auth][claim_started]', JSON.stringify({ registration_id: claim.registrationId }));
    return res.redirect(302, url.toString());
  } catch (error) {
    if (error?.status === 429) return renderErrorPage(429, res);
    if (error?.status === 400) return renderErrorPage(400, res);
    return next(error);
  }
});

router.get('/agent/callback', async (req, res, next) => {
  try {
    if (!isAgentAuthConfigured()) return renderErrorPage(503, res);

    const upstreamError = trimToString(req.query?.error);
    if (upstreamError) return renderErrorPage(400, res);

    const client = getIntervalsClientConfig();
    const registration = consumeIntervalsClaimState(req.query?.state);
    const code = trimToString(req.query?.code);
    if (!client || !registration || !code) return renderErrorPage(400, res);

    const form = new URLSearchParams();
    form.set('grant_type', 'authorization_code');
    form.set('client_id', client.clientId);
    form.set('client_secret', client.clientSecret);
    form.set('code', code);
    form.set('redirect_uri', getAgentCallbackUrl(req));

    const upstream = await fetch(INTERVALS_TOKEN_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body: form,
      signal: AbortSignal.timeout(10_000),
    });
    const payload = await upstream.json().catch(() => null);
    if (!upstream.ok || !payload?.access_token) {
      console.error('[agent_auth][callback][intervals_error]', upstream.status);
      return renderErrorPage(502, res);
    }

    const auth = await resolveDirectIntervalsAuth(payload.access_token, { source: 'gpt' });
    if (!auth?.userId) return renderErrorPage(502, res);

    completeAgentRegistration(registration.registrationId, {
      userId: auth.userId,
      intervalsAccessToken: payload.access_token,
    });

    console.log('[agent_auth][claim_completed]', JSON.stringify({ registration_id: registration.registrationId, user_id: auth.userId }));
    return res.type('html').send(renderConnectedPage());
  } catch (error) {
    return next(error);
  }
});

module.exports = router;
