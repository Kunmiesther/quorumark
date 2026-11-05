ALTER TABLE public.scout_guardian_directives DROP CONSTRAINT IF EXISTS scout_guardian_directives_directive_type_check;
ALTER TABLE public.scout_guardian_directives ADD CONSTRAINT scout_guardian_directives_directive_type_check CHECK (
  directive_type IN (
    'cancel_unfilled_rungs',
    'close_position',
    'reduce_position',
    'promote_runner',
    'cancel_fixed_tp',
    'set_breakeven_stop',
    'repair_stop'
  )
);