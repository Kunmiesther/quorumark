ALTER TABLE public.exchange_connections
  ADD COLUMN IF NOT EXISTS is_live boolean NOT NULL DEFAULT false;

-- Owner-scoped UPDATE policy so the /exchanges toggle can flip is_live for
-- one's own connection only. All other columns remain governed by existing
-- policies (no existing UPDATE policy, so this is the sole authenticated
-- update surface — narrow by construction).
DROP POLICY IF EXISTS "Users update own connection live flag" ON public.exchange_connections;
CREATE POLICY "Users update own connection live flag"
  ON public.exchange_connections
  FOR UPDATE
  TO authenticated
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

GRANT UPDATE (is_live) ON public.exchange_connections TO authenticated;

-- Owner directive: activate live routing on the one verified ApeX Omni
-- production connection. Canary — no other connection is touched.
UPDATE public.exchange_connections
   SET is_live = true, updated_at = now()
 WHERE id = 'd0700a21-751b-4ffa-a7cb-d51359118e48';