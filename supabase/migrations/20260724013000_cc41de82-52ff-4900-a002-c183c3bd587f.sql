
-- Defense-in-depth: make client-side write posture on sensitive tables explicit,
-- and remove pin_hash/phone from the columns that authenticated clients can read
-- or update on their own profile. Service-role (server-only) paths are unaffected
-- because service_role bypasses RLS and column grants.

-- 1) apex_execution_credentials — no client writes; service_role only.
CREATE POLICY "No client inserts on apex execution credentials"
  ON public.apex_execution_credentials FOR INSERT TO authenticated
  WITH CHECK (false);
CREATE POLICY "No client updates on apex execution credentials"
  ON public.apex_execution_credentials FOR UPDATE TO authenticated
  USING (false) WITH CHECK (false);
CREATE POLICY "No client deletes on apex execution credentials"
  ON public.apex_execution_credentials FOR DELETE TO authenticated
  USING (false);

-- 2) exchange_credentials — no client writes; service_role only.
CREATE POLICY "No client inserts on exchange credentials"
  ON public.exchange_credentials FOR INSERT TO authenticated
  WITH CHECK (false);
CREATE POLICY "No client updates on exchange credentials"
  ON public.exchange_credentials FOR UPDATE TO authenticated
  USING (false) WITH CHECK (false);
CREATE POLICY "No client deletes on exchange credentials"
  ON public.exchange_credentials FOR DELETE TO authenticated
  USING (false);

-- 3) wallet_connection_challenges — challenges are minted server-side only.
CREATE POLICY "No client inserts on wallet connection challenges"
  ON public.wallet_connection_challenges FOR INSERT TO authenticated
  WITH CHECK (false);
CREATE POLICY "No client updates on wallet connection challenges"
  ON public.wallet_connection_challenges FOR UPDATE TO authenticated
  USING (false) WITH CHECK (false);
CREATE POLICY "No client deletes on wallet connection challenges"
  ON public.wallet_connection_challenges FOR DELETE TO authenticated
  USING (false);

-- 4) user_roles — prevent any client-side self-escalation. Role assignment
--    is service_role only (grants, admin edge paths).
CREATE POLICY "No client inserts on user roles"
  ON public.user_roles FOR INSERT TO authenticated
  WITH CHECK (false);
CREATE POLICY "No client updates on user roles"
  ON public.user_roles FOR UPDATE TO authenticated
  USING (false) WITH CHECK (false);
CREATE POLICY "No client deletes on user roles"
  ON public.user_roles FOR DELETE TO authenticated
  USING (false);

-- 5) profiles — hide pin_hash and phone from the authenticated (PostgREST)
--    role at the column-grant layer. RLS still restricts rows to the owner;
--    this ensures that even a `select *` from a compromised session or a
--    future broad query never returns the PIN hash or phone number.
REVOKE SELECT, UPDATE ON public.profiles FROM authenticated;

GRANT SELECT (
  id, display_name, demo_mode, account_mode, bot_status,
  risk_acknowledged, risk_acknowledged_at, onboarding_complete,
  created_at, updated_at, active_goal_name, active_goal_target,
  lifetime_harvested_cash, current_leverage_tier, strategy_mode,
  active_wallet_usd, target_budget_items, onboarding_complete_v2,
  avatar_url, face_id_enabled, notifications_enabled,
  life_map_migrated_at, target_budget_items_backup, favorite_character
) ON public.profiles TO authenticated;

GRANT UPDATE (
  display_name, demo_mode, account_mode, bot_status,
  risk_acknowledged, risk_acknowledged_at, onboarding_complete,
  active_goal_name, active_goal_target,
  lifetime_harvested_cash, current_leverage_tier, strategy_mode,
  active_wallet_usd, target_budget_items, onboarding_complete_v2,
  avatar_url, face_id_enabled, notifications_enabled,
  life_map_migrated_at, target_budget_items_backup, favorite_character
) ON public.profiles TO authenticated;
