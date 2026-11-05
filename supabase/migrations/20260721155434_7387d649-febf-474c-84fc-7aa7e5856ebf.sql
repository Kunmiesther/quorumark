
-- 1) Outcomes: allow one active row per (signal_id, window_key); corrections append via supersedes_id
ALTER TABLE public.scout_outcomes DROP CONSTRAINT IF EXISTS scout_outcomes_signal_id_key;
CREATE UNIQUE INDEX IF NOT EXISTS scout_outcomes_signal_window_active_uidx
  ON public.scout_outcomes (signal_id, window_key)
  WHERE supersedes_id IS NULL;

-- 2) Atomic per-scan persistence RPC
CREATE OR REPLACE FUNCTION public.scout_persist_scan(
  _scan_id uuid,
  _now_ms bigint,
  _evidence_schema_version integer,
  _rules_version integer,
  _entries jsonb
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user uuid := auth.uid();
  v_entry jsonb;
  v_ev jsonb;
  v_symbol text;
  v_signal_id uuid;
  v_transition jsonb;
  v_next jsonb;
  v_entries_count int;
  v_prev_scan uuid;
  v_persisted int := 0;
  v_skipped int := 0;
BEGIN
  IF v_user IS NULL THEN
    RAISE EXCEPTION 'unauthenticated' USING ERRCODE = '42501';
  END IF;
  IF _scan_id IS NULL OR _entries IS NULL OR jsonb_typeof(_entries) <> 'array' THEN
    RAISE EXCEPTION 'scan_id and entries required';
  END IF;
  v_entries_count := jsonb_array_length(_entries);
  IF v_entries_count > 100 THEN
    RAISE EXCEPTION 'too many entries: %', v_entries_count;
  END IF;
  IF _evidence_schema_version IS DISTINCT FROM 1 OR _rules_version IS DISTINCT FROM 1 THEN
    RAISE EXCEPTION 'version mismatch (evidence=%, rules=%)', _evidence_schema_version, _rules_version;
  END IF;

  -- Confirm the scan row belongs to caller (never trust arbitrary user_id from client)
  PERFORM 1 FROM public.scout_scans WHERE id = _scan_id AND user_id = v_user;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'scan not owned by caller' USING ERRCODE = '42501';
  END IF;

  FOR v_entry IN SELECT jsonb_array_elements(_entries) LOOP
    v_symbol := v_entry->>'symbol';
    v_signal_id := NULLIF(v_entry->>'signal_id','')::uuid;
    v_transition := v_entry->'transition';
    v_next := v_entry->'next_state';

    IF v_symbol IS NULL OR v_signal_id IS NULL THEN
      CONTINUE;
    END IF;

    PERFORM 1 FROM public.scout_signals
      WHERE id = v_signal_id AND user_id = v_user AND scan_id = _scan_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'signal_id % not owned or wrong scan', v_signal_id USING ERRCODE = '42501';
    END IF;

    IF jsonb_array_length(COALESCE(v_entry->'evidence','[]'::jsonb)) > 7 THEN
      RAISE EXCEPTION 'too many evidence rows for symbol %', v_symbol;
    END IF;

    FOR v_ev IN SELECT jsonb_array_elements(COALESCE(v_entry->'evidence','[]'::jsonb)) LOOP
      INSERT INTO public.scout_evidence (
        user_id, signal_id, scan_id, symbol, timeframe,
        state, score, reasons, last_closed_ts, stale,
        direction, weighted_score, evidence, candle_count,
        last_closed_ts_ms, age_ms, fresh, missing_fields,
        evidence_schema_version, rules_version
      ) VALUES (
        v_user, v_signal_id, _scan_id, v_symbol, v_ev->>'timeframe',
        COALESCE(v_ev->>'state','unavailable'),
        COALESCE((v_ev->>'score')::numeric, 0),
        COALESCE((SELECT array_agg(x)::text[] FROM jsonb_array_elements_text(v_ev->'reasons') x), '{}'),
        NULLIF(v_ev->>'last_closed_ts_ms','')::bigint,
        COALESCE((v_ev->>'stale')::boolean, false),
        NULLIF(v_ev->>'direction',''),
        NULLIF(v_ev->>'weighted_score','')::numeric,
        v_ev->'evidence',
        NULLIF(v_ev->>'candle_count','')::int,
        NULLIF(v_ev->>'last_closed_ts_ms','')::bigint,
        NULLIF(v_ev->>'age_ms','')::bigint,
        NULLIF(v_ev->>'fresh','')::boolean,
        COALESCE((SELECT array_agg(x)::text[] FROM jsonb_array_elements_text(v_ev->'missing_fields') x), '{}'),
        _evidence_schema_version, _rules_version
      )
      ON CONFLICT (signal_id, timeframe) DO UPDATE SET
        state = EXCLUDED.state,
        score = EXCLUDED.score,
        reasons = EXCLUDED.reasons,
        last_closed_ts = EXCLUDED.last_closed_ts,
        stale = EXCLUDED.stale,
        direction = EXCLUDED.direction,
        weighted_score = EXCLUDED.weighted_score,
        evidence = EXCLUDED.evidence,
        candle_count = EXCLUDED.candle_count,
        last_closed_ts_ms = EXCLUDED.last_closed_ts_ms,
        age_ms = EXCLUDED.age_ms,
        fresh = EXCLUDED.fresh,
        missing_fields = EXCLUDED.missing_fields;
    END LOOP;

    IF v_next IS NOT NULL THEN
      PERFORM 1 FROM public.scout_signal_state
        WHERE user_id = v_user AND symbol = v_symbol FOR UPDATE;

      SELECT last_scan_id INTO v_prev_scan
        FROM public.scout_signal_state
        WHERE user_id = v_user AND symbol = v_symbol;

      IF v_prev_scan IS NOT DISTINCT FROM _scan_id THEN
        v_skipped := v_skipped + 1;
      ELSE
        INSERT INTO public.scout_signal_state (
          user_id, symbol, state, direction, weighted_score,
          aligned_streak, entered_at, last_scan_id, prior_state,
          reason_codes, state_schema_version
        ) VALUES (
          v_user, v_symbol,
          v_next->>'state',
          COALESCE(v_next->>'direction','none'),
          COALESCE((v_next->>'weighted_score')::numeric, 0),
          COALESCE((v_next->>'aligned_streak')::int, 0),
          to_timestamp(COALESCE(NULLIF(v_next->>'entered_at_ms','')::bigint, _now_ms) / 1000.0),
          _scan_id,
          v_next->>'prior_state',
          COALESCE((SELECT array_agg(x)::text[] FROM jsonb_array_elements_text(v_next->'reason_codes') x), '{}'),
          COALESCE((v_next->>'state_schema_version')::int, 1)
        )
        ON CONFLICT (user_id, symbol) DO UPDATE SET
          state = EXCLUDED.state,
          direction = EXCLUDED.direction,
          weighted_score = EXCLUDED.weighted_score,
          aligned_streak = EXCLUDED.aligned_streak,
          entered_at = EXCLUDED.entered_at,
          last_scan_id = EXCLUDED.last_scan_id,
          prior_state = EXCLUDED.prior_state,
          reason_codes = EXCLUDED.reason_codes;

        IF v_transition IS NOT NULL AND jsonb_typeof(v_transition) = 'object' THEN
          INSERT INTO public.scout_state_transitions (
            user_id, symbol, scan_id, from_state, to_state,
            direction, weighted_score, reason_codes, state_schema_version
          ) VALUES (
            v_user, v_symbol, _scan_id,
            v_transition->>'from',
            v_transition->>'to',
            COALESCE(v_transition->>'direction','none'),
            COALESCE((v_transition->>'weighted_score')::numeric, 0),
            COALESCE((SELECT array_agg(x)::text[] FROM jsonb_array_elements_text(v_transition->'reason_codes') x), '{}'),
            COALESCE((v_transition->>'state_schema_version')::int, 1)
          )
          ON CONFLICT (user_id, symbol, scan_id) DO NOTHING;
        END IF;
        v_persisted := v_persisted + 1;
      END IF;
    END IF;
  END LOOP;

  RETURN jsonb_build_object('persisted', v_persisted, 'skipped', v_skipped, 'scan_id', _scan_id);
END;
$$;

REVOKE ALL ON FUNCTION public.scout_persist_scan(uuid, bigint, integer, integer, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.scout_persist_scan(uuid, bigint, integer, integer, jsonb) FROM anon;
GRANT EXECUTE ON FUNCTION public.scout_persist_scan(uuid, bigint, integer, integer, jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.scout_persist_scan(uuid, bigint, integer, integer, jsonb) TO service_role;
