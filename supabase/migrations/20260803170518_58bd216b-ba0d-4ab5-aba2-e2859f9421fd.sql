REVOKE EXECUTE ON FUNCTION public.claim_live_recon_lease(uuid, integer) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.release_live_recon_lease(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_live_recon_lease(uuid, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.release_live_recon_lease(uuid) TO service_role;