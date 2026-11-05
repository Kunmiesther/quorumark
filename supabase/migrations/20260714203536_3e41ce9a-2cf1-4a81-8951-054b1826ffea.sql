
-- P1 CONNECTION ISOLATION: schema + backfill + RLS
-- Non-destructive. Backfills to oldest connection per user. Never deletes data.

-- 1) ADD nullable connection_id columns
ALTER TABLE public.user_strategy   ADD COLUMN IF NOT EXISTS connection_id uuid;
ALTER TABLE public.strategy_state  ADD COLUMN IF NOT EXISTS connection_id uuid;
ALTER TABLE public.positions       ADD COLUMN IF NOT EXISTS connection_id uuid;
ALTER TABLE public.orders          ADD COLUMN IF NOT EXISTS connection_id uuid;
ALTER TABLE public.trades          ADD COLUMN IF NOT EXISTS connection_id uuid;

-- 2) BACKFILL: oldest exchange_connections per user (created_at asc, id asc)
WITH oldest AS (
  SELECT DISTINCT ON (user_id) user_id, id
  FROM public.exchange_connections
  ORDER BY user_id, created_at ASC, id ASC
)
UPDATE public.user_strategy t SET connection_id = o.id
FROM oldest o WHERE t.user_id = o.user_id AND t.connection_id IS NULL;

WITH oldest AS (
  SELECT DISTINCT ON (user_id) user_id, id
  FROM public.exchange_connections
  ORDER BY user_id, created_at ASC, id ASC
)
UPDATE public.strategy_state t SET connection_id = o.id
FROM oldest o WHERE t.user_id = o.user_id AND t.connection_id IS NULL;

WITH oldest AS (
  SELECT DISTINCT ON (user_id) user_id, id
  FROM public.exchange_connections
  ORDER BY user_id, created_at ASC, id ASC
)
UPDATE public.positions t SET connection_id = o.id
FROM oldest o WHERE t.user_id = o.user_id AND t.connection_id IS NULL;

WITH oldest AS (
  SELECT DISTINCT ON (user_id) user_id, id
  FROM public.exchange_connections
  ORDER BY user_id, created_at ASC, id ASC
)
UPDATE public.orders t SET connection_id = o.id
FROM oldest o WHERE t.user_id = o.user_id AND t.connection_id IS NULL;

WITH oldest AS (
  SELECT DISTINCT ON (user_id) user_id, id
  FROM public.exchange_connections
  ORDER BY user_id, created_at ASC, id ASC
)
UPDATE public.trades t SET connection_id = o.id
FROM oldest o WHERE t.user_id = o.user_id AND t.connection_id IS NULL;

-- 3) FKs ON DELETE RESTRICT (idempotent via NOT EXISTS)
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='user_strategy_connection_id_fkey') THEN
    ALTER TABLE public.user_strategy ADD CONSTRAINT user_strategy_connection_id_fkey
      FOREIGN KEY (connection_id) REFERENCES public.exchange_connections(id) ON DELETE RESTRICT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='strategy_state_connection_id_fkey') THEN
    ALTER TABLE public.strategy_state ADD CONSTRAINT strategy_state_connection_id_fkey
      FOREIGN KEY (connection_id) REFERENCES public.exchange_connections(id) ON DELETE RESTRICT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='positions_connection_id_fkey') THEN
    ALTER TABLE public.positions ADD CONSTRAINT positions_connection_id_fkey
      FOREIGN KEY (connection_id) REFERENCES public.exchange_connections(id) ON DELETE RESTRICT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='orders_connection_id_fkey') THEN
    ALTER TABLE public.orders ADD CONSTRAINT orders_connection_id_fkey
      FOREIGN KEY (connection_id) REFERENCES public.exchange_connections(id) ON DELETE RESTRICT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='trades_connection_id_fkey') THEN
    ALTER TABLE public.trades ADD CONSTRAINT trades_connection_id_fkey
      FOREIGN KEY (connection_id) REFERENCES public.exchange_connections(id) ON DELETE RESTRICT;
  END IF;
END $$;

-- Indexes
CREATE INDEX IF NOT EXISTS positions_user_conn_idx      ON public.positions      (user_id, connection_id);
CREATE INDEX IF NOT EXISTS orders_user_conn_idx         ON public.orders         (user_id, connection_id);
CREATE INDEX IF NOT EXISTS trades_user_conn_idx         ON public.trades         (user_id, connection_id);
CREATE INDEX IF NOT EXISTS strategy_state_user_conn_idx ON public.strategy_state (user_id, connection_id);
CREATE INDEX IF NOT EXISTS positions_conn_idx      ON public.positions      (connection_id);
CREATE INDEX IF NOT EXISTS orders_conn_idx         ON public.orders         (connection_id);
CREATE INDEX IF NOT EXISTS trades_conn_idx         ON public.trades         (connection_id);

-- PK evolution — only if all rows backfilled (non-destructive precondition)
DO $$
DECLARE
  us_null_count int;
  ss_null_count int;
BEGIN
  SELECT count(*) INTO us_null_count FROM public.user_strategy WHERE connection_id IS NULL;
  IF us_null_count = 0 THEN
    ALTER TABLE public.user_strategy ALTER COLUMN connection_id SET NOT NULL;
    IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname='user_strategy_pkey') THEN
      ALTER TABLE public.user_strategy DROP CONSTRAINT user_strategy_pkey;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='user_strategy_pkey' AND contype='p') THEN
      ALTER TABLE public.user_strategy ADD CONSTRAINT user_strategy_pkey PRIMARY KEY (user_id, connection_id);
    END IF;
    RAISE NOTICE 'user_strategy PK -> (user_id, connection_id)';
  ELSE
    RAISE NOTICE 'user_strategy PK unchanged: % rows have NULL connection_id', us_null_count;
  END IF;

  SELECT count(*) INTO ss_null_count FROM public.strategy_state WHERE connection_id IS NULL;
  IF ss_null_count = 0 THEN
    ALTER TABLE public.strategy_state ALTER COLUMN connection_id SET NOT NULL;
    IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname='strategy_state_pkey') THEN
      ALTER TABLE public.strategy_state DROP CONSTRAINT strategy_state_pkey;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='strategy_state_pkey' AND contype='p') THEN
      ALTER TABLE public.strategy_state ADD CONSTRAINT strategy_state_pkey PRIMARY KEY (user_id, connection_id, strategy);
    END IF;
    RAISE NOTICE 'strategy_state PK -> (user_id, connection_id, strategy)';
  ELSE
    RAISE NOTICE 'strategy_state PK unchanged: % rows have NULL connection_id', ss_null_count;
  END IF;
END $$;

-- 4) SIX-CONNECTION CAP trigger + slot function
CREATE OR REPLACE FUNCTION public.enforce_max_connections()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
DECLARE
  active_count int;
BEGIN
  -- Row-level lock on the user's existing rows to avoid concurrent races.
  PERFORM 1 FROM public.exchange_connections
    WHERE user_id = NEW.user_id
    FOR UPDATE;
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

DROP TRIGGER IF EXISTS exchange_connections_max_cap ON public.exchange_connections;
CREATE TRIGGER exchange_connections_max_cap
  BEFORE INSERT ON public.exchange_connections
  FOR EACH ROW EXECUTE FUNCTION public.enforce_max_connections();

CREATE OR REPLACE FUNCTION public.is_connection_slot_available(_user_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT COALESCE(
    (SELECT count(*) FROM public.exchange_connections
     WHERE user_id = _user_id
       AND status NOT IN ('disconnected','disabled')),
    0) < 6
$$;

GRANT EXECUTE ON FUNCTION public.is_connection_slot_available(uuid) TO authenticated;

-- 5) PER-CONNECTION IDEMPOTENCY NAMESPACES
-- orders.client_order_id: global UNIQUE -> per-connection UNIQUE
ALTER TABLE public.orders DROP CONSTRAINT IF EXISTS orders_client_order_id_key;
DROP INDEX IF EXISTS public.orders_client_order_id_key;
CREATE UNIQUE INDEX IF NOT EXISTS orders_conn_client_order_id_uniq
  ON public.orders (connection_id, client_order_id);

-- order_audit: extend idempotency uniqueness with connection_id
DROP INDEX IF EXISTS public.order_audit_idem_phase_uniq;
CREATE UNIQUE INDEX IF NOT EXISTS order_audit_conn_idem_phase_uniq
  ON public.order_audit (connection_id, idempotency_key, phase)
  WHERE idempotency_key IS NOT NULL;

-- 6) RLS verification: existing user_id-scoped policies already isolate users.
-- A user owns all their connections, so cross-connection reads within the same
-- user remain allowed (as required). exchange_credentials + kill_switches keep
-- their service-role-only posture (no client policies added).

-- 7) ISOLATION guarantees:
--   * Uniques are now scoped by connection_id (orders_conn_client_order_id_uniq,
--     order_audit_conn_idem_phase_uniq) -> collisions on one connection cannot
--     block another.
--   * The cap trigger locks only rows for NEW.user_id, never other users'.
--   * FK ON DELETE RESTRICT prevents connection deletion from cascading into
--     trade history.
