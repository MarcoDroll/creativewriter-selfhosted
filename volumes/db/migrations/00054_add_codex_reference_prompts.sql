-- 00054: Persistent, per-target character reference prompts (image-generation only).
--
-- One independently-generated, persisted, editable prompt PER external image-generation
-- target (Stable Diffusion / SD3.5 / Illustrious / Flux.2 / Krea 2 / Z-Image Turbo /
-- Midjourney — see external-prompt-format.ts), keyed by target id, so a character's look
-- stays consistent across every future illustration instead of being redistilled per beat.
-- Tag-based targets also carry a persisted, AI-suggested negative prompt / quality prefix
-- inside the SAME per-target object — no separate column needed for that.
--
-- Deliberately its OWN top-level column, never folded into `metadata`. Every
-- text-generation prompt builder that reads a CodexEntry reads only NAMED
-- fields/metadata keys, except CodexContextService.buildSingleEntryXml's
-- `Object.entries(entry.metadata)` sweep, which is scoped to `metadata` and therefore
-- structurally cannot see a sibling top-level column. Folding this into `metadata` would
-- have required hand-adding it to that sweep's exclusion list — a top-level column needs
-- no such bookkeeping and can't be forgotten.
--
-- Replay-safe: `add column if not exists`.

ALTER TABLE public.codex_entries
  ADD COLUMN IF NOT EXISTS reference_prompts jsonb NOT NULL DEFAULT '{}';

COMMENT ON COLUMN public.codex_entries.reference_prompts IS
  'Per-target character reference prompts (+ optional AI-suggested negative prompt/quality prefix) for EXTERNAL image-generation tools ONLY, keyed by ExternalPromptTarget.id. NEVER read by a text-generation prompt builder.';
