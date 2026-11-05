# Paper Engine Architecture

_Status: Phase 3 mapping (2026-07-21). Compatibility facade landed; deeper
decomposition is Phase 4 work — see "Remaining work" at the bottom._

## Purpose

`src/lib/paper/engine.ts` runs the simulation-only paper trading tick:
market-data acquisition → strategy evaluation → risk gates → Onyx decision →
order/fill simulation → position/accounting mutation → metrics. It is **never**
allowed to talk to the signer, execution-broker, exchange credentials, or any
`orders*` / `order_intents` / `order_audit` table. `is_live` stays `false`.

## Public surface (compatibility facade)

Callers of the paper engine, verified via `rg`:

| Caller | Imported names |
| --- | --- |
| `src/lib/paper/paper.functions.ts` | `runPaperTick` |
| `src/routes/api/public/hooks/paper-tick.ts` | `runPaperTick` (dynamic import) |
| `src/routes/_authenticated/paper.tsx` | `WALLET_BASE`, `STARTING_ACCOUNT_BALANCE`, `MAX_HEAT`, `MMR`, `TARGET_LEVERAGE`, `TAKER_BPS`, `SLIP_BPS` |
| `src/lib/paper/max-loss.test.ts` | `shouldTriggerMaxLoss`, `MAX_LOSS_MARGIN_FRAC` |

Phase 3 keeps every one of these names exported from `@/lib/paper/engine`. New
modules extracted underneath (currently `./constants.ts`) are re-exported.

## Entry points

- **Cron / production**: `POST /api/public/hooks/paper-tick`
  (`src/routes/api/public/hooks/paper-tick.ts`). Bearer-authed with
  `PAPER_TICK_CRON_SECRET` (Phase 1). Fans out over users active in the last 7
  days, capped at `MAX_USERS_PER_TICK = 50`, and for each user:
  1. Calls RPC `claim_paper_tick(_user_id)` — durable per-(user, minute) lease.
  2. On `true`, invokes `runPaperTick(supabaseAdmin, userId)`.
  3. Failures are counted but never abort the batch (per-user try/catch).
- **Manual**: `runPaperTickFn` server function
  (`src/lib/paper/paper.functions.ts`), authenticated via
  `requireSupabaseAuth`, same lease → same `runPaperTick`.

Both entry points share the Phase 1 lease. Neither runs from the browser.

## Current tick stage sequence (as-is)

`runPaperTick(supabase, userId)` in `engine.ts` still performs all stages in a
single file. High-level flow:

1. **Load user config** — `paper_test_symbols` (enabled symbols + tick +
   `max_leverage`), `paper_accounts` (shared cross-margin balance).
2. **Load open book** — `paper_positions where status='open' and user_id=?`.
3. **Market data** (per symbol) — `fetchApexKlines(...)` from `./feed.ts`.
   Public REST `GET /api/v3/klines` on ApeX Omni. Returns only completed
   candles, ascending.
4. **Regime classification** — `classifyRegime` from `./regime.ts` per symbol.
5. **Signal evaluation** — `./signal.ts` (accumulator break-and-retest),
   `./sniper.ts`, `./hunter.ts`, gated by `./eligibility.ts` and `./routing.ts`.
6. **Phase A — Candidate collection** — build the entry candidate list and
   the open-book context.
7. **Phase B — Onyx decision** — `src/lib/onyx/decide.ts` ranks and picks
   entries/exits under `ONYX_MAX_TOTAL_OPEN` / `ONYX_MAX_ALT_POSITIONS` caps.
8. **Phase C — Execution** — synthetic fills against the newest candle:
   opens (laddered limit-maker via `./ladder.ts`), adds (accumulator DCA via
   `./accumulator-dca.ts`), reduces on per-rung TP, closes on stop / max-loss
   / Scout BOS. Balances update `paper_accounts.balance` (shared pool);
   position rows and `paper_trades` rows are written per event.
9. **Metrics/telemetry** — `bot_events` writes, `last_tick_at` bump on
   `paper_wallets`, `last_processed_candle_ts_ms` cursor advance.

## Database writes (per tick)

| Table | Operations | Notes |
| --- | --- | --- |
| `paper_accounts` | `UPDATE balance` (shared cross pool) | One row per user |
| `paper_positions` | `INSERT` (open), `UPDATE` (add rung / reduce / close), atomic compare-and-swap on close (Phase 2 style fix) | `status ∈ {'open','closed'}` |
| `paper_trades` | `INSERT` per fill/reduce/close | Immutable event log |
| `paper_wallets` | `UPDATE last_tick_at`, cursor | Per (user, wallet_key) |
| `paper_tick_leases` | `INSERT` via `claim_paper_tick` RPC | Phase 1 lease |
| `bot_events` | `INSERT` telemetry | Best-effort |

Retry/idempotency assumptions today:
- Per-(user, minute) lease prevents duplicate ticks at the entry point.
- Close path uses compare-and-swap on `status='open'` (documented in the
  earlier double-close bugfix) so concurrent tick attempts cannot double-close.
- Fill/PnL are computed inside the tick and applied once per stage; there is
  no engine-level idempotency key beyond the lease.

## Known risk hot-spots (Phase 4 targets)

- Non-atomic multi-row updates: an open path writes to `paper_positions`,
  `paper_trades`, and `paper_accounts` in separate statements. A partial
  failure between them leaves state inconsistent for that user until the next
  successful tick reconciles cash and open notional.
- Best-effort `bot_events` writes are intentionally best-effort (telemetry).
- Market-data fetch has no explicit timeout — a slow ApeX response can stall
  a single user's tick. The per-user try/catch prevents batch abort but does
  not bound wall-clock.
- Duplicate calculations: TP price, effective leverage, and rung geometry
  are computed both in `engine.ts` and in `./ladder.ts` / `./dca.ts` /
  `./accumulator-dca.ts`. Semantics agree today (tests enforce it) but the
  engine's private copies are candidates for consolidation.
- `ANCHOR_BASES` is module-local and only referenced by the engine's routing
  code — safe as-is.

## Phase 3 change summary

- Added `src/lib/paper/constants.ts` holding every numeric constant plus
  `shouldTriggerMaxLoss` and `effectiveLeverage`. Values are byte-identical
  to the previous inline definitions; a snapshot test guards the surface.
- `engine.ts` re-exports those symbols so no caller changed.
- Added source-contract tests: no circular deps inside `src/lib/paper/`,
  facade preserves the previously exported names, constants unchanged.

No strategy math, sizing, leverage, fees, PnL formulas, fill semantics, UI,
Life Map, wallet flows, broker/signer auth, or credential handling were
touched. No migrations. No dependency changes.

## Phase 4A change summary

- Added `src/lib/paper/market.ts` — bounded wall-clock wrapper around
  `fetchApexKlines`. Provider and price semantics are byte-identical
  (feed pass-through); only adds a typed `MarketResult` and a hard
  timeout so market-data slowness cannot stall a user's tick.
- Added `src/lib/paper/operations.ts` — `StageResult<T>` typed
  sanitized stage-failure envelope and `claimEngineOperation` /
  `completeEngineOperation` wrappers over the new SECURITY DEFINER
  RPCs. Wrappers never surface DB error text; every failure collapses
  to a typed `internal` reason.
- Migration `paper_engine_operations` — append-only per-user
  operation ledger with strong `(user_id, op_key)` uniqueness, request
  fingerprint, state, result, and timestamps. Authenticated grants are
  `SELECT`-only (own rows via RLS); writes exclusively through the
  claim/complete SECURITY DEFINER RPCs. `service_role` bypasses the
  ownership check by design to permit the Phase 1 cron path.
- RPC contract: first caller → `claimed`; same fingerprint replay →
  `replayed` with prior stored result; different fingerprint →
  `conflict`; any DB error → fail-closed `error`; concurrent callers
  yield exactly one owner (guaranteed by the unique constraint +
  `INSERT ... ON CONFLICT DO NOTHING RETURNING`).

Phase 4A does not modify strategy, sizing, leverage, fees, PnL, fill
semantics, UI, wallet, Life Map, broker/signer authority, or the
Phase 1 lease. The engine facade is unchanged — later slices will wire
these primitives into `runPaperTick`.

## Phase 4B change summary

- Atomic mutation RPCs (`paper_open_position`, `paper_add_rung`,
  `paper_reduce_position`, `paper_close_position`) landed as
  SECURITY DEFINER functions keyed on the Phase 4A ledger. Each RPC
  combines every required `paper_positions` / `paper_trades` /
  `paper_wallets` / `paper_accounts` write into a single transaction
  with row-level CAS on `status='open'`.
- `src/lib/paper/repository.ts` exposes typed TS wrappers.
- `runPaperTick` now calls those wrappers for floor liquidation,
  per-lot scale-outs, hard stops, rung fills, entry execution, and
  Onyx/Scout-directed exits. The tick-tail aggregate `paper_accounts`
  write was removed to prevent double-counting; `accountBalance` /
  `realizedDelta` are local mirrors kept in sync with each RPC result.
- `fetchCandlesBounded` is the sole market-data path, so one user's
  slow ApeX response cannot stall the batch.

## Phase 4C change summary

- **Extracted modules** (dependency direction, all one-way):
  - `types.ts` — `PaperSymbol`, `WalletKey`, `EvalReason`,
    `EvaluationDetail`, `TickResult`, and the pure `walletKey` helper.
    Type-only imports from `signal`, `regime`, `routing`, `@/lib/onyx/decide`.
  - `pricing.ts` — pure slip / percent-distance / TP-validity /
    pivot-selection / protective-swing / adverse-BOS helpers. Depends only
    on `./constants` and `./signal` (types).
  - `telemetry.ts` — best-effort `emitBotEvent` wrapper; sibling-leaf.
- **Facade unchanged**: `engine.ts` re-exports the pre-existing public
  surface (`PaperSymbol`, `WalletKey`, `EvalReason`, `EvaluationDetail`,
  `TickResult`, `walletKey`, `mirrorTpFromStop`, `protectiveSwingForOpen`,
  `isAdverseBos`, plus every Phase 3 constant/helper via
  `./constants`) so no caller changes.
- **Telemetry hardening**: five inline `try { supabase.from("bot_events")
  .insert(...) } catch {}` sites collapsed into `emitBotEvent(...)`
  calls. Best-effort semantics preserved (the wrapper never throws).
- **No parity risk**: strategy math, sizing, leverage, fees, PnL,
  price selection, TP/rung geometry, fill semantics, wallet flows, UI,
  scheduler/lease behavior, and every Phase 4A/4B safety contract are
  unchanged. All 274 tests pass; `tsgo` clean.

### Final module graph (sibling relative-import edges)

```
constants.ts   ← engine.ts, pricing.ts
types.ts       ← engine.ts        (type-only: signal, regime, routing, onyx/decide)
pricing.ts     ← engine.ts        (deps: constants, signal-types)
telemetry.ts   ← engine.ts        (pure leaf)
market.ts      ← engine.ts        (deps: feed)
operations.ts  ← engine.ts, repository.ts
repository.ts  ← engine.ts        (deps: operations)
```

Acyclic by construction; enforced by the `facade.test.ts` graph tests.

## Remaining work (Phase 4D+)

`engine.ts` is 1,607 lines after 4C — below the pre-4B 1,694 baseline
but above the 4C stretch target of ≤400. The remaining monolith is
`runPaperTick` itself. **Named blockers** for further reduction:

1. **Cross-stage local state**: `accountBalance`, `realizedDelta`,
   `openByWallet`, `walletsByKey`, `perSymbol`, `evaluations`,
   `candidateExtras`, `openedBySymbol`, `closedBySymbol` are read and
   written across Stages 2 → 9. Extracting a stage requires either
   passing this state as a mutable context object (parity risk unless
   guarded by seeded fixtures) or restructuring to return-then-merge
   (touches PnL math). Neither is safe without a deterministic
   parity harness that does not yet exist.
2. **Onyx handshake ordering**: Phase B (`decide.ts` call), Phase C
   closes, and Phase C opens must run in that order against the SAME
   `markPortfolio()` mirror. Splitting Phase C into a separate module
   forces an explicit portfolio-mark contract; deferred pending a
   dedicated parity test.
3. **Duplicate TP / rung geometry**: `ladder.ts`, `dca.ts`,
   `accumulator-dca.ts`, and the manage block each compute rung
   levels and TP. Semantics agree today (tests enforce it) but a
   consolidation requires a full parity sweep across all three legs.

Steps 2 (open/add/close transactional RPC), 4 (bounded market data),
5a (constants extraction), and 5b (types/pricing/telemetry extraction)
from the earlier roadmap are DONE. What remains is the orchestrator
split guarded by a seeded per-stage fixture — a Phase 4D deliverable
because it MUST NOT ship without that fixture.

