-- Run ONCE by the admin on the NEW testing database only. Never on dev/staging/prod.
CREATE SCHEMA IF NOT EXISTS ae_env;
CREATE TABLE IF NOT EXISTS ae_env.marker (
  env text PRIMARY KEY CHECK (env = 'testing'),
  db_name text NOT NULL,
  marked_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO ae_env.marker (env, db_name) VALUES ('testing', current_database()) ON CONFLICT (env) DO NOTHING;
DO $$ BEGIN EXECUTE format('ALTER DATABASE %I SET timezone TO %L', current_database(), 'UTC'); END $$;
