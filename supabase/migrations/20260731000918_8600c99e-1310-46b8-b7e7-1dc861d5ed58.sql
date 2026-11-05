
CREATE OR REPLACE FUNCTION public.owns_exchange_connection(_connection_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.exchange_connections ec
    WHERE ec.id = _connection_id AND ec.user_id = auth.uid()
  )
$$;

CREATE OR REPLACE FUNCTION public.exchange_connection_exists(_connection_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (SELECT 1 FROM public.exchange_connections ec WHERE ec.id = _connection_id)
$$;

REVOKE ALL ON FUNCTION public.owns_exchange_connection(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.exchange_connection_exists(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.owns_exchange_connection(uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.exchange_connection_exists(uuid) TO authenticated, service_role;

DROP POLICY IF EXISTS "Owners can insert their apex execution credentials" ON public.apex_execution_credentials;
CREATE POLICY "Owners can insert their apex execution credentials"
ON public.apex_execution_credentials
FOR INSERT
TO authenticated
WITH CHECK (
  auth.uid() = user_id
  AND public.owns_exchange_connection(exchange_connection_id)
);

DROP POLICY IF EXISTS "Owners can update their apex execution credentials" ON public.apex_execution_credentials;
CREATE POLICY "Owners can update their apex execution credentials"
ON public.apex_execution_credentials
FOR UPDATE
TO authenticated
USING (auth.uid() = user_id)
WITH CHECK (
  auth.uid() = user_id
  AND public.owns_exchange_connection(exchange_connection_id)
);

DROP POLICY IF EXISTS "Users manage own strategy" ON public.user_strategy;
CREATE POLICY "Users manage own strategy"
ON public.user_strategy
FOR ALL
TO authenticated
USING (auth.uid() = user_id)
WITH CHECK (
  auth.uid() = user_id
  AND (
    public.owns_exchange_connection(connection_id)
    OR NOT public.exchange_connection_exists(connection_id)
  )
);
