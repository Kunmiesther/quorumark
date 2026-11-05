# MAINNET PARITY — Paper ↔ Live Decision-Logic Audit

**Status:** Phase 1 report (audit only, no code changes in this pass).
**Owner mandate:** *"Every strategy, risk, and exit behavior built for the
paper engine MUST be mirrored into the live execution path in the same
workstream. Paper and mainnet are one brain with two hands."*

**Activation gates unchanged by this document:**

- `signer/app/main.py` — `is_live` defaults `False`; `SIGN_ORDER`
  disabled (`signer/app/main.py:141,168`).
- `bot_worker.py` — hardcodes `body["is_live"] = False` before every
  signer call (`bot_worker.py:1055`).
- `broker/src/server.ts` — `SIGN_ORDER` in the disabled ops list
  (`broker/src/server.ts:85`).

This document catalogs **decision-making** parity only. Signing,
funding, credential, and kill-switch gates remain owner-controlled and
are *out of scope* for parity work — they are the activation ceremony.

---

## 1. Decision-Behavior Inventory

Legend for **Live Path Status**:

- ✅ **CONSUMED** — live path already calls or embeds the same rule
  the paper engine uses (either the same file, or a Python mirror
  reading the same constants).
- 🟡 **DIVERGENT** — the rule exists on both sides but as independent
  implementations (different code, different constants, or subtly
  different math). Parity work required.
- 🔴 **MISSING** — live path has no equivalent behavior. Parity work
  required.
- ⚫ **PAPER-INTERNAL (allowed)** — the rule is inherent to the paper
  simulation (fee/slip modeling, wallet bookkeeping) and has no live
  analogue by design.

| # | Behavior | Paper source of truth | Live path status | Notes |
|---|----------|----------------------|------------------|-------|
| 1 | **Regime classifier** (`trend`/`neutral`/`high_vol`) | `src/lib/paper/regime.ts` | 🔴 MISSING on `bot_worker.py`; scout-guardian does not classify regime. | Live path today acts on directives only. If Onyx/Scout regime routing is to remain the strategic authority, the live worker must consume the same regime verdict (either via a JSON directive or by running the same classifier in Python). |
| 2 | **Regime → strategy routing** (`hunter`/`accumulator`/`sniper`) | `src/lib/paper/routing.ts::legForRegime` | 🔴 MISSING | Live worker doesn't gate entries on regime today. |
| 3 | **Hunter (FVG) armed detector** | `src/lib/paper/hunter.ts` | ✅ CONSUMED (thresholds shared via DEBT-01) | `hunter_signal.py` remains a separate Python implementation, but all thresholds (ATR period, ATR-SMA period, pivot L/R) now load from `shared/mainnet_parity_constants.json`. Algorithmic parity still requires a code diff pass — tracked by DEBT-05 fixtures. |
| 4 | **Sniper (zone reversal / fakeout) detector** | `src/lib/paper/sniper.ts` | ✅ CONSUMED (thresholds shared via DEBT-01) | `sniper_signal.py` — all zone/regime/continuation thresholds now load from shared JSON. Algorithmic parity: DEBT-05 fixtures. |
| 4a | **Sniper profile — shallow ladder + volatility-scaled early TP** | `src/lib/paper/sniperProfile.ts` (consumes `sniper.max_rungs`, `sniper.tp_atr_mult`, `sniper.tp_min_net_pct`) | 🔴 MISSING (live path) | Sniper positions use 2 rungs (initial + 1 add) and a TP at `max(1.0 × ATR(14), avgEntry × 0.0015)` from the CURRENT avg entry (recomputed on rung fills). Promotion still applies — early TP is the default exit, promotion is the exception path. Live worker MUST mirror rung count + early-TP recompute before sniper trades live. |
| 5 | **Accumulator (break-and-retest) detector** | `src/lib/paper/accumulator-dca.ts` / `signal.ts` | ✅ CONSUMED (thresholds shared via DEBT-01) | `accumulator_signal.py` — pivot L/R, lookback, retest window, ATR/EMA periods, zone-ATR-mult all load from shared JSON. Parity test `bos_5m_bearish` locks the detector output. |
| 6 | **Entry eligibility (freshness window)** | `src/lib/paper/eligibility.ts` | 🟡 DIVERGENT (value discrepancy §7) | Freshness window differs: TS=3, Python live=1. Both values pinned in shared JSON under distinct keys; reconciliation is owner-gated. |
| 7 | **Entry guard (regime-authorized formation)** | `src/lib/paper/entryGuard.ts::evaluateEntryAuthorization` | 🔴 MISSING | Live worker has no equivalent `wait_regime` fail-closed gate. |
| 8 | **Ladder policy (8-rung canonical, TP per rung, arming rule)** | `src/lib/paper/ladder.ts`, `src/lib/paper/ladder-policy.ts` | ✅ CONSUMED (thresholds shared via DEBT-01) | Total margin, min/max rungs, span ROI, span cap, per-rung TP %, ladder-contract version, and `LADDER_STRATEGIES` all load from shared JSON. Parity test `ladder_8rung_btc_100x` locks the derivation. |
| 9 | **Fixed TP geometry (`+1 %` per rung; TP-to-stop ratio; min structural distance)** | `src/lib/paper/constants.ts` | 🟡 DIVERGENT (value discrepancy §7) | Paper uses per-rung geometric +1 %; Python `accumulator_exit.py` uses margin-ROI ladder (200/300/400 %). Both semantics documented; consolidation is owner-gated (DEBT-06 extension). |
| 10 | **Hard max-loss cap (`shouldTriggerMaxLoss`)** | `src/lib/paper/constants.ts` (loads `MAX_LOSS_MARGIN_FRAC` from shared JSON) | 🔴 MISSING (live path) | Threshold now shared; the trigger function itself is DEBT-02. |
| 11 | **Guardian directive consumption (`cancel_unfilled_rungs`, `close_position`, `promote_runner`, `cancel_fixed_tp`, `set_breakeven_stop`, `repair_stop`)** | Paper engine reads `scout_guardian_directives` in `src/lib/paper/engine.ts`; worker enqueues via `worker-ingest::GUARDIAN_DIRECTIVE_UPSERT`. | ✅ CONSUMED — wired-and-served | Base pair locked by the Python parity test. Live-Readiness pass extends the CHECK constraint + edge-function allow-list with the four promotion/repair types; engine acknowledges them without double-applying (see `src/lib/paper/__tests__/workerPromotionAck.test.ts`). |
| 12 | **Scout BOS defensive layer (adverse BOS → close)** | `src/lib/paper/engine.ts` | ✅ CONSUMED (thresholds shared via DEBT-01) | `scout_guardian.py` now loads guardian thresholds (rung-cancel %, cluster size, cluster drawdown %, rules version) from shared JSON. |
| 13 | **HTF (1-hour) BOS detector + promotion** | `src/lib/paper/htfBos.ts`, `htfPromotion.ts` | ✅ CONSUMED — wired-and-served | `htf_bos.py` + `worker_live_wiring.evaluate_htf_promotion` emit `promote_runner` / `cancel_fixed_tp` / `set_breakeven_stop` on aligned + profitable + not-promoted positions with `bank_fraction=0`. The paper engine performs the promotion itself and ack-noops the worker directives; the live broker path consumes them for real once activation opens. |
| 14 | **Correlation / cluster cap** (`GUARDIAN_CLUSTER_*`) | `scout_guardian.py::evaluate_cluster` | ✅ CONSUMED (live-first) | The cluster rule lives Python-first and is emitted as directives the paper engine also consumes. Designated source of truth: **Python**. Paper must not re-invent it. |
| 15 | **Deterministic Onyx approval / guardrails** | `src/lib/onyx/decide.ts`, `src/lib/onyx/guardrails.ts` | 🔴 MISSING | Live path has no Onyx approval gate today; it acts on guardian directives directly. If Onyx approval becomes an authority gate, the live path must consume the *same* verdict (e.g. an `onyx_decisions` row keyed to a proposal). |
| 16 | **Onyx bank-profit close threshold (`ONYX_BANK_PROFIT_MARGIN_ROI_PCT = 30`)** | `src/lib/paper/constants.ts` | 🟡 DIVERGENT / dormant | `ONYX_AI_ENABLED = false`, so the path is unreachable in paper today. Still, if enabled the same threshold must gate on the live path. |
| 17 | **Hedge review (fail-closed opposing formation)** | `src/lib/paper/hedgeReview.ts`, `hedge.ts` | 🔴 MISSING (live path) | `HEDGE_EXECUTION_ENABLED = true` in paper, but live worker has no equivalent capability check. Pending mandate: mirror the same fail-closed gates in Python before flipping any live execution. |
| 18 | **Leverage cap resolution** (`effectiveLeverage`, `exchange_leverage_caps`) | `src/lib/paper/constants.ts::effectiveLeverage` | ✅ CONSUMED | `accumulator_sizing.py::verify_leverage_supported` reads the same `exchange_leverage_caps` table. Confirm via parity test. |
| 19 | **Junk-symbol filter (volatility floor, quality)** | (paper: implicit via regime) | ✅ CONSUMED (live-only extras) | `junk_filter.py` runs ATR/volatility gates the paper engine does not. Not a divergence — additive safety on the live path. Document as **live-only augmentation**. |
| 20 | **Fee / slippage / PnL modeling** | `src/lib/paper/pricing.ts`, `constants.ts` (`FEE_RATE`, `SLIP_RATE`) | ⚫ PAPER-INTERNAL | Live PnL comes from venue fills. No parity required. |
| 21 | **Cross-margin wallet bookkeeping** | `src/lib/paper/repository.ts`, `operations.ts` | ⚫ PAPER-INTERNAL | Simulation-only. |

---

## 2. Shared-Logic Source-of-Truth Table

For every 🟡 DIVERGENT entry above, one side is designated authoritative and
the other side MUST be regenerated/pinned to it. Where the rule is pure
math (thresholds, windows, arming counts), the mechanism is a **shared
JSON constants file** committed at `shared/mainnet_parity_constants.json`,
loaded by:

- **TypeScript / paper engine** — imported from `src/lib/paper/constants.ts`
  which re-exports the JSON values (no numeric literals in TS).
- **Python / live worker** — loaded once at process start by
  `bot_worker.py` (and every strategy module) from the same file.

| Rule | Source of truth | Mirror side | Mechanism |
|------|-----------------|-------------|-----------|
| Regime classifier (§1.1) | **TypeScript** (`src/lib/paper/regime.ts`) | Python must consume regime as a directive/decision row (no re-implementation). | JSON: none required; contract is the `regime` string enum. |
| Regime routing (§1.2) | **TypeScript** (`src/lib/paper/routing.ts`) | Python reads assigned leg from the same decision row. | Enum contract shared via JSON (`legs: ["hunter","accumulator","sniper"]`). |
| Hunter thresholds (§1.3) | **JSON** (`HUNTER_K_THRESHOLD`, `HUNTER_RETRACE_WINDOW`) | Both sides load from JSON; no in-code numeric literals. | Shared JSON. |
| Sniper thresholds (§1.4) | **JSON** (ATR/EMA/VWAP periods, fakeout tolerances) | Both sides load from JSON. | Shared JSON. |
| Accumulator/pivot thresholds (§1.5) | **JSON** (pivot lookback, break confirmation, retest tolerance) | Both sides load from JSON. | Shared JSON. |
| Eligibility window (§1.6) | **JSON** (`ELIGIBILITY_MAX_BARS_SINCE = 3`) | Both sides load from JSON. | Shared JSON. |
| Entry guard (§1.7) | **TypeScript** (`entryGuard.ts`) | Python mirrors as a pure function on the loaded regime + leg. | Shared JSON for wait-regime enum. |
| Ladder policy (§1.8) | **JSON** (`EIGHT_RUNG_CANONICAL_SYMBOLS`, `LADDER_STRATEGIES`, per-rung TP %, total rungs, span %) | Both sides load from JSON. | Shared JSON. |
| Fixed TP geometry (§1.9) | **JSON** (`MIN_STRUCTURAL_TP_DISTANCE_PCT`, `MIN_TP_TO_STOP_DISTANCE_RATIO`) | Both sides load from JSON. | Shared JSON. |
| Max-loss cap (§1.10) | **JSON** (`MAX_LOSS_MARGIN_FRAC`) | Live Python must implement the same predicate. | Shared JSON + Python `shouldTriggerMaxLoss` port. |
| Adverse BOS (§1.12) | **Python** (`scout_guardian.py::detect_adverse_bos`) — this is already the enforcement path via directives. | TypeScript paper engine must consume the same directive (already does; strip any duplicated TS BOS math from the paper close path). | Directive schema is the contract. |
| HTF BOS (§1.13) | **TypeScript** (`src/lib/paper/htfBos.ts`) during observe-mode; **PROMOTION LOGIC MUST BE EXPRESSED AS DIRECTIVES** the live broker consumes. | Python worker consumes the promotion directive verbatim; does not re-derive HTF state. | JSON: HTF pivot params. Contract: new directive type (Phase 3). |
| Correlation/cluster (§1.14) | **Python** (`scout_guardian.py::evaluate_cluster`) | Paper engine consumes directives; no TS reimplementation permitted. | Directive schema. |
| Leverage cap (§1.18) | **DB table** `exchange_leverage_caps` | Both sides read the same table. | Already parity. |

**Rule of thumb:** thresholds and enums live in the shared JSON; pure
algorithmic rules live in whichever language got there first and are
mirrored line-for-line on the other side, with parity tests locking the
math (see §3).

### 2.a Effective TP (FIX 1 — TP mismatch, 2026-07-25, live-money-critical)

The exit loop compares the current bar against the EFFECTIVE tp:
`effectiveTp(direction, lot.tp, position.tp_level) = direction==='long' ? min(lot.tp, tp_level) : max(lot.tp, tp_level)`,
falling back to `lot.tp` when `tp_level` is missing / non-positive / NaN.

- TS source of truth: `src/lib/paper/effectiveTp.ts` (used by `src/lib/paper/engine.ts` exit loop).
- Python mirror: `effective_tp.py`. The live worker MUST call it wherever a rung TP is compared to price.
- Vanguard / accumulator legs additionally overwrite every `lot.tp` with `open.tp_level` on every re-average (see `engine.ts` rung-fill block) so the ladder-derived per-lot TP cannot drift from the structural target the UI shows. Sniper keeps its per-rung recompute; hunter keeps per-rung FVG TPs by design.
- Regression fixture: DOGE long, `tp_level = 0.072672`, `lot.tp = 0.074`, bar `high = 0.073109` → `tp_touch` at `0.072672`.

---



## 3. Parity Test Strategy

Parity tests are the permanent guard against drift. They live in two
places and consume the *same fixtures*:

- **TypeScript:** `src/lib/paper/__tests__/parity/*.test.ts`
- **Python:**    `tests/parity/*.py` (pytest, invoked from CI)

Both sides read fixtures from `tests/fixtures/parity/` — plain JSON
files containing:

- input candle series (5m and 1h),
- expected regime verdict,
- expected leg assignment,
- expected BOS state,
- expected entry guard outcome (`authorized` or `blockCode`),
- expected ladder plan (rung prices, TP per rung, arming rule),
- expected adverse-BOS directive (when triggered),
- expected max-loss trigger (when triggered).

Each side runs its own detector against the same input and asserts the
same output. Any drift fails CI on both language builds.

**Minimum fixture set for Phase 1 landing:**

1. `regime_trend_btc.json` — canonical trend regime, Accumulator arms.
2. `regime_neutral_eth.json` — canonical neutral regime, Sniper arms.
3. `regime_highvol_sol.json` — canonical high-vol regime, Hunter arms.
4. `bos_5m_bearish.json` — Scout adverse-BOS on a long position.
5. `bos_1h_bullish.json` — HTF BOS state persistence across 10 hours.
6. `entry_guard_wait_opposing.json` — regime=opposing_to_open_position, blocked.
7. `ladder_8rung_btc_100x.json` — full canonical ladder, TP per rung.
8. `max_loss_trigger.json` — position at −50 % margin, must trigger.

---

## 4. Definition of Done (Standing Practice)

**Every future strategy / risk / exit change is INCOMPLETE until all of
the following are true.** No exceptions. This section supersedes any
prior scope note that limited a workstream to the paper engine.

1. **Implemented on both sides.**
   The behavior exists in `src/lib/paper/*` **and** the live path
   (`bot_worker.py` / one of the `*_signal.py` / `scout_guardian.py`
   / `broker/` / `signer/`) reads the same source-of-truth constant or
   consumes the same directive schema.

2. **Listed in §1 of this document.**
   With current source-of-truth designation and status. If the change
   introduces new thresholds, they land in
   `shared/mainnet_parity_constants.json` (never as literals).

3. **Parity-tested.**
   A fixture-driven test exists in **both** `src/lib/paper/__tests__/parity/`
   and `tests/parity/` asserting the same input yields the same
   verdict on both sides.

4. **Full suites green.**
   `bunx vitest run` and `pytest -q` both green. `tsgo` clean.

5. **Activation gates untouched.**
   `is_live` still `False`, `SIGN_ORDER` still disabled, no credentials,
   no funding logic changes — unless the change explicitly IS an
   owner-ratified activation ceremony (separate workstream).

6. **Schema changes are explicit.**
   Any migration is listed in §5 below with reason and consuming side.

### Specific application to in-flight work

- **HTF BOS (Phase 1, this branch)** — landed observe-mode in TS only.
  This is a **known Phase-1 gap** consistent with the mandate because
  the behavior has *no gating effect yet*. Phase 3 promotion/trailing
  is where parity becomes mandatory: it MUST be expressed as
  directives/position-state the live broker consumes, not paper-only
  logic. That is a hard blocker on Phase 3 acceptance.

---

## 5. Schema-Change Log (parity-affecting)

| Date       | File                                       | Consumers                                                                                     | Reason |
|------------|--------------------------------------------|-----------------------------------------------------------------------------------------------|--------|
| 2026-07-24 | `shared/mainnet_parity_constants.json`     | TS `src/lib/paper/parityConstants.ts` → `constants.ts`, `signal.ts`, `hunter.ts`, `sniper.ts`, `eligibility.ts`, `ladder.ts`, `ladder-policy.ts`; Python `shared/parity_constants.py` → `accumulator_signal.py`, `hunter_signal.py`, `sniper_signal.py`, `scout_guardian.py` | DEBT-01: single source of truth for hunter/sniper/accumulator thresholds, eligibility window, ladder policy, TP geometry, max-loss cap, and the legs/regime/directive enums. Behavior value-identical to prior in-module literals except where §7 resolves a discrepancy. |

---

## 6. Open Parity Debts (tracked)

- [x] **DEBT-01** — Shipped `shared/mainnet_parity_constants.json` +
      `shared/parity_constants.py` (Python loader) + `src/lib/paper/parityConstants.ts`
      (TS loader). Refactored TS `constants.ts`, `signal.ts`, `hunter.ts`,
      `sniper.ts`, `eligibility.ts`, `ladder.ts`, `ladder-policy.ts` and
      Python `accumulator_signal.py`, `hunter_signal.py`, `sniper_signal.py`,
      `scout_guardian.py` to load their thresholds from the JSON. No
      numeric literals remain on either side for the fields listed in §2.
      Value discrepancies encountered are recorded in §7.
- [ ] **DEBT-02** — Port `shouldTriggerMaxLoss` to Python and wire it
      into `bot_worker.py` position-review loop.
- [ ] **DEBT-03** — Emit `regime` + `leg` as an authoritative decision
      row (already partially in `onyx_decisions`); make the live worker
      gate entries on it (currently ignores regime).
- [ ] **DEBT-04** — Add Python `entry_guard` that mirrors
      `evaluateEntryAuthorization` and blocks on `wait_regime`.
- [x] **DEBT-05** — Fixture-driven parity tests landed in
      `tests/fixtures/parity/*.json` (8 fixtures) with mirrored TS suite
      at `src/lib/paper/__tests__/parity/parity.test.ts` (8 active) and
      Python suite at `tests/parity/test_parity.py`. Python suite runs
      4 active assertions (bos_5m_bearish detection, ladder shared-constant
      derivation, directive-type enum contract, strategy-constant loader
      contract) and 6 documented skips tied to DEBT-02/03/04/06 for the
      🔴 rows in §1. Both suites green.
- [ ] **DEBT-06** — Phase 3 HTF promotion contract: define the
      directive type + payload the live broker will consume. Land
      alongside the paper-side promotion logic, not after.
      **Addendum (owner ruling):** `htf_promotion.bank_fraction = 0` —
      NO banking on promotion. Promotion atomic actions are (1) hard
      stop to breakeven+fees on FULL size, (2) cancel fixed TP, (3)
      cancel unfilled rungs. Post-promotion the 5m adverse-BOS
      guardian does NOT cut the position; runner exits only via
      adverse 1h BOS (`htf_bos_exit`) or breakeven stop
      (`runner_breakeven_stop`). TS paper engine wiring landed in
      `src/lib/paper/engine.ts` (promotion trigger, runner exits, 5m
      BOS guard, telemetry events `HTF_PROMOTION` + `htf_runner_state`).
      Python `bot_worker.py` position-management loop MUST mirror this
      path before live.
- [ ] **DEBT-07** — If/when `ONYX_AI_ENABLED` is flipped on: pin
      `ONYX_BANK_PROFIT_MARGIN_ROI_PCT` in shared JSON and mirror the
      close-authority path in Python.
- [ ] **DEBT-08** — Confirm `exchange_leverage_caps` reads on both
      sides return identical caps (parity test on a fixture set of 10
      symbols).
- [ ] **DEBT-09** — Arbiter v2 engine wiring on TS side + Python
      mirror. Modules built and unit-tested this pass:
      `src/lib/paper/venues/*` (VenueAdapter interface, ApexPerpVenue,
      KrakenSpotVenue, SyntheticSpotVenue, registry with
      `spreadArbEligible`), `src/lib/paper/arbiter/*` (harvester,
      rotator, compounding, volFilter, spreadArb, guardianPair, pair
      types). Follow-up: engine-side per-tick wiring — funding-timestamp
      accrual on open pairs, `pair_id` position grouping in the paper
      repository, guardian routing that filters directional 5m BOS for
      paired positions, and rotation execution against live wallets.
      Python live-side mirror consumes the same
      `arbiter.*` + `spread_arb.*` + `venues.*` blocks in
      `shared/mainnet_parity_constants.json`. Ships behind
      `arbiter.enabled = false` and `spread_arb.enabled = false` — the
      pure math + adapters are proven, but no live behavior changes
      until the wiring closes this debt. Kraken feed verified reachable
      from the runtime (XBTUSDT public ticker returned live bid/ask/last),
      so `KrakenSpotVenue` is the real adapter; `SyntheticSpotVenue` is
      the offline fallback if a hosted region blocks Kraken later.
- [ ] **DEBT-10** — BOS SIGNIFICANCE FILTER (owner-directed after live
      LTC-SHORT / SOL-SHORT sub-threshold cuts). TS side shipped: shared
      constant `bos_significance.{atr_period, min_displacement_atr}` in
      `shared/mainnet_parity_constants.json`, shared primitive
      `src/lib/paper/bosSignificance.ts` consumed by BOTH
      `signal.ts::detectBreak` (5m entry + 1h HTF via `htfBos.ts`) and
      `pricing.ts::isAdverseBos` (5m guardian adverse-BOS). A break of
      structure is CONFIRMED only when the candle CLOSE exceeds the
      broken swing level by at least `min_displacement_atr × ATR(period)`
      on that timeframe; sub-threshold pokes are logged as
      `SCOUT_BOS_REJECTED { reason: "bos_below_significance" }` for
      threshold tuning. Python live-side mirror still pending: apply the
      same floor inside `accumulator_signal.py` break check and
      `scout_guardian.py` adverse-BOS check by loading
      `parity_constants.group("bos_significance")`. Close by porting +
      adding a shared fixture where a sub-threshold break must NOT
      confirm on either side.
- [x] **DEBT-11** — GUARDIAN v2 (owner-ratified clean rewrite; supersedes
      patch fixes). `scout_guardian.py` rewritten as a position-aware gate
      pipeline: FRESH (break_ts > opened_at) + SIGNIFICANT (consumes the
      DEBT-10 primitive via `detect_break`) + SETTLED (`grace_candles`,
      default 2) gates run before any close directive; strategy rule
      table (accumulator/vanguard trend legs → adverse-BOS close; SNIPER
      exempt from adverse-BOS, closes on entry-swing breach or vol-scaled
      `sniper_max_adverse_pct` fallback; PROMOTED runners bypass 5m rules
      entirely; ARBITER `pair_id` positions emit HOLD delegated to pair
      guardian); vol-scaled thresholds under `guardian_v2.*`
      (`rung_cancel_atr_mult`, `rung_cancel_floor_pct`,
      `cluster_drawdown_atr_mult`, `cluster_floor_pct`) with flat floors
      as minimums; `data_stale` alarm after `stale_data_cycles` (default
      3) consecutive `no_market_data` cycles per symbol; every verdict
      carries a full `gates` dict for auditability. Directive/DB contract
      unchanged. TS engine side demoted to telemetry only — internal
      `scout_bos` force-close in `src/lib/onyx/decide.ts` removed; the
      `structure_broken` stamp + `SCOUT_BOS` / `SCOUT_BOS_REJECTED`
      events remain purely for observability. Worker (`bot_worker.py`)
      is now the SOLE BOS-close authority; it passes `now_ms`, tracks
      per-symbol stale counters, and reads `promoted` /
      `runner_breakeven_stop` / `structure_broken_ts_ms` from
      `worker-ingest`. `guardian.rules_version` bumped `1 → 2`.



Each debt is closed by: (a) code change on both sides, (b) update to
§1 status column, (c) new row in §5 if schema changed, (d) parity
tests added per §3.

---

## 7. Value Discrepancies Found During DEBT-01

Recorded per the mandate: when TS and Python disagreed on what should be
the same value, the value from the designated §2 source-of-truth side was
adopted and the other side is tracked here for follow-up.

| Field | TS (paper) value | Python (live) value | Resolution in shared JSON | Follow-up |
|-------|------------------|---------------------|---------------------------|-----------|
| **Entry freshness window** | `ENTRY_FRESHNESS_CANDLES = 3` (retest can fire within 3 completed candles of the confirmed break) | Effectively `1` — `entry_eligibility.py` requires `retest_index == len(candles) - 1` (strict newest-candle identity) | Both values published under distinct keys: `eligibility.entry_freshness_candles_ts_paper = 3`, `eligibility.entry_freshness_candles_py_live = 1`. Neither side changes behavior in this pass. | New debt: reconcile to a single window in a subsequent pass. Recommendation is 3, matching paper-authoritative side per §2, but decision is owner-gated because it materially widens live-side entry acceptance. |
| **Accumulator per-rung TP semantics** | Per-rung TP = fill × (1 ± `DCA_RUNG_TP_PCT` = 0.01) — pure price move | `accumulator_exit.py` uses margin-ROI ladder: TP1=+200 %, TP2=+300 %, ORIG=+400 % margin ROI on the first-entry lot; at 100× this equals ≈+2 %, +3 %, +4 % price moves on that lot | JSON pins the paper-side `dca_rung_tp_pct = 0.01` under `ladder.*`. The live-side margin-ROI ladder is intentionally NOT hoisted into the shared JSON in this pass because the two TP models are structurally different (per-rung geometric vs. first-entry margin-ROI). | New debt: pick one accumulator TP model as source of truth and delete the other. Tracked as an extension of DEBT-06 (accumulator exit contract). |

Both discrepancies are documented, not silently resolved: the parity
JSON now exposes each side's actual value under an explicit key so
that neither side drifts further, and the reconciliation is a
future owner-gated decision.


---

## 8. Test Hygiene Pass — Disposition Log

Standing rule: zero suite failures. "Pre-existing" is not accepted. This
section records the disposition of each failing test that was resolved in
the Test Hygiene Pass so future contributors can see WHY the test was
edited (and confirm it wasn't weakened).

### 8.1 `src/lib/universe/__tests__/flag.test.ts` — "activates only for paper mode with env set"

- **What broke it:** the owner-ratified rollback of the dynamic-universe
  pipeline hard-wired `isDynamicUniverseEnabled` in
  `src/lib/universe/flag.ts` to return `false` regardless of env or mode.
  The test still asserted the pre-rollback behavior (paper + env=1 ⇒ true).
- **Disposition:** TEST WAS STALE. Rewritten as a **rollback guard**: with
  env=1 in paper mode, the flag MUST stay OFF. `dynamicUniverseEnvSet()`
  still returns `true` (raw env observable for diagnostics), and
  `isDynamicUniverseEnabled(...)` returns `false`. If a future commit
  re-enables the pipeline in `flag.ts`, this test fires — the guard is
  real, not tautological.

### 8.2 `src/lib/universe/__tests__/engineGate.test.ts` — three failing cases

- **What broke it:** same rollback. `computeUniverseGate` consults
  `isDynamicUniverseEnabled(...)` which is now always `false`, so `active`
  is always `false` and no filtering occurs. Tests asserted `active=true`
  under flag-on scenarios.
- **Disposition:** TESTS WERE STALE. Rewritten to assert **passthrough
  under rollback** across the same three input shapes (missing snapshot;
  fresh snapshot + slots; zero slots). Each case still verifies the
  retention invariant (open positions never filtered) and that
  `allowedNewEntries` is empty — so the tests still guard the "no silent
  execution" contract. If the flag is deliberately re-enabled, these
  assertions must be updated in the same commit that flips it.

### 8.3 `src/lib/scout/__tests__/scout-no-execution-imports.test.ts` — `client.server` in `scan.functions.ts`

- **What broke it:** Scout Stage 2 evidence persistence
  (`scoutStage2PersistEnabled`) dynamically imports
  `@/integrations/supabase/client.server` inside the handler to invoke
  the SECURITY DEFINER `scout_persist_scan` RPC. `governance.functions.ts`
  already does the same to check `has_role`. The banned-substring list
  included `client.server` outright.
- **Disposition:** TEST WAS OVER-BROAD. The governance rule is that Scout
  must not reach **execution / order / wallet-mutation** surfaces — the
  admin Supabase client itself is not one of those. The paper engine,
  operations, repository, ladder, onyx decide, execution-broker, apex-*
  edge functions, worker-ingest, and the signer/ tree remain fully
  banned (those are the actual mutation surfaces). Removing
  `client.server` from the list keeps the intent intact without weakening
  it. A comment header on the test now explains this scope.

**Not a code invariant violation** in any of the three cases — the
underlying code changes (rollback, Stage 2 persistence) were owner-ratified
prior to this pass. No engine/worker/guardian/strategy behavior was
touched. `is_live` remains `false`; `SIGN_ORDER` remains disabled.

---

## Addendum — Re-entry Lockout (post-guardian-BOS)

**Constant:** `entry_lockout.reentry_lockout_candles = 12`
(shared/mainnet_parity_constants.json)

**Rule:** After any Guardian-driven close on `(symbol, direction)` —
`scout_bos`, `scout_guardian_bos`, or `scout_guardian_cluster` — block
NEW entries on that same `(symbol, direction)` for 12 five-minute candles
(1 hour). Opposite direction is NEVER blocked. Unrelated symbols are
unaffected.

**Paper (TS):** enforced — `src/lib/paper/reentryLockout.ts` + entry gate
in `src/lib/paper/engine.ts` (Phase C, before allocator). Blocked entries
emit `EvalReason = "reentry_lockout"` for telemetry.

**Live (Python worker):** 🔴 **PARITY ITEM — not yet consumed.**
`bot_worker.py` entry gate must load `REENTRY_LOCKOUT_CANDLES` from
`shared/parity_constants.py` (`group("entry_lockout")["reentry_lockout_candles"]`)
and apply the same rule against recent live fills / closes. Tracked as
DEBT-06 for a follow-up worker pass. `is_live` remains `false` until this
parity is closed.

## Addendum — LIVE-READINESS PASS (2026-07-25)

Landed in this pass:

- [x] **DEBT-02 CLOSED** — `max_loss.py::should_trigger_max_loss` mirrors
  `src/lib/paper/constants.ts::shouldTriggerMaxLoss` and loads
  `risk.max_loss_margin_frac` from the shared JSON. Pure predicate; the
  live worker is expected to call it inside its position-review loop
  with `(margin, unrealized_worst)` derived from the newest candle
  low/high per side. Tests in `tests/test_live_readiness_modules.py`.

- [x] **DEBT-03 CLOSED** — `regime.py::classify_regime` +
  `routing.py::leg_for_regime` mirror the TS regime/routing pair;
  thresholds live under `regime_classifier.*` and `regime_routing.*` in
  the shared JSON so no numeric literal is duplicated.

- [x] **DEBT-04 CLOSED** — `entry_guard.py::evaluate_entry_authorization`
  mirrors `evaluateEntryAuthorization`. Fail-closed on `wait_regime` /
  `no_regime` / `no_leg`.

- [x] **DEBT (re-entry lockout) CLOSED (Python module + wiring)** —
  `reentry_lockout.py::build_lockout_set` + `is_locked_out` load
  `entry_lockout.reentry_lockout_candles` from shared JSON. The live
  worker now fetches recent guardian-class closes via the signed
  `worker-ingest::GUARDIAN_RECENT_CLOSES_READ` op and builds the per-cycle
  lockout set in `bot_worker.guardian_pass`. Locked-out (symbol, direction)
  pairs are refused at the entry gate; opposite direction is never
  blocked. Read failure fails safe (empty set — no legitimate entry
  blocked, guardian pass never aborts).

- [x] **DEBT-06 CLOSED (Python detector)** — `htf_bos.py::detect_htf_bos`
  + `aggregate_1h`. Reuses `accumulator_signal.evaluate` so the
  BOS-significance filter carries through unchanged. Promotion policy
  (bank_fraction=0, breakeven stop, cancel fixed TP, cancel unfilled
  rungs) still needs to be wired at the worker level; DEBT-06 tracker
  now scopes only that wiring.

- **NEW: Exchange-side stop verification** —
  `stop_verification.py::verify_position_stops`. Every worker cycle, for
  every open live position, a resting reduce-only stop order must exist
  at ApeX at or tighter than the intended stop; drift/absence emits a
  `RepairDirective`. Shared JSON: `stop_verification.tolerance_pct`,
  `min_check_interval_sec`, `paper_simulate`. Paper-simulate mode is on
  by default so the code path is exercised before live activation.

- **NEW: Broker dry-run translator** —
  `broker/src/translator.ts::translateDirective`. Pure, tested (9 cases).
  Given a directive + equity + requested leverage, returns the
  exchange-shaped intent the broker WOULD submit, with pilot sizing
  applied. Never signs, never calls the venue. Directive-type enum
  extended in shared JSON `enums.directive_types` to include
  `promote_runner`, `cancel_fixed_tp`, `set_breakeven_stop`,
  `repair_stop`.

- **NEW: Pilot funding envelope** —
  `pilot_sizing.py` (Python) + `src/lib/paper/pilotSizing.ts` (TS) both
  load from `pilot.{allocation_reserve_floor_usd, allocation_ceiling_usd,
  max_leverage}` in the shared JSON. `pilot_allocation(equity)` clamps
  the working allocation; `pilot_leverage(req)` clamps effective
  leverage. The broker translator enforces both.

- **NEW: Live/Paper shadow-mode surface — wired-and-served** — new table
  `paper_live_shadow_ledger` (RLS: owners see their own rows, admins see
  all, service_role writes). The worker's `_emit_shadow_ledger` batches
  every Guardian decision into `worker-ingest::SHADOW_LEDGER_INSERT`
  (validated shape, batch insert, flat rows dropped client- and
  server-side). Frontend route `/shadow` renders side-by-side paper vs
  live decisions with `in_line`/`divergent` badges. Comparison tolerance:
  `shadow_mode.compare_price_tolerance_bps`.

- **NEW:** `docs/LIVE_ACTIVATION.md` — one-page owner ceremony checklist
  covering preconditions, pilot envelope, dry-wire, stop-verification
  bake, shadow-mode bake, ordered flag flips, kill-switch drill, and
  post-activation guardrails. **All activation flags remain `false`;
  `is_live=false`; `SIGN_ORDER` disabled.** This document does not flip
  anything — it only makes the ceremony reproducible.

Wiring seam: the pure Python modules above are import-ready. Integrating
them into `bot_worker.py`'s cycle loop (call sites for max_loss check,
entry_guard, reentry_lockout gate, HTF promotion) is the final wiring
step and is intentionally kept as a separate small edit so the diff is
reviewable line-by-line before live.

## Sweep leg — H2 mid-weighted pyramid DCA (owner-ratified 2026-07-27)

Supersedes the 2026-07-26 momentum-hold redesign. Chosen from the 30-day
head-to-head backtest for its drawdown profile (per-symbol maxDD −70.76,
portfolio equity DD −119.33). Detection is unchanged; only sizing/exit
changed. All numeric parameters live in `shared/mainnet_parity_constants.json`
→ `sweep` block; the transitional single-entry fields are marked
`$transitional_legacy_fields` and are removed once engine wiring is complete.

**Geometry (bit-identical both sides)**
- **Detection:** 1h sweep detection (retest or rejection) with 4h HTF alignment
  as a hard entry gate — unchanged from the previous sweep spec.
- **Flush zone:** extends `flush_zone_atr` × ATR(1h) beyond the swept level
  (below for longs, above for shorts).
- **Ladder:** 3 limit rungs at `fill_depth_fracs = [0.0, 0.5, 1.0]` of the
  zone with `fill_weights = [1, 3, 2]` sixths of total leg margin.
- **Hard stop:** at zone edge + `stop_beyond_edge_atr` × ATR(1h). All filled
  units exit together on stop.
- **Exits:** scaled TP tiers off avg entry (recomputed on each fill):
  50% at 1.75R, 30% at 2.0R, 20% at 2.5R, labeled `SWEEP TP1/TP2/TP3`.
  Remainder at hard stop (`SWEEP · STOP`) or `timeout_bars_1h = 48`
  (`SWEEP · TIMEOUT`).
- **Concurrency cap:** `max_concurrent_ladders = 2` across the whole
  portfolio; pending + open both count. Excess sweep signals are skipped
  and logged `sweep_concurrency_cap`.
- **Guardian:** v2 catastrophic-only. Re-entry lockout applies on stop-out.
  Life Map allocates realized P&L on every partial close.

**Shared math modules (source of truth)**
| Concern | TypeScript | Python |
| --- | --- | --- |
| Ladder + tier + fill math | `src/lib/paper/sweepH2.ts` | `sweep_h2.py` |
| Concurrency cap | `src/lib/paper/sweepConcurrency.ts` | (mirror pending worker wiring) |
| Detection (unchanged) | `src/lib/paper/sweep.ts` | `sweep_signal.py` |

**Parity fixtures & tests**
- Fixtures: `tests/fixtures/parity/sweep_h2_ladder_long.json`,
  `sweep_h2_ladder_short.json` — canonical `(level, atr, margin, leverage)`
  inputs with expected rung/qty/stop/tier values.
- TS asserts: `src/lib/paper/__tests__/sweepH2.test.ts` (19 tests) +
  `sweepConcurrency.test.ts` (4 tests).
- Python asserts: `tests/test_sweep_h2_parity.py` (6 tests).
- Both languages produce bit-identical doubles on the shared fixtures
  (tolerance 1e-12).

**Routing**
- `legForRegime("neutral")` → `"sweep"` in both languages. Engine's
  `armedLeg === "sniper" || armedLeg === "sweep"` block still covers it.
- DB `strategy` label: still `"sniper"` (`dbStrategyLabel(leg)`) so historical
  dashboards keep working.

**Orchestration wiring — staged rollout**

- **PR 2a (this PR — shipped)**: mechanical cleanup + storage groundwork.
  - Migration: added nullable `strategy_metadata jsonb` + `tp_tiers jsonb` to
    `public.paper_positions` AND `public.positions` (parity — Live == Paper).
    No backfill; existing rows unaffected.
  - Deleted `src/lib/paper/sweepMomentum.ts` (1h EMA/two-swing momentum
    evaluator) and the two momentum parity fixtures
    (`sweep_1h_momentum_{hold,flip}.json`). The parity test suite no longer
    references either.
  - `routing.test.ts` updated: neutral → `sweep` (was legacy `sniper`
    expectation) and added `dbStrategyLabel` continuity assertions.
  - `paper-tick` auth test — the intermittent 5s timeout on the first
    `loadRoute()` call was module-import latency (engine.ts pulls a large
    graph). Bumped that first-test timeout to 30s; suite runs green.
  - Life Map audit — see finding below.
- **PR 2b (next — engine H2 state machine)**: replace `engine.ts` sweep
  branch (`SWEEP_MAX_RUNGS=1` path, L1606-1680) with the pending-ladder
  lifecycle: `sweepConcurrency.canDeployLadder` gate → `computeH2Ladder` →
  persist rungs in `strategy_metadata` → fill loop recomputes avg + rewrites
  `tp_tiers` via `computeH2Tiers` → tier hits call
  `paper_partial_close_position` with `SWEEP TP1|TP2|TP3` labels → remainder
  exits at hard stop (`SWEEP · STOP`) or 48×1h timeout (`SWEEP · TIMEOUT`)
  → `reentryLockout` armed on stop. Then delete `SWEEP_MAX_RUNGS`,
  `sweepTpPrice` from `sweep.ts`, and remove `$transitional_legacy_fields`
  from the shared JSON.
- **PR 2c (next — worker mirror)**: `bot_worker.py` emits 3 correlated
  LIMIT rung intents from `sweep_h2.compute_h2_ladder(...)` (shared
  `ladder_id` in metadata), mirrors partial-close directives on tier hits,
  concurrency counted from
  `paper_positions WHERE strategy='sniper' AND strategy_metadata->>'h2'='true' AND status IN ('pending','open')`
  (documented source of truth — same store the paper engine counts from),
  `reentry_lockout` respected. `SIGNAL_EVALUATION` telemetry:
  `leg='sweep'`, `entry_gate.ladder_state ∈ {pending, deploying, filled_partial, filled_full, closed}`.

**Life Map partial-close audit finding (PR 2a — spec item 9)**

`src/lib/bills/allocate.ts` exports a pure `allocate(input)` function that
distributes a positive `delta_usd` across bills in priority order. It is
imported ONLY by `src/lib/bills/sync-planner.ts` and its own test file.

**Trade close paths do NOT call it.** Neither `paper_partial_close_position`
(the RPC that closes a fraction of a position), nor the engine's
full-close path, nor any code under `src/lib/paper/` invokes `allocate`.
There is no `allocateEarnings(pnl_net)` symbol in the codebase and there is
no wiring at all between realized P&L and bill allocations.

Consequence for H2: even after PR 2b/2c ship, `SWEEP TP1/2/3` partial closes
will realize P&L but NOT allocate that P&L to bills. The H2 spec item 9
("each partial close allocates realized P&L to bills as normal") describes
behavior that has never been true for any leg — this is a broader Life Map
gap, not an H2 regression.

**Owner ratified (2026-07-28): audit-and-report only in this PR.** Wiring
`allocate` into every leg's close path (paper + live) is deferred to a
dedicated follow-up PR so the trade-close → bill-allocation contract can be
designed, migrated (the ledger event needs a shape), tested, and shipped as
a single reviewable diff spanning ALL legs, not smuggled in through H2.


