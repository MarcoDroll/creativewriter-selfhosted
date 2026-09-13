#!/bin/bash
# migrate.sh — One-shot migration runner for self-hosted deployments.
# Runs on every `docker compose up`, applies only unapplied migrations.
set -euo pipefail

MIGRATIONS_DIR="/migrations"

# Track which migration is currently being applied so the ERR trap can name it.
# Initialize before any work runs so the trap never reports a stale value if it
# fires from a pre-loop command.
current_migration=""

on_error() {
  echo ""
  echo "=========================================================="
  echo "ERROR: migrate runner aborted."
  if [ -n "$current_migration" ]; then
    echo "Failed while applying: $current_migration"
  fi
  echo "Recovery: fix the underlying error, then re-run:"
  echo "  docker compose -f docker-compose.stable.yml run --rm migrate"
  echo "=========================================================="
}
trap on_error ERR

# Ensure migration tracking table exists
psql <<'SQL'
CREATE TABLE IF NOT EXISTS public._cw_migrations (
  name TEXT PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
SQL

# Bootstrap detection — if the database was set up before migration tracking
# existed (i.e. _cw_migrations is empty but the application schema is present),
# seed migrations 00001–00009 so we don't try to re-apply init-covered migrations.
# This list mirrors the seed list in init/zz-bootstrap.sh: if you update the init
# schema (init/99-creativewriter-schema.sql) to reflect a later migration, extend
# both lists to match.
row_count=$(psql -tAc "SELECT count(*) FROM public._cw_migrations")
if [ "$row_count" = "0" ]; then
  has_schema=$(psql -tAc "SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'stories'" || echo "")
  if [ "$has_schema" = "1" ]; then
    echo "Detected existing database without migration tracking — seeding 00001–00009"
    psql <<'SQL'
INSERT INTO public._cw_migrations (name) VALUES
  ('00001_initial_schema.sql'),
  ('00002_beat_history_stats_rpc.sql'),
  ('00003_stripe_kv_replacement_tables.sql'),
  ('00004_story_word_count_rpc.sql'),
  ('00005_bulk_word_count_rpc.sql'),
  ('00006_scenes_composite_index.sql'),
  ('00007_public_story_media_bucket.sql'),
  ('00008_monthly_ai_budget.sql'),
  ('00009_simplify_ai_usage_monthly.sql')
ON CONFLICT (name) DO NOTHING;
SQL
  fi
fi

# Up-front summary — surfaces "0 files found" / "3 files found" issues
# immediately in `docker compose logs migrate`.
file_count=$(find "$MIGRATIONS_DIR" -maxdepth 1 -type f -name '*.sql' | wc -l | tr -d ' ')
tracked_count=$(psql -tAc "SELECT count(*) FROM public._cw_migrations" || echo "?")
echo "Migrations: $file_count file(s) found in $MIGRATIONS_DIR; $tracked_count already tracked in _cw_migrations."

# Determine whether any migrations on disk are not yet applied. One psql call
# fetches the full tracked set; we then check each file shell-side. Used to
# skip the storage-api wait loop on healthy re-runs where nothing changes.
tracked_names=$(psql -tAc "SELECT name FROM public._cw_migrations" 2>/dev/null | tr -d ' ' | grep -v '^$' || true)
needs_apply=0
for f in "$MIGRATIONS_DIR"/*.sql; do
  [ -f "$f" ] || continue
  if ! echo "$tracked_names" | grep -qx "$(basename "$f")"; then
    needs_apply=1
    break
  fi
done

# Wait for storage-api to finish its own schema migrations before running
# our migrations. Migrations 00007 and 00015 UPDATE storage.buckets columns
# (public, file_size_limit, allowed_mime_types) that storage-api adds on
# first boot. Without this wait, migrate can race storage-api and fail.
# Skip the wait entirely when nothing is unapplied — typical of every
# `docker compose up` after the first one.
if [ "$needs_apply" = "0" ]; then
  echo "All migrations already applied; skipping storage-api wait."
else
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
fi

for f in "$MIGRATIONS_DIR"/*.sql; do
  [ -f "$f" ] || continue
  name=$(basename "$f")
  applied=$(psql -tAc "SELECT 1 FROM public._cw_migrations WHERE name = '$name'" || echo "")
  if [ "$applied" != "1" ]; then
    echo "Applying migration: $name"
    current_migration="$name"
    psql -v ON_ERROR_STOP=1 <<EOSQL
BEGIN;
\i $f
INSERT INTO public._cw_migrations (name) VALUES ('$name');
COMMIT;
EOSQL
    current_migration=""
  else
    echo "Already applied: $name"
  fi
done

# End-of-run report — counts plus drift detection. Drift queries are suffixed
# with `|| true` so a transient psql failure here never trips the ERR trap or
# affects the exit code; the per-migration `psql -v ON_ERROR_STOP=1` above is
# the one that intentionally fails the script.
final_tracked=$(psql -tAc "SELECT count(*) FROM public._cw_migrations" || echo "?")
echo ""
echo "=========================================================="
echo "Migration runner complete."
echo "  Files in $MIGRATIONS_DIR: $file_count"
echo "  Tracked in _cw_migrations: $final_tracked"

# Drift detection: diff on-disk files against _cw_migrations rows. Done in
# shell via `comm` rather than dynamic SQL so filenames don't need escaping.
disk_list=$(find "$MIGRATIONS_DIR" -maxdepth 1 -type f -name '*.sql' -exec basename {} \; | sort)
tracked_list=$(psql -tAc "SELECT name FROM public._cw_migrations ORDER BY name" 2>/dev/null | sed 's/^[[:space:]]*//;s/[[:space:]]*$//' | grep -v '^$' || true)

# In tracked, not on disk — stale checkout indicator. Filter blank lines from
# `comm` output: when either input is empty, `echo ""` emits a newline that
# `comm` would otherwise pass through as a phantom entry on a fresh first run.
tracked_but_missing=$(comm -13 <(echo "$disk_list") <(echo "$tracked_list") | grep -v '^$' || true)
if [ -n "$tracked_but_missing" ]; then
  echo ""
  echo "WARNING: migrations tracked in DB but not present on disk:"
  echo "$tracked_but_missing" | sed 's/^/  - /'
  echo "  This usually means your host-mounted volumes/db/migrations/ is"
  echo "  older than the database. Run 'git pull' to refresh it."
fi

# On disk, not tracked — should be empty after a successful run.
unapplied=$(comm -23 <(echo "$disk_list") <(echo "$tracked_list") | grep -v '^$' || true)
if [ -n "$unapplied" ]; then
  echo ""
  echo "WARNING: migrations present on disk but not applied:"
  echo "$unapplied" | sed 's/^/  - /'
fi

echo "=========================================================="
