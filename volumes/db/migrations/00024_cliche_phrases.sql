-- =============================================================================
-- Migration 00024: Cliché Phrases & Per-Story Cliché Index
-- =============================================================================
-- Two tables:
--   1. cliche_phrases    — global reference of known clichés (multi-language)
--   2. story_cliche_index — per-story auto-detected + user-entered clichés
-- Plus an RPC for atomic replacement that preserves user entries.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- Table 1: cliche_phrases (global reference, read-only for users)
-- ---------------------------------------------------------------------------

CREATE TABLE public.cliche_phrases (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  language TEXT NOT NULL DEFAULT 'en',
  category TEXT NOT NULL,
  phrase TEXT NOT NULL,
  description TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.cliche_phrases ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated users can read cliche phrases"
  ON public.cliche_phrases FOR SELECT TO authenticated USING (true);

CREATE INDEX idx_cliche_phrases_lang_cat ON public.cliche_phrases(language, category);

-- ---------------------------------------------------------------------------
-- Table 2: story_cliche_index (per-story detections + user entries)
-- ---------------------------------------------------------------------------

CREATE TABLE public.story_cliche_index (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  story_id UUID NOT NULL REFERENCES public.stories(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  phrase TEXT NOT NULL CHECK (length(phrase) <= 500),
  category TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'text_match' CHECK (source IN ('text_match', 'llm_detected', 'user')),
  occurrence_count INT NOT NULL DEFAULT 1 CHECK (occurrence_count >= 1),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.story_cliche_index ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users own their story cliche index"
  ON public.story_cliche_index FOR ALL
  USING ((select auth.uid()) = user_id)
  WITH CHECK ((select auth.uid()) = user_id);

-- Case-insensitive uniqueness per story (also serves as story_id lookup index)
CREATE UNIQUE INDEX idx_story_cliche_unique_phrase
  ON public.story_cliche_index (story_id, lower(phrase));

-- RLS performance index
CREATE INDEX idx_story_cliche_index_user ON public.story_cliche_index(user_id);

-- ---------------------------------------------------------------------------
-- RPC: Atomic replacement of auto-detected entries (preserves user entries)
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.replace_story_cliche_index(
  p_story_id UUID,
  p_entries JSONB
)
RETURNS INT
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_user_id UUID := auth.uid();
  v_count INT;
BEGIN
  -- Input validation
  IF p_entries IS NULL THEN RETURN 0; END IF;
  IF jsonb_typeof(p_entries) != 'array' THEN
    RAISE EXCEPTION 'p_entries must be a JSON array'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF jsonb_array_length(p_entries) > 500 THEN
    RAISE EXCEPTION 'Maximum 500 entries per call'
      USING ERRCODE = 'check_violation';
  END IF;

  -- Verify caller owns the story
  IF NOT EXISTS (
    SELECT 1 FROM public.stories WHERE id = p_story_id AND user_id = v_user_id
  ) THEN
    RAISE EXCEPTION 'Story not found or access denied'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- Only delete auto-detected entries; preserve user-entered ones
  DELETE FROM story_cliche_index
  WHERE story_id = p_story_id AND user_id = v_user_id AND source != 'user';

  -- Insert with source whitelisted (never accept 'user' from JSONB input)
  INSERT INTO story_cliche_index (story_id, user_id, phrase, category, source, occurrence_count)
  SELECT
    p_story_id,
    v_user_id,
    e->>'phrase',
    e->>'category',
    CASE WHEN e->>'source' IN ('text_match', 'llm_detected') THEN e->>'source' ELSE 'text_match' END,
    COALESCE((e->>'occurrence_count')::INT, 1)
  FROM jsonb_array_elements(p_entries) AS e
  WHERE e->>'phrase' IS NOT NULL
    AND length(e->>'phrase') <= 500
    AND e->>'category' IS NOT NULL
  ON CONFLICT (story_id, lower(phrase)) DO UPDATE SET
    category = CASE
      WHEN story_cliche_index.source = 'user' THEN story_cliche_index.category
      ELSE EXCLUDED.category
    END,
    source = CASE
      WHEN story_cliche_index.source = 'user' THEN 'user'
      ELSE EXCLUDED.source
    END,
    occurrence_count = CASE
      WHEN story_cliche_index.source = 'user' THEN story_cliche_index.occurrence_count
      ELSE EXCLUDED.occurrence_count
    END;

  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;

GRANT EXECUTE ON FUNCTION public.replace_story_cliche_index TO authenticated;

-- ---------------------------------------------------------------------------
-- Seed data: English clichés
-- ---------------------------------------------------------------------------

INSERT INTO public.cliche_phrases (language, category, phrase, description) VALUES
-- emotion_telling
('en', 'emotion_telling', 'heart pounded', 'Tells emotion instead of showing it'),
('en', 'emotion_telling', 'blood ran cold', 'Tells emotion instead of showing it'),
('en', 'emotion_telling', 'stomach dropped', 'Tells emotion instead of showing it'),
('en', 'emotion_telling', 'breath caught in her throat', 'Tells emotion instead of showing it'),
('en', 'emotion_telling', 'pulse quickened', 'Tells emotion instead of showing it'),
('en', 'emotion_telling', 'heart skipped a beat', 'Tells emotion instead of showing it'),
('en', 'emotion_telling', 'blood boiled', 'Tells emotion instead of showing it'),
('en', 'emotion_telling', 'bile rose in his throat', 'Tells emotion instead of showing it'),
('en', 'emotion_telling', 'knot in her stomach', 'Tells emotion instead of showing it'),
('en', 'emotion_telling', 'heart sank', 'Tells emotion instead of showing it'),
-- eye_descriptions
('en', 'eye_descriptions', 'piercing gaze', 'Overused eye metaphor'),
('en', 'eye_descriptions', 'eyes sparkled', 'Overused eye metaphor'),
('en', 'eye_descriptions', 'eyes widened in shock', 'Overused eye metaphor'),
('en', 'eye_descriptions', 'locked eyes', 'Overused eye metaphor'),
('en', 'eye_descriptions', 'eyes bored into', 'Overused eye metaphor'),
('en', 'eye_descriptions', 'eyes darkened', 'Overused eye metaphor'),
('en', 'eye_descriptions', 'orbs', 'Overused synonym for eyes'),
('en', 'eye_descriptions', 'pools of blue', 'Overused eye metaphor'),
('en', 'eye_descriptions', 'searched his eyes', 'Overused eye metaphor'),
('en', 'eye_descriptions', 'steely gaze', 'Overused eye metaphor'),
-- physical_reactions
('en', 'physical_reactions', 'clenched his fists', 'Stock body language'),
('en', 'physical_reactions', 'jaw tightened', 'Stock body language'),
('en', 'physical_reactions', 'let out a breath she didn''t know she was holding', 'Extremely overused physical reaction'),
('en', 'physical_reactions', 'swallowed hard', 'Stock body language'),
('en', 'physical_reactions', 'squared his shoulders', 'Stock body language'),
('en', 'physical_reactions', 'gritted her teeth', 'Stock body language'),
('en', 'physical_reactions', 'spine tingled', 'Stock body language'),
('en', 'physical_reactions', 'hands trembled', 'Stock body language'),
('en', 'physical_reactions', 'rolled her eyes', 'Stock body language'),
('en', 'physical_reactions', 'raised an eyebrow', 'Stock body language'),
-- environment_mood
('en', 'environment_mood', 'dark and stormy night', 'Classic weather cliché'),
('en', 'environment_mood', 'silence was deafening', 'Overused oxymoron'),
('en', 'environment_mood', 'shadows danced', 'Overused environment personification'),
('en', 'environment_mood', 'wind howled', 'Overused weather personification'),
('en', 'environment_mood', 'eerie silence fell', 'Overused mood setting'),
('en', 'environment_mood', 'sun smiled down', 'Overused weather personification'),
('en', 'environment_mood', 'rain lashed the windows', 'Overused weather description'),
('en', 'environment_mood', 'chill ran through the air', 'Overused mood setting'),
('en', 'environment_mood', 'moonlight bathed', 'Overused lighting description'),
('en', 'environment_mood', 'thick with tension', 'Overused atmosphere description'),
-- dialogue_tags
('en', 'dialogue_tags', 'he growled', 'Overused speech attribution'),
('en', 'dialogue_tags', 'she purred', 'Overused speech attribution'),
('en', 'dialogue_tags', 'he barked', 'Overused speech attribution'),
('en', 'dialogue_tags', 'she hissed', 'Overused speech attribution'),
('en', 'dialogue_tags', 'he breathed', 'Overused speech attribution'),
('en', 'dialogue_tags', 'she murmured seductively', 'Overused speech attribution'),
('en', 'dialogue_tags', 'he spat', 'Overused speech attribution'),
('en', 'dialogue_tags', 'she snapped', 'Overused speech attribution'),
-- fight_action
('en', 'fight_action', 'time seemed to slow', 'Overused action cliché'),
('en', 'fight_action', 'adrenaline surged', 'Overused action cliché'),
('en', 'fight_action', 'everything went black', 'Overused action cliché'),
('en', 'fight_action', 'moved with catlike grace', 'Overused action description'),
('en', 'fight_action', 'lightning-fast reflexes', 'Overused action description'),
('en', 'fight_action', 'blur of motion', 'Overused action description'),
('en', 'fight_action', 'dodged at the last second', 'Overused action cliché'),
('en', 'fight_action', 'saw red', 'Overused anger cliché'),
-- romance
('en', 'romance', 'electricity crackled between them', 'Overused romance cliché'),
('en', 'romance', 'skin tingled where he touched', 'Overused romance cliché'),
('en', 'romance', 'butterflies in her stomach', 'Overused romance cliché'),
('en', 'romance', 'tucked a strand of hair behind her ear', 'Overused romantic gesture'),
('en', 'romance', 'lips met in a passionate kiss', 'Overused romance cliché'),
('en', 'romance', 'his musky scent', 'Overused romance description'),
('en', 'romance', 'melted into his arms', 'Overused romance cliché'),
('en', 'romance', 'lost in her eyes', 'Overused romance cliché'),
-- death_grief
('en', 'death_grief', 'light faded from his eyes', 'Overused death cliché'),
('en', 'death_grief', 'single tear rolled down', 'Overused grief cliché'),
('en', 'death_grief', 'time stood still', 'Overused shock/grief cliché'),
('en', 'death_grief', 'collapsed to her knees', 'Overused grief reaction'),
('en', 'death_grief', 'gone to a better place', 'Overused death euphemism'),
('en', 'death_grief', 'numb with grief', 'Overused grief cliché'),
('en', 'death_grief', 'world shattered', 'Overused grief metaphor'),
('en', 'death_grief', 'tears streamed down', 'Overused grief cliché'),
-- internal_monologue
('en', 'internal_monologue', 'little did she know', 'Overused narrative intrusion'),
('en', 'internal_monologue', 'pushed the thought away', 'Overused thought cliché'),
('en', 'internal_monologue', 'couldn''t shake the feeling', 'Overused thought cliché'),
('en', 'internal_monologue', 'something stirred inside', 'Overused internal sensation'),
('en', 'internal_monologue', 'voice in the back of her mind', 'Overused thought cliché'),
('en', 'internal_monologue', 'if only he had known', 'Overused narrative intrusion'),
('en', 'internal_monologue', 'mind raced', 'Overused thought cliché'),
('en', 'internal_monologue', 'pit of her stomach', 'Overused internal sensation'),
-- purple_prose
('en', 'purple_prose', 'gossamer threads of moonlight', 'Melodramatic overwriting'),
('en', 'purple_prose', 'velvet darkness', 'Melodramatic overwriting'),
('en', 'purple_prose', 'crimson tide of rage', 'Melodramatic overwriting'),
('en', 'purple_prose', 'symphony of', 'Melodramatic overwriting'),
('en', 'purple_prose', 'tapestry of emotions', 'Melodramatic overwriting'),
('en', 'purple_prose', 'cruel hand of fate', 'Melodramatic overwriting'),
('en', 'purple_prose', 'inky blackness', 'Melodramatic overwriting'),
('en', 'purple_prose', 'pregnant pause', 'Melodramatic overwriting');

-- ---------------------------------------------------------------------------
-- Seed data: German clichés
-- ---------------------------------------------------------------------------

INSERT INTO public.cliche_phrases (language, category, phrase, description) VALUES
('de', 'emotion_telling', 'Herz hämmerte', 'Erzählt Emotion statt sie zu zeigen'),
('de', 'emotion_telling', 'Blut gefror in den Adern', 'Erzählt Emotion statt sie zu zeigen'),
('de', 'emotion_telling', 'Magen drehte sich um', 'Erzählt Emotion statt sie zu zeigen'),
('de', 'emotion_telling', 'stockte der Atem', 'Erzählt Emotion statt sie zu zeigen'),
('de', 'emotion_telling', 'Herz schlug schneller', 'Erzählt Emotion statt sie zu zeigen'),
('de', 'emotion_telling', 'Herz setzte einen Schlag aus', 'Erzählt Emotion statt sie zu zeigen'),
('de', 'emotion_telling', 'Blut kochte', 'Erzählt Emotion statt sie zu zeigen'),
('de', 'emotion_telling', 'Kloß im Hals', 'Erzählt Emotion statt sie zu zeigen'),
('de', 'eye_descriptions', 'durchdringender Blick', 'Überstrapazierte Augenmetapher'),
('de', 'eye_descriptions', 'Augen funkelten', 'Überstrapazierte Augenmetapher'),
('de', 'eye_descriptions', 'Augen weiteten sich', 'Überstrapazierte Augenmetapher'),
('de', 'eye_descriptions', 'Blicke kreuzten sich', 'Überstrapazierte Augenmetapher'),
('de', 'eye_descriptions', 'stählerner Blick', 'Überstrapazierte Augenmetapher'),
('de', 'physical_reactions', 'ballte die Fäuste', 'Standardisierte Körpersprache'),
('de', 'physical_reactions', 'Kiefer spannte sich an', 'Standardisierte Körpersprache'),
('de', 'physical_reactions', 'schluckte schwer', 'Standardisierte Körpersprache'),
('de', 'physical_reactions', 'straffte die Schultern', 'Standardisierte Körpersprache'),
('de', 'physical_reactions', 'Hände zitterten', 'Standardisierte Körpersprache'),
('de', 'physical_reactions', 'verdrehte die Augen', 'Standardisierte Körpersprache'),
('de', 'environment_mood', 'dunkle und stürmische Nacht', 'Klassisches Wetterklischee'),
('de', 'environment_mood', 'ohrenbetäubende Stille', 'Überstrapaziertes Oxymoron'),
('de', 'environment_mood', 'Schatten tanzten', 'Überstrapazierte Personifikation'),
('de', 'environment_mood', 'Wind heulte', 'Überstrapazierte Personifikation'),
('de', 'environment_mood', 'unheimliche Stille', 'Überstrapaziertes Stimmungsbild'),
('de', 'environment_mood', 'Mondlicht badete', 'Überstrapazierte Lichtbeschreibung'),
('de', 'dialogue_tags', 'knurrte er', 'Überstrapaziertes Dialogattribut'),
('de', 'dialogue_tags', 'schnurrte sie', 'Überstrapaziertes Dialogattribut'),
('de', 'dialogue_tags', 'bellte er', 'Überstrapaziertes Dialogattribut'),
('de', 'dialogue_tags', 'zischte sie', 'Überstrapaziertes Dialogattribut'),
('de', 'dialogue_tags', 'fauchte er', 'Überstrapaziertes Dialogattribut'),
('de', 'fight_action', 'Zeit schien stillzustehen', 'Überstrapaziertes Action-Klischee'),
('de', 'fight_action', 'Adrenalin schoss ein', 'Überstrapaziertes Action-Klischee'),
('de', 'fight_action', 'alles wurde schwarz', 'Überstrapaziertes Action-Klischee'),
('de', 'fight_action', 'katzenhafte Geschmeidigkeit', 'Überstrapazierte Action-Beschreibung'),
('de', 'romance', 'Spannung knisterte zwischen ihnen', 'Überstrapaziertes Liebesklischee'),
('de', 'romance', 'Schmetterlinge im Bauch', 'Überstrapaziertes Liebesklischee'),
('de', 'romance', 'strich eine Haarsträhne hinters Ohr', 'Überstrapazierte romantische Geste'),
('de', 'romance', 'schmolz in seinen Armen', 'Überstrapaziertes Liebesklischee'),
('de', 'death_grief', 'Licht erlosch in seinen Augen', 'Überstrapaziertes Todesklischee'),
('de', 'death_grief', 'einzelne Träne rollte herunter', 'Überstrapaziertes Trauerklischee'),
('de', 'death_grief', 'Welt brach zusammen', 'Überstrapazierte Trauermetapher'),
('de', 'death_grief', 'sank auf die Knie', 'Überstrapazierte Trauerreaktion'),
('de', 'internal_monologue', 'ahnte sie nicht', 'Überstrapazierter erzählerischer Eingriff'),
('de', 'internal_monologue', 'verdrängte den Gedanken', 'Überstrapaziertes Denkklischee'),
('de', 'internal_monologue', 'konnte das Gefühl nicht abschütteln', 'Überstrapaziertes Denkklischee'),
('de', 'internal_monologue', 'Gedanken rasten', 'Überstrapaziertes Denkklischee'),
('de', 'purple_prose', 'samtene Dunkelheit', 'Melodramatisches Überschreiben'),
('de', 'purple_prose', 'grausame Hand des Schicksals', 'Melodramatisches Überschreiben'),
('de', 'purple_prose', 'Symphonie der Farben', 'Melodramatisches Überschreiben');

-- ---------------------------------------------------------------------------
-- Seed data: French clichés
-- ---------------------------------------------------------------------------

INSERT INTO public.cliche_phrases (language, category, phrase, description) VALUES
('fr', 'emotion_telling', 'cœur battait la chamade', 'Raconte l''émotion au lieu de la montrer'),
('fr', 'emotion_telling', 'sang se glaça', 'Raconte l''émotion au lieu de la montrer'),
('fr', 'emotion_telling', 'estomac se noua', 'Raconte l''émotion au lieu de la montrer'),
('fr', 'emotion_telling', 'souffle coupé', 'Raconte l''émotion au lieu de la montrer'),
('fr', 'emotion_telling', 'pouls s''accéléra', 'Raconte l''émotion au lieu de la montrer'),
('fr', 'emotion_telling', 'sang ne fit qu''un tour', 'Raconte l''émotion au lieu de la montrer'),
('fr', 'emotion_telling', 'boule dans la gorge', 'Raconte l''émotion au lieu de la montrer'),
('fr', 'emotion_telling', 'cœur se serra', 'Raconte l''émotion au lieu de la montrer'),
('fr', 'eye_descriptions', 'regard perçant', 'Métaphore oculaire surutilisée'),
('fr', 'eye_descriptions', 'yeux pétillaient', 'Métaphore oculaire surutilisée'),
('fr', 'eye_descriptions', 'yeux s''écarquillèrent', 'Métaphore oculaire surutilisée'),
('fr', 'eye_descriptions', 'regards se croisèrent', 'Métaphore oculaire surutilisée'),
('fr', 'eye_descriptions', 'regard d''acier', 'Métaphore oculaire surutilisée'),
('fr', 'physical_reactions', 'serra les poings', 'Langage corporel stéréotypé'),
('fr', 'physical_reactions', 'mâchoire se crispa', 'Langage corporel stéréotypé'),
('fr', 'physical_reactions', 'déglutit péniblement', 'Langage corporel stéréotypé'),
('fr', 'physical_reactions', 'redressa les épaules', 'Langage corporel stéréotypé'),
('fr', 'physical_reactions', 'mains tremblaient', 'Langage corporel stéréotypé'),
('fr', 'environment_mood', 'nuit noire et orageuse', 'Cliché météorologique classique'),
('fr', 'environment_mood', 'silence assourdissant', 'Oxymore surutilisé'),
('fr', 'environment_mood', 'ombres dansaient', 'Personnification surutilisée'),
('fr', 'environment_mood', 'vent hurlait', 'Personnification surutilisée'),
('fr', 'environment_mood', 'silence de mort', 'Ambiance surutilisée'),
('fr', 'environment_mood', 'clair de lune baignait', 'Description lumineuse surutilisée'),
('fr', 'dialogue_tags', 'grogna-t-il', 'Attribution de dialogue surutilisée'),
('fr', 'dialogue_tags', 'ronronna-t-elle', 'Attribution de dialogue surutilisée'),
('fr', 'dialogue_tags', 'aboya-t-il', 'Attribution de dialogue surutilisée'),
('fr', 'dialogue_tags', 'siffla-t-elle', 'Attribution de dialogue surutilisée'),
('fr', 'fight_action', 'temps sembla ralentir', 'Cliché d''action surutilisé'),
('fr', 'fight_action', 'adrénaline monta en flèche', 'Cliché d''action surutilisé'),
('fr', 'fight_action', 'tout devint noir', 'Cliché d''action surutilisé'),
('fr', 'fight_action', 'grâce féline', 'Description d''action surutilisée'),
('fr', 'romance', 'électricité crépitait entre eux', 'Cliché romantique surutilisé'),
('fr', 'romance', 'papillons dans le ventre', 'Cliché romantique surutilisé'),
('fr', 'romance', 'glissa une mèche derrière son oreille', 'Geste romantique surutilisé'),
('fr', 'romance', 'fondit dans ses bras', 'Cliché romantique surutilisé'),
('fr', 'death_grief', 'lumière s''éteignit dans ses yeux', 'Cliché mortuaire surutilisé'),
('fr', 'death_grief', 'unique larme roula', 'Cliché de deuil surutilisé'),
('fr', 'death_grief', 'monde s''effondra', 'Métaphore de deuil surutilisée'),
('fr', 'death_grief', 's''effondra à genoux', 'Réaction de deuil surutilisée'),
('fr', 'internal_monologue', 'elle ne se doutait pas', 'Intrusion narrative surutilisée'),
('fr', 'internal_monologue', 'chassa cette pensée', 'Cliché de pensée surutilisé'),
('fr', 'internal_monologue', 'ne pouvait se défaire de ce sentiment', 'Cliché de pensée surutilisé'),
('fr', 'internal_monologue', 'pensées se bousculaient', 'Cliché de pensée surutilisé'),
('fr', 'purple_prose', 'obscurité de velours', 'Écriture mélodramatique'),
('fr', 'purple_prose', 'main cruelle du destin', 'Écriture mélodramatique'),
('fr', 'purple_prose', 'symphonie de couleurs', 'Écriture mélodramatique');

-- ---------------------------------------------------------------------------
-- Seed data: Spanish clichés
-- ---------------------------------------------------------------------------

INSERT INTO public.cliche_phrases (language, category, phrase, description) VALUES
('es', 'emotion_telling', 'corazón latía con fuerza', 'Narra emoción en vez de mostrarla'),
('es', 'emotion_telling', 'sangre se heló', 'Narra emoción en vez de mostrarla'),
('es', 'emotion_telling', 'estómago se encogió', 'Narra emoción en vez de mostrarla'),
('es', 'emotion_telling', 'se le cortó la respiración', 'Narra emoción en vez de mostrarla'),
('es', 'emotion_telling', 'pulso se aceleró', 'Narra emoción en vez de mostrarla'),
('es', 'emotion_telling', 'sangre hirvió', 'Narra emoción en vez de mostrarla'),
('es', 'emotion_telling', 'nudo en la garganta', 'Narra emoción en vez de mostrarla'),
('es', 'emotion_telling', 'corazón se le encogió', 'Narra emoción en vez de mostrarla'),
('es', 'eye_descriptions', 'mirada penetrante', 'Metáfora ocular sobreutilizada'),
('es', 'eye_descriptions', 'ojos brillaron', 'Metáfora ocular sobreutilizada'),
('es', 'eye_descriptions', 'ojos se abrieron de par en par', 'Metáfora ocular sobreutilizada'),
('es', 'eye_descriptions', 'miradas se cruzaron', 'Metáfora ocular sobreutilizada'),
('es', 'eye_descriptions', 'mirada de acero', 'Metáfora ocular sobreutilizada'),
('es', 'physical_reactions', 'apretó los puños', 'Lenguaje corporal estereotipado'),
('es', 'physical_reactions', 'mandíbula se tensó', 'Lenguaje corporal estereotipado'),
('es', 'physical_reactions', 'tragó saliva', 'Lenguaje corporal estereotipado'),
('es', 'physical_reactions', 'irguió los hombros', 'Lenguaje corporal estereotipado'),
('es', 'physical_reactions', 'manos temblaban', 'Lenguaje corporal estereotipado'),
('es', 'environment_mood', 'noche oscura y tormentosa', 'Cliché meteorológico clásico'),
('es', 'environment_mood', 'silencio ensordecedor', 'Oxímoron sobreutilizado'),
('es', 'environment_mood', 'sombras danzaban', 'Personificación sobreutilizada'),
('es', 'environment_mood', 'viento aullaba', 'Personificación sobreutilizada'),
('es', 'environment_mood', 'silencio sepulcral', 'Ambientación sobreutilizada'),
('es', 'environment_mood', 'luz de la luna bañaba', 'Descripción lumínica sobreutilizada'),
('es', 'dialogue_tags', 'gruñó él', 'Atribución de diálogo sobreutilizada'),
('es', 'dialogue_tags', 'ronroneó ella', 'Atribución de diálogo sobreutilizada'),
('es', 'dialogue_tags', 'ladró él', 'Atribución de diálogo sobreutilizada'),
('es', 'dialogue_tags', 'siseó ella', 'Atribución de diálogo sobreutilizada'),
('es', 'fight_action', 'tiempo pareció detenerse', 'Cliché de acción sobreutilizado'),
('es', 'fight_action', 'adrenalina se disparó', 'Cliché de acción sobreutilizado'),
('es', 'fight_action', 'todo se volvió negro', 'Cliché de acción sobreutilizado'),
('es', 'fight_action', 'gracia felina', 'Descripción de acción sobreutilizada'),
('es', 'romance', 'electricidad chisporroteaba entre ellos', 'Cliché romántico sobreutilizado'),
('es', 'romance', 'mariposas en el estómago', 'Cliché romántico sobreutilizado'),
('es', 'romance', 'colocó un mechón detrás de su oreja', 'Gesto romántico sobreutilizado'),
('es', 'romance', 'se derritió en sus brazos', 'Cliché romántico sobreutilizado'),
('es', 'death_grief', 'luz se apagó en sus ojos', 'Cliché mortuorio sobreutilizado'),
('es', 'death_grief', 'única lágrima rodó', 'Cliché de duelo sobreutilizado'),
('es', 'death_grief', 'mundo se derrumbó', 'Metáfora de duelo sobreutilizada'),
('es', 'death_grief', 'cayó de rodillas', 'Reacción de duelo sobreutilizada'),
('es', 'internal_monologue', 'lo que ella no sabía', 'Intrusión narrativa sobreutilizada'),
('es', 'internal_monologue', 'apartó ese pensamiento', 'Cliché de pensamiento sobreutilizado'),
('es', 'internal_monologue', 'no podía quitarse esa sensación', 'Cliché de pensamiento sobreutilizado'),
('es', 'internal_monologue', 'pensamientos se agolpaban', 'Cliché de pensamiento sobreutilizado'),
('es', 'purple_prose', 'oscuridad aterciopelada', 'Escritura melodramática'),
('es', 'purple_prose', 'cruel mano del destino', 'Escritura melodramática'),
('es', 'purple_prose', 'sinfonía de colores', 'Escritura melodramática');
