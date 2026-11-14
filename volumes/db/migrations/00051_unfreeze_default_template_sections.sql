-- 00051: Retroactively unfreeze default template sections.
--
-- Before commit 8f12ef0 (2026-07-15), saving story settings stored verbatim
-- copies of the then-current default template section texts in
-- stories.settings->'<set>'-><field>. The merge helpers prefer stored
-- non-empty values, so those stories were frozen on the old default texts
-- and never received later default improvements. The app now stores ''
-- for sections equal to the default; this migration applies the same
-- normalization to data at rest.
--
-- For each (section set, field), blank the stored value to '' when its
-- trimmed text equals the pre-8f12ef0 default or the current default for
-- that exact field. Customized (non-default) texts never match and are
-- untouched. A transcription error in a literal matches nothing (fails safe).
--
-- The set_updated_at trigger is disabled around the UPDATEs so updated_at
-- is preserved (the story list orders by it). The whole body is one DO
-- block: if anything fails, the trigger disable rolls back with it.
--
-- Replay-safe: on re-apply the matched values are already "" (never in the
-- literal set), so every UPDATE touches 0 rows.

DO $migration$
BEGIN
  ALTER TABLE public.stories DISABLE TRIGGER set_updated_at;

  -- beatTemplateSections (DEFAULT_BEAT_TEMPLATE_SECTIONS)
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
  SET settings = jsonb_set(settings, '{beatTemplateSections,narrativeParameters}', '""'::jsonb)
  WHERE btrim(coalesce(settings#>>'{beatTemplateSections,narrativeParameters}', ''), E' \t\n\r')
        IN ($txt${pointOfView}
{wordCount} words (±50 words acceptable)
{tense}$txt$,
           $txt$Point of view: {pointOfView}
Length: about {wordCount} words (±50 is fine; end at a natural stopping point)
Tense: {tense}$txt$);
  UPDATE public.stories
  SET settings = jsonb_set(settings, '{beatTemplateSections,stagingNotes}', '""'::jsonb)
  WHERE btrim(coalesce(settings#>>'{beatTemplateSections,stagingNotes}', ''), E' \t\n\r')
        IN ($txt$Consider these staging notes for physical and contextual consistency:$txt$);
  UPDATE public.stories
  SET settings = jsonb_set(settings, '{beatTemplateSections,beatRequirements}', '""'::jsonb)
  WHERE btrim(coalesce(settings#>>'{beatTemplateSections,beatRequirements}', ''), E' \t\n\r')
        IN ($txt${prompt}$txt$);
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

  -- sceneBeatTemplateSections (DEFAULT_SCENE_BEAT_TEMPLATE_SECTIONS)
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
  SET settings = jsonb_set(settings, '{sceneBeatTemplateSections,narrativeParameters}', '""'::jsonb)
  WHERE btrim(coalesce(settings#>>'{sceneBeatTemplateSections,narrativeParameters}', ''), E' \t\n\r')
        IN ($txt${pointOfView}
{wordCount} words (±50 words acceptable)
{tense}$txt$,
           $txt$Point of view: {pointOfView}
Length: about {wordCount} words (±50 is fine; end at a natural stopping point)
Tense: {tense}$txt$);
  UPDATE public.stories
  SET settings = jsonb_set(settings, '{sceneBeatTemplateSections,stagingNotes}', '""'::jsonb)
  WHERE btrim(coalesce(settings#>>'{sceneBeatTemplateSections,stagingNotes}', ''), E' \t\n\r')
        IN ($txt$Consider these staging notes for physical and contextual consistency:$txt$);
  UPDATE public.stories
  SET settings = jsonb_set(settings, '{sceneBeatTemplateSections,beatRequirements}', '""'::jsonb)
  WHERE btrim(coalesce(settings#>>'{sceneBeatTemplateSections,beatRequirements}', ''), E' \t\n\r')
        IN ($txt${prompt}$txt$);
  UPDATE public.stories
  SET settings = jsonb_set(settings, '{sceneBeatTemplateSections,focusAreas}', '""'::jsonb)
  WHERE btrim(coalesce(settings#>>'{sceneBeatTemplateSections,focusAreas}', ''), E' \t\n\r')
        IN ($txt$Internal character thoughts and emotional reactions
Sensory details - sight, sound, touch, smell, taste
Micro-actions and body language
Atmosphere and mood of the moment
Subtext in dialogue (if present)$txt$);
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

  -- envisionBeatTemplateSections (DEFAULT_ENVISION_BEAT_TEMPLATE_SECTIONS)
  UPDATE public.stories
  SET settings = jsonb_set(settings, '{envisionBeatTemplateSections,userMessagePreamble}', '""'::jsonb)
  WHERE btrim(coalesce(settings#>>'{envisionBeatTemplateSections,userMessagePreamble}', ''), E' \t\n\r')
        IN ($txt$You are continuing a story. Here is the context:$txt$,
           $txt$You are continuing an ongoing story. Use the context below — it ends exactly where your continuation must begin.$txt$);
  UPDATE public.stories
  SET settings = jsonb_set(settings, '{envisionBeatTemplateSections,objective}', '""'::jsonb)
  WHERE btrim(coalesce(settings#>>'{envisionBeatTemplateSections,objective}', ''), E' \t\n\r')
        IN ($txt$Use the beat prompt as a creative direction and envision rich, detailed content.
Your goal is to fill the targeted word count with compelling narrative that flows from this direction.
Do not limit yourself to the literal prompt - expand and develop the content creatively while staying true to the story's characters and world.$txt$);
  UPDATE public.stories
  SET settings = jsonb_set(settings, '{envisionBeatTemplateSections,narrativeParameters}', '""'::jsonb)
  WHERE btrim(coalesce(settings#>>'{envisionBeatTemplateSections,narrativeParameters}', ''), E' \t\n\r')
        IN ($txt${pointOfView}
{wordCount} words - fill this word count target with quality, detailed content
{tense}$txt$,
           $txt$Point of view: {pointOfView}
Length: {wordCount} words - fill this word count target with quality, detailed content
Tense: {tense}$txt$);
  UPDATE public.stories
  SET settings = jsonb_set(settings, '{envisionBeatTemplateSections,stagingNotes}', '""'::jsonb)
  WHERE btrim(coalesce(settings#>>'{envisionBeatTemplateSections,stagingNotes}', ''), E' \t\n\r')
        IN ($txt$Consider these staging notes for physical and contextual consistency:$txt$);
  UPDATE public.stories
  SET settings = jsonb_set(settings, '{envisionBeatTemplateSections,beatRequirements}', '""'::jsonb)
  WHERE btrim(coalesce(settings#>>'{envisionBeatTemplateSections,beatRequirements}', ''), E' \t\n\r')
        IN ($txt${prompt}$txt$);
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
  SET settings = jsonb_set(settings, '{envisionBeatTemplateSections,constraints}', '""'::jsonb)
  WHERE btrim(coalesce(settings#>>'{envisionBeatTemplateSections,constraints}', ''), E' \t\n\r')
        IN ($txt$Do NOT have characters act inconsistently with their established personalities
Do NOT introduce elements that contradict established story facts
Maintain narrative coherence with the existing story$txt$,
           $txt$Do NOT have characters act against their established personalities
Do NOT introduce elements that contradict established story facts
Maintain narrative coherence with the existing story$txt$);
  UPDATE public.stories
  SET settings = jsonb_set(settings, '{envisionBeatTemplateSections,outputFormat}', '""'::jsonb)
  WHERE btrim(coalesce(settings#>>'{envisionBeatTemplateSections,outputFormat}', ''), E' \t\n\r')
        IN ($txt$Pure narrative prose. No meta-commentary, scene markers, chapter headings, or author notes.$txt$,
           $txt$Output only the beat's narrative prose. No meta-commentary, scene markers, chapter headings, titles, or author notes.$txt$);
  UPDATE public.stories
  SET settings = jsonb_set(settings, '{envisionBeatTemplateSections,generatePrompt}', '""'::jsonb)
  WHERE btrim(coalesce(settings#>>'{envisionBeatTemplateSections,generatePrompt}', ''), E' \t\n\r')
        IN ($txt$Generate the beat now:$txt$,
           $txt$Write the beat now:$txt$);

  -- sceneFromOutlineTemplateSections (DEFAULT_SCENE_FROM_OUTLINE_TEMPLATE_SECTIONS)
  UPDATE public.stories
  SET settings = jsonb_set(settings, '{sceneFromOutlineTemplateSections,userMessagePreamble}', '""'::jsonb)
  WHERE btrim(coalesce(settings#>>'{sceneFromOutlineTemplateSections,userMessagePreamble}', ''), E' \t\n\r')
        IN ($txt$You are writing a complete scene for a story.$txt$);
  UPDATE public.stories
  SET settings = jsonb_set(settings, '{sceneFromOutlineTemplateSections,objective}', '""'::jsonb)
  WHERE btrim(coalesce(settings#>>'{sceneFromOutlineTemplateSections,objective}', ''), E' \t\n\r')
        IN ($txt$Write a complete, self-contained scene based on the provided outline. This is a full scene generation, not a continuation of existing content.$txt$);
  UPDATE public.stories
  SET settings = jsonb_set(settings, '{sceneFromOutlineTemplateSections,narrativeParameters}', '""'::jsonb)
  WHERE btrim(coalesce(settings#>>'{sceneFromOutlineTemplateSections,narrativeParameters}', ''), E' \t\n\r')
        IN ($txt${pointOfView}
Approximately {wordCount} words
{tense}$txt$);
  UPDATE public.stories
  SET settings = jsonb_set(settings, '{sceneFromOutlineTemplateSections,sceneOutline}', '""'::jsonb)
  WHERE btrim(coalesce(settings#>>'{sceneFromOutlineTemplateSections,sceneOutline}', ''), E' \t\n\r')
        IN ($txt${sceneOutline}$txt$);
  UPDATE public.stories
  SET settings = jsonb_set(settings, '{sceneFromOutlineTemplateSections,styleGuidance}', '""'::jsonb)
  WHERE btrim(coalesce(settings#>>'{sceneFromOutlineTemplateSections,styleGuidance}', ''), E' \t\n\r')
        IN ($txt$Create a complete narrative arc within the scene
Balance dialogue, action, and introspection appropriately
Establish setting and atmosphere early
End with a sense of completion or meaningful transition
Match the tone and voice established in the story context$txt$);
  UPDATE public.stories
  SET settings = jsonb_set(settings, '{sceneFromOutlineTemplateSections,outputFormat}', '""'::jsonb)
  WHERE btrim(coalesce(settings#>>'{sceneFromOutlineTemplateSections,outputFormat}', ''), E' \t\n\r')
        IN ($txt$Pure narrative prose. No meta-commentary, scene markers, chapter headings, or author notes.$txt$);
  UPDATE public.stories
  SET settings = jsonb_set(settings, '{sceneFromOutlineTemplateSections,generatePrompt}', '""'::jsonb)
  WHERE btrim(coalesce(settings#>>'{sceneFromOutlineTemplateSections,generatePrompt}', ''), E' \t\n\r')
        IN ($txt$Generate the complete scene now:$txt$);

  ALTER TABLE public.stories ENABLE TRIGGER set_updated_at;
END
$migration$;
