-- 00053: Fingerprint the prose a Scene Summary was written from, so the
-- outline can say when the summary has been outgrown by the scene.
--
-- `updated_at` cannot carry this. The set_updated_at trigger
-- (00001_initial_schema.sql) fires on ANY row update, including the one that
-- writes the summary itself, so a timestamp comparison can never distinguish
-- "the prose moved on" from "the summary was just saved".
--
-- Two columns instead of one, because a hash alone fires on every typo fix and
-- an advisory that fires constantly trains the author to ignore it. Drift is
-- read as: the hash differs AND the word count moved by more than
-- clamp(5% of the stored count, 20, 150) words.
--
-- NULL in either column means UNKNOWN, and the client renders unknown as
-- fresh. Every summary that exists today gets NULL; treating that as drift
-- would mark every summary in every story stale on first load. Existing
-- summaries become tracked the next time they are written.
--
-- The hash is taken over the scene's EXTRACTED PLAIN TEXT, not raw `content`:
-- content is ProseMirror-serialized, so hashing the markup would flip on
-- attribute order and mark nesting that change nothing a reader can see.
--
-- No new GRANTs: `scenes` is an existing frontend-facing table and already
-- carries the authenticated/service_role grants.
--
-- Replay-safe: `add column if not exists` on both, and the COMMENTs are
-- unconditional replacements. A second apply is a true no-op.

ALTER TABLE public.scenes
  ADD COLUMN IF NOT EXISTS summary_source_hash text;

ALTER TABLE public.scenes
  ADD COLUMN IF NOT EXISTS summary_source_words integer;

COMMENT ON COLUMN public.scenes.summary_source_hash IS
  'FNV-1a (32-bit, hex) of the scene prose as plain text at the moment the current summary was written. NULL means unknown, which the client renders as fresh.';

COMMENT ON COLUMN public.scenes.summary_source_words IS
  'Word count of that same prose at the moment the current summary was written. NULL means unknown, which the client renders as fresh.';
