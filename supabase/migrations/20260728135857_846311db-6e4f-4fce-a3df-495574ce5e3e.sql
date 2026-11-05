-- Defense-in-depth: revoke write privileges from client roles on tables
-- that are only ever written by service_role or SECURITY DEFINER RPCs.
-- RLS already denies without a matching policy; revoking grants makes the
-- intent explicit and blocks writes at the grant layer too.

REVOKE INSERT, UPDATE, DELETE ON public.order_intents FROM anon, authenticated;
REVOKE INSERT, UPDATE, DELETE ON public.orders FROM anon, authenticated;
REVOKE INSERT, UPDATE, DELETE ON public.paper_authorizations FROM anon, authenticated;
REVOKE INSERT, UPDATE, DELETE ON public.paper_engine_authority FROM anon, authenticated;
REVOKE INSERT, UPDATE, DELETE ON public.paper_engine_operations FROM anon, authenticated;
REVOKE INSERT, UPDATE, DELETE ON public.paper_symbol_pods FROM anon, authenticated;
REVOKE INSERT, UPDATE, DELETE ON public.paper_wallet_legs FROM anon, authenticated;
REVOKE INSERT, UPDATE, DELETE ON public.user_turtle_progress FROM anon, authenticated;
REVOKE INSERT, UPDATE, DELETE ON public.wallet_activation_events FROM anon, authenticated;

-- Also add explicit RESTRICTIVE deny policies so any future GRANT can't
-- accidentally re-open direct client writes without an owner-scoped policy.
DO $$
DECLARE t text;
BEGIN
  FOR t IN SELECT unnest(ARRAY[
    'order_intents','orders','paper_authorizations','paper_engine_authority',
    'paper_engine_operations','paper_symbol_pods','paper_wallet_legs',
    'user_turtle_progress','wallet_activation_events'
  ]) LOOP
    EXECUTE format('DROP POLICY IF EXISTS "deny client writes" ON public.%I', t);
    EXECUTE format(
      'CREATE POLICY "deny client writes" ON public.%I AS RESTRICTIVE FOR ALL TO anon, authenticated USING (false) WITH CHECK (false)',
      t
    );
  END LOOP;
END $$;
