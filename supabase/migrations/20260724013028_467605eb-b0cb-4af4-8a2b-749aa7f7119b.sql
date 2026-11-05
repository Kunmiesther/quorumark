
-- Restore UPDATE on pin_hash and phone so the PIN setup and phone
-- entry flows continue to work from the client. SELECT on those two
-- columns remains revoked, so the client can never read them back.
GRANT UPDATE (pin_hash, phone) ON public.profiles TO authenticated;
