-- ============================================================================
-- 00055: provenance for a generated illustration
--
-- "Illustrate this moment" composes a prompt from a line-up, sends it with up to four reference
-- portraits, and shows the author a receipt of exactly what went out. Until now that receipt lived
-- only in the modal's memory, so inserting the picture and reloading lost the only record of how
-- it was made — which model, which characters, which lever carried each likeness.
--
-- Nullable, and it stays null for every image that is not a generated illustration (uploads,
-- pastes, imports). Text only: the reference bytes are NOT stored here — see
-- `src/app/shared/models/illustration-receipt.ts` for the shape and why it is not the live one.
--
-- No new grants: 00042 grants on the table, which covers its columns. No index: nothing queries by
-- it, it is read alongside the row it belongs to.
-- ============================================================================

ALTER TABLE public.story_images
  ADD COLUMN IF NOT EXISTS illustration_receipt jsonb;

COMMENT ON COLUMN public.story_images.illustration_receipt IS
  'What a generated illustration was made from: prompt, segments, line-up, endpoint. Null for uploaded images.';
