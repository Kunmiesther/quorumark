
-- 1) has_role: switch to SECURITY INVOKER (user_roles RLS restricts to auth.uid()=user_id, so callers can only test themselves)
CREATE OR REPLACE FUNCTION public.has_role(_user_id uuid, _role app_role)
RETURNS boolean
LANGUAGE sql
STABLE SECURITY INVOKER
SET search_path TO 'public'
AS $$
  SELECT EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = _user_id AND role = _role)
$$;

-- 2) bot_heartbeat: restrict SELECT to admins
DROP POLICY IF EXISTS "Authenticated can read bot status" ON public.bot_heartbeat;
CREATE POLICY "Admins read bot heartbeat"
ON public.bot_heartbeat
FOR SELECT TO authenticated
USING (public.has_role(auth.uid(), 'admin'::app_role));

-- 3) worker_heartbeats: restrict SELECT to admins
DROP POLICY IF EXISTS "Authenticated can view worker heartbeats" ON public.worker_heartbeats;
CREATE POLICY "Admins read worker heartbeats"
ON public.worker_heartbeats
FOR SELECT TO authenticated
USING (public.has_role(auth.uid(), 'admin'::app_role));

-- 4) kill_switches: restrict global-scope reads to admins; users still see their own
DROP POLICY IF EXISTS "Users can view own or global kill switches" ON public.kill_switches;
CREATE POLICY "Users view own kill switches"
ON public.kill_switches
FOR SELECT TO authenticated
USING (
  user_id = auth.uid()
  OR (scope = 'global' AND public.has_role(auth.uid(), 'admin'::app_role))
);
