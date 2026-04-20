-- Enforce server-side count limits on media uploads.
-- Matches client-side constants: MAX_IMAGES_PER_STORY=100, MAX_VIDEOS_PER_STORY=50, MAX_BACKGROUNDS_PER_USER=5.
-- Uses BEFORE INSERT triggers so limits are enforced regardless of how data enters the database.

-- Trigger: limit images per story to 100
CREATE OR REPLACE FUNCTION public.enforce_image_count_limit()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  current_count integer;
BEGIN
  SELECT count(*) INTO current_count
  FROM public.story_images
  WHERE story_id = NEW.story_id AND user_id = NEW.user_id;

  IF current_count >= 100 THEN
    RAISE EXCEPTION 'Maximum 100 images per story reached'
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_enforce_image_count_limit
  BEFORE INSERT ON public.story_images
  FOR EACH ROW
  EXECUTE FUNCTION public.enforce_image_count_limit();

-- Trigger: limit videos per story to 50
CREATE OR REPLACE FUNCTION public.enforce_video_count_limit()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  current_count integer;
BEGIN
  SELECT count(*) INTO current_count
  FROM public.story_videos
  WHERE story_id = NEW.story_id AND user_id = NEW.user_id;

  IF current_count >= 50 THEN
    RAISE EXCEPTION 'Maximum 50 videos per story reached'
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_enforce_video_count_limit
  BEFORE INSERT ON public.story_videos
  FOR EACH ROW
  EXECUTE FUNCTION public.enforce_video_count_limit();

-- Trigger: limit custom backgrounds per user to 5
CREATE OR REPLACE FUNCTION public.enforce_background_count_limit()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  current_count integer;
BEGIN
  SELECT count(*) INTO current_count
  FROM public.custom_backgrounds
  WHERE user_id = NEW.user_id;

  IF current_count >= 5 THEN
    RAISE EXCEPTION 'Maximum 5 custom backgrounds per user reached'
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_enforce_background_count_limit
  BEFORE INSERT ON public.custom_backgrounds
  FOR EACH ROW
  EXECUTE FUNCTION public.enforce_background_count_limit();
