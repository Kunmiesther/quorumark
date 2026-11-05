
CREATE OR REPLACE FUNCTION public.award_bill_points(
  _user_id uuid,
  _bill_id uuid,
  _reason text,
  _points integer
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _key text;
BEGIN
  IF _user_id IS NULL THEN
    RAISE EXCEPTION 'missing user';
  END IF;
  IF _points <= 0 OR _points > 1000 THEN
    RAISE EXCEPTION 'invalid points';
  END IF;
  PERFORM 1 FROM public.bills WHERE id = _bill_id AND user_id = _user_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'bill not found';
  END IF;

  _key := 'bill:' || _bill_id::text || ':' || _reason;

  INSERT INTO public.point_ledger (user_id, points, reason, idempotency_key, metadata)
  VALUES (_user_id, _points, _reason, _key, jsonb_build_object('bill_id', _bill_id))
  ON CONFLICT (idempotency_key) DO NOTHING;

  RETURN _points;
END;
$$;

REVOKE ALL ON FUNCTION public.award_bill_points(uuid, uuid, text, integer) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.award_bill_points(uuid, uuid, text, integer) TO service_role;

-- Drop the old signature so signed-in users can no longer invoke it.
DROP FUNCTION IF EXISTS public.award_bill_points(uuid, text, integer);
