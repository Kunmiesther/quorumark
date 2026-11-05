-- Future surplus moves must retain the book they originated from. Historical
-- source='reallocation' rows have no provenance and are excluded from both
-- book-specific coverage displays instead of being silently treated as live.
ALTER TABLE public.bill_allocations
  DROP CONSTRAINT bill_allocations_source_check,
  ADD CONSTRAINT bill_allocations_source_check
    CHECK (source = ANY (ARRAY['paper'::text, 'live'::text, 'reallocation'::text, 'reallocation_live'::text]));
