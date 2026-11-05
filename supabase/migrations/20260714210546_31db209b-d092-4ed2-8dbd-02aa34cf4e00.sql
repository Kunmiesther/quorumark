
DELETE FROM public.kill_switches;

DO $$
DECLARE
  test_user uuid := '6d24b642-ae58-490b-80e0-a70b190c0838';
  test_conn uuid := 'cc3c84a5-098d-4b48-909e-6126bdacd879';
  other_user uuid := '00000000-0000-0000-0000-000000000001';
  other_conn uuid := '00000000-0000-0000-0000-000000000099';
BEGIN
  ASSERT public.is_execution_halted(test_user, test_conn) = false, 'A. baseline';

  INSERT INTO public.kill_switches (scope, user_id, connection_id, active)
    VALUES ('connection', test_user, test_conn, true);
  ASSERT public.is_execution_halted(test_user, test_conn) = true,   'B1';
  ASSERT public.is_execution_halted(test_user, other_conn) = false, 'B2';
  ASSERT public.is_execution_halted(other_user, test_conn) = false, 'B3';
  DELETE FROM public.kill_switches;

  INSERT INTO public.kill_switches (scope, user_id, active) VALUES ('user', test_user, true);
  ASSERT public.is_execution_halted(test_user, test_conn) = true,   'C1';
  ASSERT public.is_execution_halted(test_user, other_conn) = true,  'C2';
  ASSERT public.is_execution_halted(other_user, other_conn) = false,'C3';
  DELETE FROM public.kill_switches;

  INSERT INTO public.kill_switches (scope, active) VALUES ('global', true);
  ASSERT public.is_execution_halted(other_user, other_conn) = true, 'D';
  DELETE FROM public.kill_switches;

  BEGIN
    INSERT INTO public.kill_switches (scope, user_id, active) VALUES ('global', test_user, true);
    RAISE EXCEPTION 'E1 FAIL';
  EXCEPTION WHEN check_violation THEN NULL; END;
  BEGIN
    INSERT INTO public.kill_switches (scope, active) VALUES ('user', true);
    RAISE EXCEPTION 'E2 FAIL';
  EXCEPTION WHEN check_violation THEN NULL; END;
  BEGIN
    INSERT INTO public.kill_switches (scope, user_id, active) VALUES ('connection', test_user, true);
    RAISE EXCEPTION 'E3 FAIL';
  EXCEPTION WHEN check_violation THEN NULL; END;

  INSERT INTO public.kill_switches (scope, active) VALUES ('global', true);
  BEGIN
    INSERT INTO public.kill_switches (scope, active) VALUES ('global', false);
    RAISE EXCEPTION 'E4 FAIL';
  EXCEPTION WHEN unique_violation THEN NULL; END;
  DELETE FROM public.kill_switches;

  INSERT INTO public.exchange_connections (user_id, exchange, status, environment)
  SELECT test_user, 'apex_omni', 'verified'::connection_status, 'test'
  FROM generate_series(1,5);
  ASSERT (SELECT count(*) FROM public.exchange_connections
          WHERE user_id=test_user AND status NOT IN ('disconnected','disabled')) = 6, 'F1';
  BEGIN
    INSERT INTO public.exchange_connections (user_id, exchange, status, environment)
      VALUES (test_user, 'apex_omni', 'verified', 'test');
    RAISE EXCEPTION 'F2 FAIL';
  EXCEPTION WHEN raise_exception THEN NULL; END;
  DELETE FROM public.exchange_connections
   WHERE user_id=test_user AND id <> test_conn;

  ASSERT NOT EXISTS (
    SELECT 1 FROM pg_indexes
     WHERE tablename='exchange_connections'
       AND indexname='exchange_connections_one_active_per_exchange'
  ), 'G';

  RAISE NOTICE 'ALL P2 ACCEPTANCE TESTS PASSED';
END $$;
