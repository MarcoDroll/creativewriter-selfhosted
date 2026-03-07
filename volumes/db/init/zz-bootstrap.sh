#!/bin/bash
# zz-bootstrap.sh — Runs inside the supabase/postgres image's initdb phase.
# Mounted at /docker-entrypoint-initdb.d/ top level (not init-scripts/) so it
# runs as a .sh file. Prefix "zz" ensures it sorts after the image's migrate.sh.
# Sets role passwords, creates required schemas, transfers auth ownership, and
# installs auth function stubs so the application schema (99-*.sql) works.
#
# All statements are idempotent — safe to re-run.

set -euo pipefail

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<-EOSQL

  -- ── Role passwords ──────────────────────────────────────────────────
  -- The supabase/postgres image creates these roles WITHOUT passwords.
  -- GoTrue, PostgREST, and Storage connect via TCP and need passwords.
  ALTER ROLE supabase_auth_admin    WITH LOGIN PASSWORD '${POSTGRES_PASSWORD}';
  ALTER ROLE authenticator          WITH LOGIN PASSWORD '${POSTGRES_PASSWORD}';
  ALTER ROLE supabase_storage_admin WITH LOGIN PASSWORD '${POSTGRES_PASSWORD}';
  ALTER ROLE supabase_admin         WITH LOGIN PASSWORD '${POSTGRES_PASSWORD}';

  -- ── _realtime schema ────────────────────────────────────────────────
  -- Realtime service sets search_path = _realtime on connect.
  CREATE SCHEMA IF NOT EXISTS _realtime;
  ALTER SCHEMA _realtime OWNER TO supabase_admin;

  -- ── Auth schema ownership ───────────────────────────────────────────
  -- GoTrue needs to own the auth schema to run its migrations.
  ALTER SCHEMA auth OWNER TO supabase_auth_admin;
  GRANT ALL ON SCHEMA auth TO supabase_auth_admin;
  GRANT USAGE ON SCHEMA auth TO postgres, anon, authenticated, service_role;

  -- The image's built-in 00000000000001-auth-schema.sql creates auth.email()
  -- owned by postgres. GoTrue's migrations need to replace it, so transfer ownership.
  ALTER FUNCTION auth.email() OWNER TO supabase_auth_admin;

  -- ── Auth function stubs ─────────────────────────────────────────────
  -- RLS policies in 99-creativewriter-schema.sql reference auth.uid()
  -- and auth.role(). GoTrue replaces these on first start, but we need
  -- them to exist during initdb so CREATE POLICY does not fail.
  CREATE OR REPLACE FUNCTION auth.uid()
  RETURNS uuid
  LANGUAGE sql STABLE
  AS \$\$
    SELECT NULLIF(
      current_setting('request.jwt.claim.sub', true),
      ''
    )::uuid;
  \$\$;

  CREATE OR REPLACE FUNCTION auth.role()
  RETURNS text
  LANGUAGE sql STABLE
  AS \$\$
    SELECT NULLIF(
      current_setting('request.jwt.claim.role', true),
      ''
    )::text;
  \$\$;

  -- Make stubs callable by the roles that appear in RLS policies
  GRANT EXECUTE ON FUNCTION auth.uid()  TO postgres, anon, authenticated, service_role;
  GRANT EXECUTE ON FUNCTION auth.role() TO postgres, anon, authenticated, service_role;

  -- ── Default privileges ──────────────────────────────────────────────
  -- When GoTrue creates tables/functions in auth, auto-grant to the
  -- standard Supabase roles so PostgREST and application code work.
  ALTER DEFAULT PRIVILEGES FOR ROLE supabase_auth_admin IN SCHEMA auth
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO postgres, anon, authenticated, service_role;

  ALTER DEFAULT PRIVILEGES FOR ROLE supabase_auth_admin IN SCHEMA auth
    GRANT EXECUTE ON FUNCTIONS TO postgres, anon, authenticated, service_role;

  -- ── Migration tracking ─────────────────────────────────────────────
  -- Init scripts cover migrations 00001–00005. Seed the tracking table
  -- so the migration runner (migrate.sh) skips them.
  CREATE TABLE IF NOT EXISTS public._cw_migrations (
    name TEXT PRIMARY KEY,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  INSERT INTO public._cw_migrations (name) VALUES
    ('00001_initial_schema.sql'),
    ('00002_beat_history_stats_rpc.sql'),
    ('00003_stripe_kv_replacement_tables.sql'),
    ('00004_story_word_count_rpc.sql'),
    ('00005_bulk_word_count_rpc.sql')
  ON CONFLICT (name) DO NOTHING;

EOSQL

echo "zz-bootstrap.sh: database bootstrap complete"
