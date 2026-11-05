INSERT INTO public.access_entitlements (user_id, plan_key, source, community_id, status)
SELECT p.id, 'free_paper_trial', 'grandfathered', NULL, 'active'
FROM public.profiles p
ON CONFLICT (user_id, plan_key) DO NOTHING;