REVOKE EXECUTE ON FUNCTION public._paper_assert_owner(uuid) FROM anon;
REVOKE EXECUTE ON FUNCTION public.paper_open_position(uuid, uuid, jsonb) FROM anon;
REVOKE EXECUTE ON FUNCTION public.paper_add_rung(uuid, uuid, int, jsonb) FROM anon;
REVOKE EXECUTE ON FUNCTION public.paper_reduce_position(uuid, uuid, int, jsonb, jsonb, numeric, uuid, jsonb) FROM anon;
REVOKE EXECUTE ON FUNCTION public.paper_close_position(uuid, uuid, bigint, jsonb, numeric, uuid, jsonb) FROM anon;
