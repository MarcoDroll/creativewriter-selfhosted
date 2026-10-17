-- 00047: story cover gallery.
--
-- Brings the codex portrait-gallery model to story covers. Two additive columns
-- on public.stories:
--
--   cover_gallery  jsonb  -- [{ id, path, source, createdAt }] — up to 5 items,
--                            each referencing an object in the public story-media
--                            bucket by storage PATH (not inline bytes). Keeping
--                            the gallery out-of-row holds stories rows near their
--                            current ~100 KB, which matters because every stories
--                            write is broadcast whole-row over Realtime (~1 MB cap).
--   active_cover_id text   -- points at the active gallery item, whose base64 stays
--                            inline in the existing cover_image column (unchanged)
--                            so every current cover reader keeps working.
--
-- No SQL backfill: existing single-cover stories migrate lazily the first time the
-- user opens the cover picker (a backfill would bloat rows + trigger a Realtime
-- storm). No new GRANTs — the existing stories table grants (00042) cover new
-- columns. No storage/bucket change — reuses the public story-media bucket (00007).
--
-- Idempotency: add-column-if-not-exists → replay against an already-migrated schema
-- (the Migrations E2E "stuck-user" nightly) is a true no-op. Mirrors 00001/00045.

alter table public.stories add column if not exists cover_gallery jsonb default '[]';
alter table public.stories add column if not exists active_cover_id text;
