DROP POLICY IF EXISTS "Users can update their own wallet connections" ON public.wallet_connections;

CREATE POLICY "Users can update their own wallet connections"
ON public.wallet_connections
FOR UPDATE
USING (auth.uid() = user_id)
WITH CHECK (
  auth.uid() = user_id
  AND (
    assigned_exchange_connection_id IS NULL
    OR EXISTS (
      SELECT 1 FROM public.exchange_connections ec
      WHERE ec.id = assigned_exchange_connection_id
        AND ec.user_id = auth.uid()
    )
  )
);