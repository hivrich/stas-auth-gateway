-- OAuth clients
CREATE TABLE IF NOT EXISTS public.gw_oauth_clients (
  client_id text PRIMARY KEY,
  client_secret_hash text NOT NULL,
  allowed_redirects text[] NOT NULL DEFAULT '{}',
  scopes text[] NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  disabled_at timestamptz
);

-- Authorization codes
CREATE TABLE IF NOT EXISTS public.gw_oauth_codes (
  code text PRIMARY KEY,
  client_id text NOT NULL REFERENCES public.gw_oauth_clients(client_id) ON DELETE CASCADE,
  user_id bigint NOT NULL,
  redirect_uri text NOT NULL,
  scopes text[] NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS gw_oauth_codes_expires_idx ON public.gw_oauth_codes(expires_at);

-- Tokens
CREATE TABLE IF NOT EXISTS public.gw_oauth_tokens (
  access_token text PRIMARY KEY,
  refresh_token_hash text NOT NULL,
  user_id bigint NOT NULL,
  scopes text[] NOT NULL DEFAULT '{}',
  access_expires_at timestamptz NOT NULL,
  refresh_expires_at timestamptz NOT NULL,
  access_jti uuid,
  client_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz
);
CREATE INDEX IF NOT EXISTS gw_oauth_tokens_user_idx ON public.gw_oauth_tokens(user_id);
CREATE INDEX IF NOT EXISTS gw_oauth_tokens_refresh_hash_idx ON public.gw_oauth_tokens(refresh_token_hash);
