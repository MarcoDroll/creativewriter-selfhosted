-- 00076: strip the untouched default beatGenerationTemplate from stories.settings (#828)
--
-- Nothing reads StorySettings.beatGenerationTemplate: generation builds from the section templates
-- (#816), and since #826 nothing writes it either. Every story created before that still carries
-- ~1.5 KB of the default XML in stories.settings, which StoryService.getAllStories reads wholesale
-- for every story on the list (and the codex-transfer modal for up to 1000) — PostgREST egress on
-- every read, roughly half of an average row's settings.
--
-- Removes the key ONLY where its trimmed value is one the app itself wrote: every version, from
-- git, of the six beat-generation*.template assets (the loader stored file.trim()), of the
-- DEFAULT_STORY_SETTINGS literal, and of the loader's hard-coded fallback — plus ''. A value the
-- author customised before section templates existed matches none of them and is left exactly as
-- it is; on an old story it may be their only copy.
--
-- Compared by md5 of the trimmed value: the hashes below were generated from git, never typed, and a
-- wrong one matches nothing (fails safe). Pre-flight 2026-10-30, read-only: prod 61 stories, every
-- one a shipped default (0 customised); dev 12 stories, 10 defaults, 2 customised (kept).
--
-- set_updated_at is disabled around the UPDATE so updated_at is preserved (the story list orders by
-- it). That ALTER takes SHARE ROW EXCLUSIVE on stories until COMMIT, blocking saves for the length
-- of one UPDATE over a few dozen rows; lock_timeout makes a conflict fail fast and roll back rather
-- than queue every save behind it. One DO block, so a failure rolls the trigger disable back too.
--
-- Realtime: one postgres_changes UPDATE per stripped row, to that row's owner's open sessions,
-- carrying the changed settings (unchanged TOASTed columns such as cover_image are not sent).
-- Clients apply it in memory; nothing refetches.
--
-- Replay-safe: a stripped row no longer has the key, so a second run updates 0 rows.

DO $migration$
BEGIN
  SET LOCAL lock_timeout = '2s';
  ALTER TABLE public.stories DISABLE TRIGGER set_updated_at;

  UPDATE public.stories
  SET settings = settings - 'beatGenerationTemplate'
  WHERE settings ? 'beatGenerationTemplate'
    AND md5(btrim(settings->>'beatGenerationTemplate', E' \t\n\r')) IN (
      'db39c897291f3f1bc858a18b5d0a2ddc', -- 1488 B  beat-generation-en@4487fd10
      '72224ce6075129be89f2f3c161471e29', -- 1581 B  beat-generation-de@4487fd10
      '9977200b04c490d2c26e78119181fa80', -- 1579 B  beat-generation-es@4487fd10
      '0fafd6aedd9f22beed6c426599c9e19a', -- 1612 B  beat-generation-fr@4487fd10
      '964083fa878bed07c7a2621f60d17366', --  534 B  beat-generation-custom@4487fd10
      'c54929a572c3aad342ffdea0d110e47a', --  313 B  beat-generation@4487fd10
      '3a5080e147d643a92360026ffec0dc4f', -- 1152 B  DEFAULT_STORY_SETTINGS@f67b65d0 (+18 identical)
      '307aae16b1141cdd82ed57c3c94e7f35', -- 1477 B  loader-fallback@35a053fe (+2 identical)
      'd41d8cd98f00b204e9800998ecf8427e'  --    0 B  empty
    );

  ALTER TABLE public.stories ENABLE TRIGGER set_updated_at;
END
$migration$;
