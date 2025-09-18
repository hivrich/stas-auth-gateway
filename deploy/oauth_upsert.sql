-- OAuth client upsert for ChatGPT Actions
-- Replace <PASTE_NEW_OAUTH_CLIENT_SECRET> and <G-XXXX> / <G-REAL> as needed.
BEGIN;
INSERT INTO gw_oauth_clients (client_id, client_secret, redirect_uri, name)
VALUES (
  'chatgpt-actions',
  '<PASTE_NEW_OAUTH_CLIENT_SECRET>',
  'https://chat.openai.com/aip/g-324779f0d9c5a3baa0071c75490641d127bc7529/oauth/callback',
  'ChatGPT Actions'
)
ON CONFLICT (client_id) DO UPDATE
SET client_secret = EXCLUDED.client_secret,
    redirect_uri = EXCLUDED.redirect_uri;
COMMIT;

-- After the exact redirect URI is known:
-- UPDATE gw_oauth_clients
-- SET redirect_uri = 'https://chat.openai.com/aip/<G-REAL>/oauth/callback'
-- WHERE client_id = 'chatgpt-actions';
