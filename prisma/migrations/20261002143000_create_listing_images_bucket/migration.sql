INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'listing-images',
  'listing-images',
  TRUE,
  10485760,
  ARRAY['image/avif', 'image/gif', 'image/jpeg', 'image/png', 'image/webp']
)
ON CONFLICT (id) DO UPDATE SET
  public = EXCLUDED.public,
  file_size_limit = EXCLUDED.file_size_limit,
  allowed_mime_types = EXCLUDED.allowed_mime_types;

DROP POLICY IF EXISTS "listing-images-insert-own-folder" ON storage.objects;
CREATE POLICY "listing-images-insert-own-folder"
ON storage.objects FOR INSERT TO authenticated
WITH CHECK (
  bucket_id = 'listing-images'
  AND (storage.foldername(name))[1] = auth.uid()::text
);

DROP POLICY IF EXISTS "listing-images-delete-own-folder" ON storage.objects;
CREATE POLICY "listing-images-delete-own-folder"
ON storage.objects FOR DELETE TO authenticated
USING (
  bucket_id = 'listing-images'
  AND (storage.foldername(name))[1] = auth.uid()::text
);