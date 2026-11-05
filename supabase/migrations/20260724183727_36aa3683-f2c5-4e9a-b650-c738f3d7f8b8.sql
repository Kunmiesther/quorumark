
CREATE POLICY "Users can read own bill proofs"
  ON storage.objects FOR SELECT TO authenticated
  USING (bucket_id = 'bill-proofs' AND owner = auth.uid());

CREATE POLICY "Users can upload own bill proofs"
  ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'bill-proofs' AND owner = auth.uid()
    AND (storage.foldername(name))[1] = auth.uid()::text);

CREATE POLICY "Users can update own bill proofs"
  ON storage.objects FOR UPDATE TO authenticated
  USING (bucket_id = 'bill-proofs' AND owner = auth.uid())
  WITH CHECK (bucket_id = 'bill-proofs' AND owner = auth.uid());

CREATE POLICY "Users can delete own bill proofs"
  ON storage.objects FOR DELETE TO authenticated
  USING (bucket_id = 'bill-proofs' AND owner = auth.uid());
