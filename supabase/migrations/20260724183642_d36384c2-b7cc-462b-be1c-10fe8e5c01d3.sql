
-- Life Map v3 — categories, turtle assignment, proof of payment, life points
ALTER TABLE public.bills
  ADD COLUMN IF NOT EXISTS category text,
  ADD COLUMN IF NOT EXISTS assigned_strategy text,
  ADD COLUMN IF NOT EXISTS paid_at timestamptz,
  ADD COLUMN IF NOT EXISTS proof_url text;

CREATE INDEX IF NOT EXISTS bills_user_category_idx
  ON public.bills(user_id, category) WHERE archived_at IS NULL;

-- Idempotent points award. Uses point_ledger.idempotency_key to guarantee
-- a bill milestone can only be rewarded once per (bill, reason).
CREATE OR REPLACE FUNCTION public.award_bill_points(
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
  _uid uuid := auth.uid();
  _key text;
BEGIN
  IF _uid IS NULL THEN
    RAISE EXCEPTION 'not authenticated';
  END IF;
  IF _points <= 0 OR _points > 1000 THEN
    RAISE EXCEPTION 'invalid points';
  END IF;
  -- Verify caller owns the bill.
  PERFORM 1 FROM public.bills WHERE id = _bill_id AND user_id = _uid;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'bill not found';
  END IF;

  _key := 'bill:' || _bill_id::text || ':' || _reason;

  INSERT INTO public.point_ledger (user_id, points, reason, idempotency_key, metadata)
  VALUES (_uid, _points, _reason, _key, jsonb_build_object('bill_id', _bill_id))
  ON CONFLICT (idempotency_key) DO NOTHING;

  RETURN _points;
END;
$$;

REVOKE ALL ON FUNCTION public.award_bill_points(uuid, text, integer) FROM public;
GRANT EXECUTE ON FUNCTION public.award_bill_points(uuid, text, integer) TO authenticated;
