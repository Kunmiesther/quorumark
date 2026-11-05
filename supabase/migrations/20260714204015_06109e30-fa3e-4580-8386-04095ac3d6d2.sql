
CREATE OR REPLACE FUNCTION public.enforce_max_connections()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
DECLARE
  active_count int;
BEGIN
  -- Rows created already-inactive never consume a slot.
  IF NEW.status IN ('disconnected','disabled') THEN
    RETURN NEW;
  END IF;
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
