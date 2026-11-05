ALTER TABLE public.paper_positions
  ALTER COLUMN stop_level DROP NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'paper_positions_stop_required_for_non_ladder'
      AND conrelid = 'public.paper_positions'::regclass
  ) THEN
    ALTER TABLE public.paper_positions
      ADD CONSTRAINT paper_positions_stop_required_for_non_ladder
      CHECK (
        stop_level IS NOT NULL
        OR COALESCE(ladder_total_rungs, configured_rung_count, 1) > 1
      );
  END IF;
END $$;