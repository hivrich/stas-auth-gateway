-- Usage: psql -h <host> -U <user> -d <db> -f bin/seed_client.sql
-- After running, copy the printed secret and set it where your client can use it.
\echo Generating ChatGPT Actions client secret...
SELECT encode(gen_random_bytes(32), 'base64') AS secret \gset
\echo ChatGPT client secret: :secret

INSERT INTO public.gw_oauth_clients (client_id, client_secret_hash, allowed_redirects, scopes)
VALUES (
  'chatgpt-actions',
  crypt(:'secret', gen_salt('bf')),
  ARRAY['https://chat.openai.com/aip/api/callback','https://chatgpt.com/aip/api/callback'],
  ARRAY['read:me','icu','workouts:write']
)
ON CONFLICT (client_id) DO UPDATE SET
  client_secret_hash = EXCLUDED.client_secret_hash,
  allowed_redirects = EXCLUDED.allowed_redirects,
  scopes = EXCLUDED.scopes;

SELECT (crypt(:'secret', client_secret_hash)=client_secret_hash) ok
FROM public.gw_oauth_clients WHERE client_id='chatgpt-actions';
