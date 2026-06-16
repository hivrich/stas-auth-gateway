const assert = require('node:assert/strict');
const express = require('express');

const oauthPage = require('../middleware/oauth_page');
const oauth = require('../routes/oauth');

const INTERVALS_SCOPE = 'ACTIVITY:WRITE,WELLNESS:WRITE,CALENDAR:WRITE,CHATS:WRITE,LIBRARY:WRITE,SETTINGS:WRITE';
const CHATGPT_CALLBACK = 'https://chat.openai.com/aip/g-0e683685e67e111ebd51aa7d6b2be34f380bb37f/oauth/callback';
const INTERVALS_CALLBACK = 'https://intervals.stas.run/gw/oauth/callback';

function buildAuthorizePath(params = {}) {
  const search = new URLSearchParams({
    response_type: 'code',
    client_id: params.clientId ?? '',
    redirect_uri: params.redirectUri ?? CHATGPT_CALLBACK,
    state: params.state ?? 'test-state',
    scope: params.scope ?? INTERVALS_SCOPE,
  });
  return `/gw/oauth/authorize?${search.toString()}`;
}

function makeApp() {
  const app = express();
  app.use('/gw/oauth', oauthPage());
  app.use('/gw', oauth);
  app.use((_req, res) => res.status(404).json({ error: 'not_found' }));
  return app;
}

async function startServer(app) {
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server));
  });
}

async function request(baseUrl, path) {
  const response = await fetch(`${baseUrl}${path}`, { redirect: 'manual' });
  return {
    status: response.status,
    contentType: response.headers.get('content-type') || '',
    location: response.headers.get('location') || '',
    body: await response.text(),
  };
}

async function main() {
  const oldClientId = process.env.INTERVALS_CLIENT_ID;
  const oldClientSecret = process.env.INTERVALS_CLIENT_SECRET;
  process.env.INTERVALS_CLIENT_ID = 'test-intervals-client';
  process.env.INTERVALS_CLIENT_SECRET = 'test-intervals-secret';

  const server = await startServer(makeApp());
  const address = server.address();
  const baseUrl = `http://${address.address}:${address.port}`;

  try {
    const emptyClientId = await request(baseUrl, buildAuthorizePath({ clientId: '' }));
    assert.equal(emptyClientId.status, 302);
    assert.match(emptyClientId.location, /^https:\/\/intervals\.icu\/oauth\/authorize\?/);
    const emptyLocation = new URL(emptyClientId.location);
    assert.equal(emptyLocation.searchParams.get('client_id'), 'test-intervals-client');
    assert.equal(emptyLocation.searchParams.get('redirect_uri'), INTERVALS_CALLBACK);
    assert.notEqual(emptyLocation.searchParams.get('state'), 'test-state');
    assert.doesNotMatch(emptyClientId.body, /ВВЕДИТЕ ВАШ STAS ID/);

    const chatGptCallback = await request(
      baseUrl,
      `/gw/oauth/callback?code=intervals-code&state=${encodeURIComponent(emptyLocation.searchParams.get('state'))}`,
    );
    assert.equal(chatGptCallback.status, 302);
    const chatGptCallbackLocation = new URL(chatGptCallback.location);
    assert.equal(`${chatGptCallbackLocation.origin}${chatGptCallbackLocation.pathname}`, CHATGPT_CALLBACK);
    assert.equal(chatGptCallbackLocation.searchParams.get('state'), 'test-state');
    assert.match(chatGptCallbackLocation.searchParams.get('code'), /^gpt_/);

    const explicitClientId = await request(baseUrl, buildAuthorizePath({ clientId: 'explicit-client' }));
    assert.equal(explicitClientId.status, 302);
    const explicitLocation = new URL(explicitClientId.location);
    assert.equal(explicitLocation.searchParams.get('client_id'), 'explicit-client');
    assert.equal(explicitLocation.searchParams.get('redirect_uri'), INTERVALS_CALLBACK);

    const chatgptComCallback = await request(
      baseUrl,
      buildAuthorizePath({
        clientId: '',
        redirectUri: 'https://chatgpt.com/aip/g-test/oauth/callback',
      }),
    );
    assert.equal(chatgptComCallback.status, 302);
    const chatgptComLocation = new URL(chatgptComCallback.location);
    assert.equal(chatgptComLocation.searchParams.get('client_id'), 'test-intervals-client');
    assert.equal(chatgptComLocation.searchParams.get('redirect_uri'), INTERVALS_CALLBACK);

    const invalidRedirect = await request(
      baseUrl,
      buildAuthorizePath({
        clientId: '',
        redirectUri: 'https://evil.example/oauth/callback',
      }),
    );
    assert.equal(invalidRedirect.status, 400);
    assert.match(invalidRedirect.body, /invalid_request/);

    const legacyStasIdPage = await request(
      baseUrl,
      buildAuthorizePath({
        clientId: 'legacy-client',
        redirectUri: 'https://chat.openai.com/aip/g-legacy/oauth/callback',
        scope: 'read:me icu workouts:write',
      }),
    );
    assert.equal(legacyStasIdPage.status, 200);
    assert.match(legacyStasIdPage.contentType, /text\/html/);
    assert.match(legacyStasIdPage.body, /ВВЕДИТЕ ВАШ STAS ID/);

    console.log('oauth flow tests passed');
  } finally {
    server.close();
    if (oldClientId === undefined) delete process.env.INTERVALS_CLIENT_ID;
    else process.env.INTERVALS_CLIENT_ID = oldClientId;
    if (oldClientSecret === undefined) delete process.env.INTERVALS_CLIENT_SECRET;
    else process.env.INTERVALS_CLIENT_SECRET = oldClientSecret;
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
