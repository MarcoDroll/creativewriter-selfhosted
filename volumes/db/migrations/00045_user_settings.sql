-- Per-user preferences persisted to the database (cross-device sync).
-- Single JSONB row per user; mirrors the existing `stories.settings jsonb` convention.
-- Only device-independent preferences are synced here (model selections, feature
-- overrides, favorites, appearance colors, language). Secrets (API keys, provider
-- config, premium license) and device-specific choices (background image) stay
-- local-only in localStorage and are never written to this table.
--
-- Idempotency: guarded so a replay against an already-migrated schema (e.g. the
-- stuck-user _cw_migrations recovery exercised by the Migrations E2E nightly) is
-- a no-op. Mirrors the if-not-exists / drop-if-exists convention used by 00010,
-- 00016, 00027, 00032, 00035, etc.

create table if not exists public.user_settings (
  user_id    uuid primary key references auth.users(id) on delete cascade,
  settings   jsonb not null default '{}',
  updated_at timestamptz not null default now()
);

alter table public.user_settings enable row level security;

drop policy if exists "Users manage own settings" on public.user_settings;
create policy "Users manage own settings"
  on public.user_settings for all
  using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop trigger if exists set_updated_at on public.user_settings;
create trigger set_updated_at before update on public.user_settings
  for each row execute function public.update_updated_at();

-- Data API visibility (required since 2026-05-30 — see coding-standards.md)
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.user_settings TO authenticated;
GRANT ALL                            ON TABLE public.user_settings TO service_role;
