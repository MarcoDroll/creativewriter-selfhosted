-- Add server-side file type and size validation to storage buckets.
-- Supabase enforces allowed_mime_types against the Content-Type header and filename
-- at the Storage API layer. This prevents uploading arbitrary file types
-- (e.g., HTML, SVG with scripts, executables) into the public story-media bucket.
-- Note: This is NOT magic-byte validation — a crafted request can still spoof Content-Type.
-- Combined with Supabase serving HTML as text/plain, this provides adequate protection.

-- GIF and SVG are intentionally excluded:
--   GIF: large file sizes, not needed for a writing app
--   SVG: can embed <script> tags — XSS risk on the public story-media bucket

-- story-media bucket: images + videos
-- File size: 5MB (matches client MAX_IMAGE_SIZE; 1MB video limit remains client-side)
-- MIME types: common web image + video formats (must match ALLOWED_IMAGE_TYPES / ALLOWED_VIDEO_TYPES)
UPDATE storage.buckets
SET
  file_size_limit = 5242880,
  allowed_mime_types = ARRAY[
    'image/jpeg', 'image/png', 'image/webp',
    'video/mp4', 'video/webm', 'video/quicktime'
  ]
WHERE id = 'story-media';

-- user-backgrounds bucket: images only
-- File size: 1MB (client compresses to ~500KB; headroom for edge cases)
-- MIME types: same image formats as client-side isValidImageFile()
UPDATE storage.buckets
SET
  file_size_limit = 1048576,
  allowed_mime_types = ARRAY['image/jpeg', 'image/png', 'image/webp']
WHERE id = 'user-backgrounds';
