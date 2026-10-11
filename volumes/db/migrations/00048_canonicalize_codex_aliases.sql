-- Canonicalize legacy string[] codex aliases to the comma-string shape.
--
-- Background: metadata.aliases has historically been persisted in two shapes — a
-- comma-joined STRING (AI bible import, the entry editor's canonical write shape, and
-- now the NovelCrafter importer) and a STRING ARRAY (legacy NovelCrafter imports, e.g.
-- `["der Hexer", "Weißhaar"]`). Every consumer reads through `coerceAliases`, which is
-- shape-agnostic, so this migration is PURELY data cleanup — no behavior change — that
-- makes the stored data uniform and lets a future change drop the array branch. Empty /
-- blank arrays lose the key entirely, matching the editor + importer "omit when empty".
--
-- Comma-safety: an array element whose text contains a comma (e.g. `["von Clausewitz, Karl"]`)
-- can't be represented as a comma-string — joining it would let coerceAliases split it into
-- two aliases on read. The array shape reads correctly, so we leave those rare rows as arrays
-- (coerceAliases is shape-agnostic) rather than corrupt them.
--
-- Idempotency / replay-safety: guarded on `jsonb_typeof(metadata->'aliases') = 'array'` (plus
-- the comma guard). Once the convertible arrays are converted they are strings, and the
-- comma-bearing ones are permanently excluded, so a replay (fresh DB or the stuck-user
-- `_cw_migrations` recovery the Migrations E2E exercises) matches zero convertible rows and is
-- a true no-op. The `information_schema` table guard mirrors the 00040 backfill pattern.

DO $migration$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'codex_entries'
  ) THEN
    UPDATE public.codex_entries AS e
    SET metadata = CASE
        -- Empty or all-blank array → drop the key (canonical "no aliases").
        WHEN c.joined = '' THEN e.metadata - 'aliases'
        -- Otherwise store the trimmed, blank-free comma-string. coerceAliases still
        -- dedupes case-insensitively on read, so no dedup is needed here.
        ELSE jsonb_set(e.metadata, '{aliases}', to_jsonb(c.joined))
      END
    FROM (
      SELECT
        id,
        COALESCE((
          SELECT string_agg(a.v, ', ')
          FROM (
            SELECT trim(elem) AS v
            FROM jsonb_array_elements_text(metadata->'aliases') AS elem
          ) AS a
          WHERE a.v <> ''
        ), '') AS joined
      FROM public.codex_entries
      WHERE jsonb_typeof(metadata->'aliases') = 'array'
        -- Leave arrays with a comma-bearing element untouched (see header) — no corruption.
        AND NOT EXISTS (
          SELECT 1 FROM jsonb_array_elements_text(metadata->'aliases') AS elem
          WHERE position(',' IN elem) > 0
        )
    ) AS c
    WHERE e.id = c.id;
  END IF;
END
$migration$;
