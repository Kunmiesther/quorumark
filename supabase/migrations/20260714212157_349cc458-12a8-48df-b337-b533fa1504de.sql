
DO $$
DECLARE
  ua uuid := '6d24b642-ae58-490b-80e0-a70b190c0838';
  fake_conn uuid := gen_random_uuid();
  connA uuid; connA2 uuid;
  ksG uuid; ksC uuid;
  r_novs bool; r_own bool; r_null bool; r_cx bool; r_cy bool; r_glob bool;
BEGIN
  INSERT INTO public.exchange_connections (user_id, exchange, environment, status) VALUES (ua,'apex_omni','testnet','disconnected') RETURNING id INTO connA;
  INSERT INTO public.exchange_connections (user_id, exchange, environment, status) VALUES (ua,'apex_omni','testnet','disconnected') RETURNING id INTO connA2;

  r_novs := public.is_execution_halted(ua, connA);
  -- ownership mismatch: fake connection not owned by ua
  r_own  := public.is_execution_halted(ua, fake_conn);
  r_null := public.is_execution_halted(NULL, connA);

  INSERT INTO public.kill_switches (scope, user_id, connection_id, active) VALUES ('connection', ua, connA, true) RETURNING id INTO ksC;
  r_cx := public.is_execution_halted(ua, connA);
  r_cy := public.is_execution_halted(ua, connA2);

  INSERT INTO public.kill_switches (scope, active) VALUES ('global', true) RETURNING id INTO ksG;
  r_glob := public.is_execution_halted(ua, connA);

  IF public.my_execution_halted(NULL) IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'FAIL my_execution_halted null-uid';
  END IF;
  IF public.my_connection_slot_available() IS DISTINCT FROM false THEN
    RAISE EXCEPTION 'FAIL my_connection_slot_available null-uid';
  END IF;

  IF r_novs<>false THEN RAISE EXCEPTION 'FAIL novs=%',r_novs; END IF;
  IF r_own <>true  THEN RAISE EXCEPTION 'FAIL own=%',r_own;  END IF;
  IF r_null<>true  THEN RAISE EXCEPTION 'FAIL null=%',r_null; END IF;
  IF r_cx  <>true  THEN RAISE EXCEPTION 'FAIL cx=%',r_cx;   END IF;
  IF r_cy  <>false THEN RAISE EXCEPTION 'FAIL cy=%',r_cy;   END IF;
  IF r_glob<>true  THEN RAISE EXCEPTION 'FAIL glob=%',r_glob; END IF;

  RAISE NOTICE 'ALL HALT TESTS PASSED';

  DELETE FROM public.kill_switches WHERE id IN (ksG, ksC);
  DELETE FROM public.exchange_connections WHERE id IN (connA, connA2);
END $$;
