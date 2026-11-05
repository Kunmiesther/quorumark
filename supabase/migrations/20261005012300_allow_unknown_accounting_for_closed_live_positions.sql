-- A flat venue snapshot confirms closure, not its exit price or realized P&L.
-- Preserve required values for open and paper positions while allowing honest
-- unknown accounting on venue-confirmed closed live rows.
ALTER TABLE public.positions
  ALTER COLUMN current_price DROP NOT NULL,
  ALTER COLUMN pnl_amount DROP NOT NULL,
  ALTER COLUMN pnl_pct DROP NOT NULL,
  ALTER COLUMN unrealized_pnl DROP NOT NULL;

ALTER TABLE public.positions ADD CONSTRAINT positions_unknown_accounting_only_closed_live
CHECK (
  (current_price IS NOT NULL AND pnl_amount IS NOT NULL
    AND pnl_pct IS NOT NULL AND unrealized_pnl IS NOT NULL)
  OR (source = 'live' AND status = 'closed')
);
