#!/bin/bash
# migrate.sh — One-shot migration runner for self-hosted deployments.
# Runs on every `docker compose up`, applies only unapplied migrations.
set -euo pipefail

MIGRATIONS_DIR="/migrations"

# Ensure migration tracking table exists
psql <<'SQL'
CREATE TABLE IF NOT EXISTS public._cw_migrations (
  name TEXT PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
SQL

# Bootstrap detection — if the database was set up before migration tracking
# existed (i.e. _cw_migrations is empty but the application schema is present),
# seed migrations 00001–00005 so we don't try to re-apply init-covered migrations.
row_count=$(psql -tAc "SELECT count(*) FROM public._cw_migrations")
if [ "$row_count" = "0" ]; then
  has_schema=$(psql -tAc "SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'stories'" || echo "")
  if [ "$has_schema" = "1" ]; then
    echo "Detected existing database without migration tracking — seeding 00001–00005"
    psql <<'SQL'
INSERT INTO public._cw_migrations (name) VALUES
  ('00001_initial_schema.sql'),
  ('00002_beat_history_stats_rpc.sql'),
  ('00003_stripe_kv_replacement_tables.sql'),
  ('00004_story_word_count_rpc.sql'),
  ('00005_bulk_word_count_rpc.sql')
ON CONFLICT (name) DO NOTHING;
SQL
  fi
fi

# Wait for storage-api to finish its own schema migrations before running
# our migrations. Migrations 00007 and 00015 UPDATE storage.buckets columns
# (public, file_size_limit, allowed_mime_types) that storage-api adds on
# first boot. Without this wait, migrate can race storage-api and fail.
echo "Waiting for storage-api schema migrations to complete..."
for i in $(seq 1 30); do
  ready=$(psql -tAc "SELECT 1 FROM information_schema.columns WHERE table_schema = 'storage' AND table_name = 'buckets' AND column_name = 'public'" 2>/dev/null || echo "")
  if [ "$ready" = "1" ]; then
    echo "Storage schema ready."
    break
  fi
  if [ "$i" -eq 30 ]; then
    echo "WARN: storage schema not ready after 90s — proceeding anyway (migrations referencing storage columns may fail and retry on next 'docker compose up')."
    break
  fi
  sleep 3
done

for f in "$MIGRATIONS_DIR"/*.sql; do
  [ -f "$f" ] || continue
  name=$(basename "$f")
  applied=$(psql -tAc "SELECT 1 FROM public._cw_migrations WHERE name = '$name'" || echo "")
  if [ "$applied" != "1" ]; then
    echo "Applying migration: $name"
    psql -v ON_ERROR_STOP=1 <<EOSQL
BEGIN;
\i $f
INSERT INTO public._cw_migrations (name) VALUES ('$name');
COMMIT;
EOSQL
  else
    echo "Already applied: $name"
  fi
done

echo "Migration runner complete."
