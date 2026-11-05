-- Life Map surplus reallocation.
--
-- A bill can accumulate more than its cap (covered_usd > amount_usd) once
-- the priority-ordered allocator has nowhere else to send an overflow — that
-- excess is currently silently wasted (clamped away in getLifeMapSnapshot's
-- totals). This lets a user apply that surplus to whichever smaller bills
-- are still short, instead of it sitting invisible.

ALTER TABLE public.bill_allocations
  DROP CONSTRAINT bill_allocations_source_check,
  ADD CONSTRAINT bill_allocations_source_check
    CHECK (source = ANY (ARRAY['paper'::text, 'live'::text, 'reallocation'::text]));

CREATE TABLE public.bill_reallocation_suggestions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  source_bill_id UUID NOT NULL REFERENCES public.bills(id) ON DELETE CASCADE,
  period_key TEXT NOT NULL CHECK (period_key ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
  surplus_usd NUMERIC(14,4) NOT NULL CHECK (surplus_usd > 0),
  -- [{bill_id, amount_usd}, ...] — the targets computed at suggestion time.
  -- applyReallocationSuggestion() recomputes fresh at apply time; this is
  -- the record of what was originally offered.
  targets JSONB NOT NULL DEFAULT '[]'::jsonb,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'applied', 'dismissed')),
  notified_telegram_at TIMESTAMPTZ,
  resolved_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- At most one open suggestion per (user, source bill, period) — detection
-- re-reads this before inserting, this is the backstop against duplicates
-- from concurrent detection passes (page poll + Telegram piggyback + hook).
CREATE UNIQUE INDEX bill_realloc_suggestions_open_idx
  ON public.bill_reallocation_suggestions (user_id, source_bill_id, period_key)
  WHERE status = 'pending';

GRANT SELECT, INSERT, UPDATE ON public.bill_reallocation_suggestions TO authenticated;
GRANT ALL ON public.bill_reallocation_suggestions TO service_role;
ALTER TABLE public.bill_reallocation_suggestions ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users view own reallocation suggestions" ON public.bill_reallocation_suggestions
  FOR SELECT TO authenticated USING (auth.uid() = user_id);
-- detectReallocationSuggestions() inserts on the user's own RLS-scoped
-- client when triggered from the /life-map page; the Telegram/hook paths
-- use the service-role client instead (bypasses RLS).
CREATE POLICY "Users insert own reallocation suggestions" ON public.bill_reallocation_suggestions
  FOR INSERT TO authenticated WITH CHECK (auth.uid() = user_id);
-- Apply/dismiss update status + resolved_at only, through
-- applyReallocationSuggestion/dismissReallocationSuggestion, which
-- recompute live coverage before writing anything — same "no admin client"
-- convention as the rest of src/lib/bills.
CREATE POLICY "Users resolve own reallocation suggestions" ON public.bill_reallocation_suggestions
  FOR UPDATE TO authenticated USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
