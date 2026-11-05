
REVOKE ALL ON FUNCTION public.paper_partial_close_position(
  uuid, uuid, bigint, jsonb, numeric, numeric, numeric, numeric, uuid, jsonb, jsonb
) FROM PUBLIC, anon, authenticated;
