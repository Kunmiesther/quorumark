-- Public storage bucket for broadcast images (Telegram sendPhoto needs a
-- URL it can fetch itself — public avoids juggling signed-URL expiry per
-- send). Admin-only write, world-readable, matching the announcement's own
-- audience (everyone linked on Telegram).

INSERT INTO storage.buckets (id, name, public)
VALUES ('broadcast-images', 'broadcast-images', true);

CREATE POLICY "Public read broadcast images" ON storage.objects
  FOR SELECT USING (bucket_id = 'broadcast-images');

CREATE POLICY "Admins upload broadcast images" ON storage.objects
  FOR INSERT WITH CHECK (bucket_id = 'broadcast-images' AND has_role(auth.uid(), 'admin'::app_role));

CREATE POLICY "Admins delete broadcast images" ON storage.objects
  FOR DELETE USING (bucket_id = 'broadcast-images' AND has_role(auth.uid(), 'admin'::app_role));
