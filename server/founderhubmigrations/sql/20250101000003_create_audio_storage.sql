INSERT INTO storage.buckets (id, name, public)
VALUES ('audio-files', 'audio-files', false)
ON CONFLICT (id) DO NOTHING;

CREATE POLICY "audio_files_select_owner" ON storage.objects FOR SELECT TO shots_hub_authenticated USING (bucket_id = 'audio-files' AND (SELECT founder_hub_identity.uid())::text = (storage.foldername(name))[1]);

CREATE POLICY "audio_files_insert_authenticated" ON storage.objects FOR INSERT TO shots_hub_authenticated WITH CHECK (bucket_id = 'audio-files' AND (SELECT founder_hub_identity.uid())::text = (storage.foldername(name))[1]);

CREATE POLICY "audio_files_update_owner" ON storage.objects FOR UPDATE TO shots_hub_authenticated USING (bucket_id = 'audio-files' AND (SELECT founder_hub_identity.uid())::text = (storage.foldername(name))[1]);

CREATE POLICY "audio_files_delete_owner" ON storage.objects FOR DELETE TO shots_hub_authenticated USING (bucket_id = 'audio-files' AND (SELECT founder_hub_identity.uid())::text = (storage.foldername(name))[1]);
