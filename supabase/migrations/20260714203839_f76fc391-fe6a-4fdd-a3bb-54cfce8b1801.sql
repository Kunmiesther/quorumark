
-- Trigger previously used SELECT ... FOR UPDATE which needs UPDATE privilege on
-- exchange_connections. Roles like authenticated only have INSERT/SELECT/DELETE
-- for their own rows and don't need UPDATE. Switch to a transactional advisory
-- lock keyed by user_id — same serialization guarantee, no privilege needed.
CREATE OR REPLACE FUNCTION public.enforce_max_connections()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
DECLARE
  active_count int;
BEGIN
  -- Serialize concurrent inserts for the same user without needing UPDATE on
  -- exchange_connections. Lock is released at transaction end.
  PERFORM pg_advisory_xact_lock(hashtextextended('exchange_connections_cap'||NEW.user_id::text, 0));
  SELECT count(*) INTO active_count
    FROM public.exchange_connections
    WHERE user_id = NEW.user_id
      AND status NOT IN ('disconnected','disabled');
  IF active_count >= 6 THEN
    RAISE EXCEPTION 'MAX_CONNECTIONS_EXCEEDED: max 6 active trading connections per user';
  END IF;
  RETURN NEW;
END;
$$;
