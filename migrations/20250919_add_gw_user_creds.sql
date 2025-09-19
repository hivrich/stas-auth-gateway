BEGIN;

-- Explicit per-user creds. No defaults allowed.
CREATE TABLE IF NOT EXISTS gw_user_creds (
  user_id           BIGINT PRIMARY KEY,
  icu_api_key       TEXT    NOT NULL,
  icu_athlete_id    TEXT    NOT NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS gw_user_creds_updated_at_idx ON gw_user_creds(updated_at);

-- Trigger to keep updated_at fresh
CREATE OR REPLACE FUNCTION trg_touch_updated_at() RETURNS trigger AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END$$ LANGUAGE plpgsql;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger WHERE tgname = 'gw_user_creds_touch_updated_at'
  ) THEN
    CREATE TRIGGER gw_user_creds_touch_updated_at
      BEFORE UPDATE ON gw_user_creds
      FOR EACH ROW EXECUTE FUNCTION trg_touch_updated_at();
  END IF;
END$$;

COMMIT;
