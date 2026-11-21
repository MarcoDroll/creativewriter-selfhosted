-- 00052: Unfreeze default template sections revised by the prompt-assembly
-- revision 2 (voice-match + anti-slop content pass; scene-from-outline
-- narrative-parameter labeling).
--
-- Same normalization as 00051: stories saved by clients older than 50e1f55
-- store verbatim copies of the then-current default section texts, freezing
-- them against later default improvements. For each (section set, field)
-- whose default text changes in this revision, blank the stored value to ''
-- when its trimmed text equals ANY prior default generation of that field
-- (pre-8f12ef0 and/or 8f12ef0 — fields differ in how many generations they
-- have). Literals are machine-generated from the real constants at those git
-- revisions (scratchpad generator, 00051 approach); customized texts never
-- match and are untouched; a transcription error matches nothing (fails safe).
--
-- The set_updated_at trigger is disabled around the UPDATEs so updated_at is
-- preserved (the story list orders by it). The whole body is one DO block: if
-- anything fails, the trigger disable rolls back with it.
--
-- Replay-safe: on re-apply the matched values are already "" (never in the
-- literal set), so every UPDATE touches 0 rows.
--
-- DISABLE TRIGGER takes SHARE ROW EXCLUSIVE on public.stories for the whole
-- transaction (all writes queue behind it). lock_timeout makes a lock conflict
-- fail fast (and roll back) instead of convoying every waiting query.

DO $migration$
BEGIN
  SET LOCAL lock_timeout = '2s';
  ALTER TABLE public.stories DISABLE TRIGGER set_updated_at;

  -- beatTemplateSections
  UPDATE public.stories
  SET settings = jsonb_set(settings, '{beatTemplateSections,userMessagePreamble}', '""'::jsonb)
  WHERE btrim(coalesce(settings#>>'{beatTemplateSections,userMessagePreamble}', ''), E' \t\n\r')
        IN ($txt$You are continuing a story. Here is the context:$txt$,
           $txt$You are continuing an ongoing story. Use the context below — it ends exactly where your continuation must begin.$txt$);
  UPDATE public.stories
  SET settings = jsonb_set(settings, '{beatTemplateSections,objective}', '""'::jsonb)
  WHERE btrim(coalesce(settings#>>'{beatTemplateSections,objective}', ''), E' \t\n\r')
        IN ($txt$Generate the next story beat that advances the narrative from the current scene's ending point.$txt$,
           $txt$Write the next story beat, continuing seamlessly from where the current scene text ends.
Do not recap, summarize, or rephrase existing content — pick up the narrative at that exact point and advance it.$txt$);
  UPDATE public.stories
  SET settings = jsonb_set(settings, '{beatTemplateSections,styleGuidance}', '""'::jsonb)
  WHERE btrim(coalesce(settings#>>'{beatTemplateSections,styleGuidance}', ''), E' \t\n\r')
        IN ($txt$Match the exact tone and narrative voice of the current scene
Maintain the established balance of dialogue, action, and introspection
End on a moment of significance, decision point, or natural transition$txt$,
           $txt$Match the tone, narrative voice, and pacing of the current scene
Maintain the established balance of dialogue, action, and introspection
Show character and emotion through action and dialogue rather than summary
End on a moment of significance, a decision point, or a natural transition$txt$);
  UPDATE public.stories
  SET settings = jsonb_set(settings, '{beatTemplateSections,constraints}', '""'::jsonb)
  WHERE btrim(coalesce(settings#>>'{beatTemplateSections,constraints}', ''), E' \t\n\r')
        IN ($txt$Do NOT resolve major plot threads or conflicts
Do NOT have characters act inconsistently with their established personalities
Do NOT introduce unrelated subplots or major new story elements
Do NOT write beyond what is specifically requested in the beat requirements$txt$,
           $txt$Do NOT resolve major plot threads or conflicts
Do NOT have characters act against their established personalities
Do NOT introduce unrelated subplots or major new story elements
Do NOT write beyond what the beat requirements ask for
Do NOT repeat or paraphrase text that already exists in the scene$txt$);
  UPDATE public.stories
  SET settings = jsonb_set(settings, '{beatTemplateSections,outputFormat}', '""'::jsonb)
  WHERE btrim(coalesce(settings#>>'{beatTemplateSections,outputFormat}', ''), E' \t\n\r')
        IN ($txt$Pure narrative prose. No meta-commentary, scene markers, chapter headings, or author notes.$txt$,
           $txt$Output only the beat's narrative prose. No meta-commentary, scene markers, chapter headings, titles, or author notes.$txt$);
  UPDATE public.stories
  SET settings = jsonb_set(settings, '{beatTemplateSections,generatePrompt}', '""'::jsonb)
  WHERE btrim(coalesce(settings#>>'{beatTemplateSections,generatePrompt}', ''), E' \t\n\r')
        IN ($txt$Generate the beat now:$txt$,
           $txt$Write the beat now:$txt$);

  -- sceneBeatTemplateSections
  UPDATE public.stories
  SET settings = jsonb_set(settings, '{sceneBeatTemplateSections,userMessagePreamble}', '""'::jsonb)
  WHERE btrim(coalesce(settings#>>'{sceneBeatTemplateSections,userMessagePreamble}', ''), E' \t\n\r')
        IN ($txt$You are continuing a story. Here is the context:$txt$,
           $txt$You are continuing an ongoing story. Use the context below — it ends exactly where your continuation must begin.$txt$);
  UPDATE public.stories
  SET settings = jsonb_set(settings, '{sceneBeatTemplateSections,objective}', '""'::jsonb)
  WHERE btrim(coalesce(settings#>>'{sceneBeatTemplateSections,objective}', ''), E' \t\n\r')
        IN ($txt$Expand this moment with rich detail, deepening the reader's immersion in the scene.
Focus on the immediate experience rather than advancing the plot.$txt$,
           $txt$Expand the current moment with rich, immersive detail, continuing seamlessly from where the scene text ends.
Deepen the reader's experience of this moment rather than advancing the plot.$txt$);
  UPDATE public.stories
  SET settings = jsonb_set(settings, '{sceneBeatTemplateSections,bridgingInstructions}', '""'::jsonb)
  WHERE btrim(coalesce(settings#>>'{sceneBeatTemplateSections,bridgingInstructions}', ''), E' \t\n\r')
        IN ($txt$Your generation must seamlessly connect to the existing text that follows. End in a way that flows naturally into this text.$txt$);
  UPDATE public.stories
  SET settings = jsonb_set(settings, '{sceneBeatTemplateSections,styleGuidance}', '""'::jsonb)
  WHERE btrim(coalesce(settings#>>'{sceneBeatTemplateSections,styleGuidance}', ''), E' \t\n\r')
        IN ($txt$Match the exact tone and narrative voice of the current scene
Maintain the established balance of dialogue, action, and introspection
Deepen the reader's connection to the viewpoint character$txt$,
           $txt$Match the tone, narrative voice, and pacing of the current scene
Maintain the established balance of dialogue, action, and introspection
Deepen the reader's connection to the viewpoint character$txt$);
  UPDATE public.stories
  SET settings = jsonb_set(settings, '{sceneBeatTemplateSections,constraints}', '""'::jsonb)
  WHERE btrim(coalesce(settings#>>'{sceneBeatTemplateSections,constraints}', ''), E' \t\n\r')
        IN ($txt$Stay within this moment - do NOT advance to new scenes or time jumps
Do NOT resolve conflicts or make major plot progress
Do NOT have characters act inconsistently with their established personalities
Do NOT introduce major new story elements
Match the exact tone and narrative voice$txt$,
           $txt$Stay within this moment - do NOT advance to new scenes or time jumps
Do NOT resolve conflicts or make major plot progress
Do NOT have characters act against their established personalities
Do NOT introduce major new story elements
Do NOT repeat or paraphrase text that already exists in the scene$txt$);
  UPDATE public.stories
  SET settings = jsonb_set(settings, '{sceneBeatTemplateSections,outputFormat}', '""'::jsonb)
  WHERE btrim(coalesce(settings#>>'{sceneBeatTemplateSections,outputFormat}', ''), E' \t\n\r')
        IN ($txt$Pure narrative prose. No meta-commentary, scene markers, chapter headings, or author notes.$txt$,
           $txt$Output only the beat's narrative prose. No meta-commentary, scene markers, chapter headings, titles, or author notes.$txt$);
  UPDATE public.stories
  SET settings = jsonb_set(settings, '{sceneBeatTemplateSections,generatePrompt}', '""'::jsonb)
  WHERE btrim(coalesce(settings#>>'{sceneBeatTemplateSections,generatePrompt}', ''), E' \t\n\r')
        IN ($txt$Generate the beat now:$txt$,
           $txt$Write the beat now:$txt$);

  -- envisionBeatTemplateSections
  UPDATE public.stories
  SET settings = jsonb_set(settings, '{envisionBeatTemplateSections,userMessagePreamble}', '""'::jsonb)
  WHERE btrim(coalesce(settings#>>'{envisionBeatTemplateSections,userMessagePreamble}', ''), E' \t\n\r')
        IN ($txt$You are continuing a story. Here is the context:$txt$,
           $txt$You are continuing an ongoing story. Use the context below — it ends exactly where your continuation must begin.$txt$);
  UPDATE public.stories
  SET settings = jsonb_set(settings, '{envisionBeatTemplateSections,styleGuidance}', '""'::jsonb)
  WHERE btrim(coalesce(settings#>>'{envisionBeatTemplateSections,styleGuidance}', ''), E' \t\n\r')
        IN ($txt$Match the exact tone and narrative voice of the current scene
Maintain the established balance of dialogue, action, and introspection
Create vivid, immersive prose that naturally fills the word count
Develop scenes, moments, and character interactions fully$txt$,
           $txt$Match the tone, narrative voice, and pacing of the current scene
Maintain the established balance of dialogue, action, and introspection
Create vivid, immersive prose that naturally fills the word count
Develop scenes, moments, and character interactions fully$txt$);
  UPDATE public.stories
  SET settings = jsonb_set(settings, '{envisionBeatTemplateSections,outputFormat}', '""'::jsonb)
  WHERE btrim(coalesce(settings#>>'{envisionBeatTemplateSections,outputFormat}', ''), E' \t\n\r')
        IN ($txt$Pure narrative prose. No meta-commentary, scene markers, chapter headings, or author notes.$txt$,
           $txt$Output only the beat's narrative prose. No meta-commentary, scene markers, chapter headings, titles, or author notes.$txt$);

  -- sceneFromOutlineTemplateSections
  UPDATE public.stories
  SET settings = jsonb_set(settings, '{sceneFromOutlineTemplateSections,narrativeParameters}', '""'::jsonb)
  WHERE btrim(coalesce(settings#>>'{sceneFromOutlineTemplateSections,narrativeParameters}', ''), E' \t\n\r')
        IN ($txt${pointOfView}
Approximately {wordCount} words
{tense}$txt$);
  UPDATE public.stories
  SET settings = jsonb_set(settings, '{sceneFromOutlineTemplateSections,styleGuidance}', '""'::jsonb)
  WHERE btrim(coalesce(settings#>>'{sceneFromOutlineTemplateSections,styleGuidance}', ''), E' \t\n\r')
        IN ($txt$Create a complete narrative arc within the scene
Balance dialogue, action, and introspection appropriately
Establish setting and atmosphere early
End with a sense of completion or meaningful transition
Match the tone and voice established in the story context$txt$);

  ALTER TABLE public.stories ENABLE TRIGGER set_updated_at;
END
$migration$;
