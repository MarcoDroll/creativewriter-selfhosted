-- 00049: persist the story premise.
--
-- The "Full story from outline" wizard collects a free-text premise (the wizard's
-- `outline` field). Until now it was only handed to the planner/codex bootstrap
-- in-memory (consume-once, 30s TTL) and then discarded — never persisted. This adds
-- a dedicated nullable column so the premise survives the create flow and can drive
-- premise-aware cover generation.
--
--   premise  text  -- the free-text story premise the user seeded generation from
--                     (nullable; blank/no-premise stories store NULL).
--
-- No SQL backfill (existing stories simply have NULL). No new GRANTs — the existing
-- stories table grants (00042) already cover new columns; RLS (auth.uid() = user_id)
-- is unchanged. No view/function, so `npm run check:migrations` is unaffected.
--
-- Idempotency: add-column-if-not-exists → replay against an already-migrated schema
-- (the Migrations E2E "stuck-user" nightly) is a true no-op. Mirrors 00047.

alter table public.stories add column if not exists premise text;
