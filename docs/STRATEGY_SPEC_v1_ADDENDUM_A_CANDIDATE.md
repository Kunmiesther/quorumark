# Strategy Spec v1 — Addendum A (CANDIDATE)
## Reversal Exit, Trend Veto & Reversal-Deployed Hedge

> **STATUS: CANDIDATE — NOT RATIFIED. NOT IN EFFECT.**
>
> This document does **not** amend `docs/STRATEGY_SPEC_v1.md`. It does not alter
> `user_strategy.params`. It confers no behaviour on any engine.
>
> Every rule below is traced to the owner statement that produced it. Every gap is
> marked `OWNER RULE NOT FOUND` and left empty. **Nothing was inferred, completed,
> harmonised, or imported from general DCA practice.** Where the owner did not
> speak, the page is blank by design.

- **Document ID:** STRATEGY-SPEC-v1-ADDENDUM-A
- **Revision:** 0.17.1 (candidate) — CRITICAL SIZING CORRECTION — supersedes 0.17
- **Parent:** `docs/STRATEGY_SPEC_v1.md` (spec_version `v1`, slug `dca`)
- **Session date:** 2026-07-15
- **Owner:** Omar Harris
- **Ratified:** NO

### Changes in 0.17.1 — CRITICAL SIZING CORRECTION

> **K WAS WRONG. `inverse_leverage_margin_numerator` = 10, NOT 20.**
> Owner-confirmed **P1** on 2026-07-16 by direct statement of the margin schedule
> (`50x -> 20%`, `100x -> 10%`) and a worked leverage/margin table
> (`1000x -> 1%`, `500x -> 2%`, `100x -> 10%`; margin% x leverage = **10** on every row).
>
> **The K=20 value was NOT the owner's intended Accumulator sizing rule. It must not be used
> for implementation, migration, paper testing, testnet, or live execution.**
>
> - Previous candidate value: **20**
> - Correct owner-confirmed value: **10**
> - Previous value's status: **incorrect reconstruction/interpretation**
> - Effect: **doubled every intended position notional** and produced **false
>   liquidation/floor collisions** (the "alt window 0.04%" finding was an artifact and never existed)
> - Correction date: **2026-07-16**
> - Provenance: **owner-confirmed P1**
> - `capital.max_usd` **remains $500** — unchanged
> - The **20% equity floor is unrelated and unchanged**
>
> **How it hid:** `$1,000 x 10 = $10,000` and `$500 x 20 = $10,000` produce the SAME notional.
> The wrong constant paired with the wrong capital gave the right answer, so it survived four
> revisions, the P2 grade, the audit trail, and the full gap sweep. It only broke when the owner
> stated the margin percentage directly. **No amount of re-reading the specification would have
> caught it.**
>
> Every dependent calculation below has been recomputed.

### Changes in 0.17
- **B-1 … B-8 CLOSED at specification level** *(S39–S46, all P1)*. §16.
- **§16 added** — original first-entry target · volatility floor · cycle leverage · resize
  tranche model · `a_trailing` · staleness thresholds · cross-margin remediation · symbol contract.
- **`sell_second_tranche_at_break_even` SUPERSEDED** in v1.1 by
  `close_active_resize_tranche_at_individual_all_in_break_even`.
- **§17 added — post-ruling consistency audit.** 16 cross-checks run. **14 pass. 2 fail.**
- **B-9 … B-12 opened** — four items surfaced *by the cross-check itself*, not present before.
- **B-9 is the material one:** B-4 + B-5 + v1's resize gate together create a path in which the
  structural stop **can never arm**.

### Changes in 0.16
- **G31 CLOSED** *(S34)* — five-component sufficiency. Reserve 10%. Slippage 25 bps/side.
  Fee ceiling 0.10%/side. §13.
- **`notional_constant` RESOLVED** — a **dimensionless numerator**, not a dollar amount, not
  contracts. Open since the 2026-07-15 audit. Rename to `inverse_leverage_margin_numerator`.
  **VALUE CORRECTED IN 0.17.1 FROM 20 TO 10.** Position notional is constant at
  `capital_baseline × 10` = **$5,000** for a $500 baseline / **$3,000** for $300, at every leverage.
- **G32 CLOSED at specification level** *(S35)* — `accumulator_cycles` +
  `accumulator_cycle_events`. `strategy_state` explicitly rejected as the cycle ledger.
  Physical implementation **pending**. §14.
- **§9.6 RESTORED AND RESOLVED** *(S36)* — v1.1 scope: 11 in, 13 out.
- **C1 RESOLVED by exclusion** *(S37)* — not by changing G30.
- **C2 RESOLVED by exclusion** *(S38)* — signal may advance an armed cycle, never activate one.
- **Addendum A formally excluded from v1.1** — candidate, unratified, no operational authority.
- **§15 added — complete gap sweep.** Drip-feed ended. **Eight v1.1 ratification blockers
  identified, including three not previously surfaced.**

### Changes in 0.15
- **G30 CLOSED** *(S33)* — canonical cycle definition. **One cycle = one owner-authorised
  position campaign.** Full ruling at §12.
- **§12 added** — cycle lifecycle: activation, 24 activation requirements, 18 frozen values,
  baseline lifetime, pre-entry lifecycle, position campaign, terminal / non-terminal
  conditions, floor effect, kill-switch effect, no-sequential-positions, post-cycle state.
- **§11.4(b) RESOLVED** — the capital baseline is a **new per-cycle owner-selected field**
  bounded by `capital.max_usd`; v1's `variable: true` reads as variable **between** cycles.
- **§11.4(a) SUPERSEDED** — the June "cycle" terminology is now formally **non-authoritative**.
- **C1, C2 recorded (§12.10)** — **G30 contradicts Addendum A's M4A and M4B.** Both are
  recorded, neither resolved.
- **G32 opened** — cycle persistence has no schema.
- **G31 escalated to CRITICAL** — G30 activation requirement 21 now depends on it.
- **Effective resize depth noted** — the equity floor bounds `depth_ceiling: null` in practice.

### Changes in 0.14
- **G29 CLOSED** *(S32)* — `equity_floor_pct: 20`. Full ruling at §11. v1's oldest
  unanswered `OWNER RULE NOT FOUND`, open since the 2026-07-15 audit.
- **§11 added** — equity floor. Recorded as **v1 safeguards completion**, deliberately
  separate from Addendum A's unratified hedge model.
- **G30 opened and promoted to CRITICAL** — S32 makes the **cycle** load-bearing (baseline,
  floor, halt latch) but its **boundaries are undefined**.
- **G31 opened** — the pre-activation sufficiency check contains three undefined terms.
- **§11.4 — terminology collision recorded.** "Cycle" already exists in the June 2026
  scaffolding meaning something different.
- **§9.6 scope reading invalidated** — G29 expands v1.1 beyond the entry path.

### Changes in 0.13
- **G26 CLOSED** *(S26)* — the retest zone is **frozen at the close of the completed
  breaking candle**. Persistence field list at §3.6.1. Later ATR movement can do nothing.
- **G27 CLOSED** *(S27)* — **RFC 8785 (JCS) + SHA-256**, lowercase hex. Checksum target is
  the **canonical JSON artifact**, not the prose Markdown. Activation blockers at §9.2.
- **G28 CLOSED** *(S28)* — **v1 is not amended or replaced.** Three artifacts stand side by
  side. Historical-status notice only; substantive v1 rules untouched. §9.3.
- **Empty-row preservation RESOLVED** *(S29)* — **both** row continuity **and** before-state
  history. `strategy_spec_history` planned. `previous_params = {}` preserved literally. §10.
- **Atomic migration procedure recorded** *(S30)* — 23 steps, §9.4. **Not executed.**
- **Authority rule recorded verbatim** *(S31)* — §9.5.
- **G29 opened and promoted to CRITICAL** — `equity_floor_pct` is `null` while
  `equity_floor_required_before_live` is `true`. **§4.1 is no longer empty.**
- **v1.1 scope observation** recorded at §9.6.

### Changes in 0.12
- **G23 DISSOLVED** *(S24)* — confirmed by owner. Behaviour is mechanical; the label
  cannot change execution. Four-way trigger table recorded at §3.5.1.
- **G25 CLOSED** *(S25)* — the retest leg is fully specified. §3.6.
- **§9 A1 procedure specified** *(S23)* — bump and `params` population must occur together
  in one controlled migration. **No doc-only v1.1.**
- **GOVERNANCE RULING (S23)** — until that migration succeeds, **the document is the
  specification of record and the empty row is a known data defect — not an authoritative
  empty strategy.** This resolves the precedence paradox carried since the 2026-07-15 audit.
- **G26, G27, G28 opened** — zone-tolerance freezing; checksum canonicalisation; v1 doc
  disposition (owner gave an OR, not a choice).
- **§4.1 CRITICAL remains empty.**

### Changes in 0.11
- **G22 CLOSED** *(S20)*. Subject, direction, lookback, and setup-persistence all stated.
  **The last critical conceptual gap in the model is closed.**
- **G24 CLOSED** *(S21)* — structure is what breaks; EMA(15) is the confirmation filter.
  Owner directs this be recorded as a **clarifying amendment to v1, explicitly versioned**,
  so the formerly ambiguous v1 wording is not silently reinterpreted. See §9.
- **S19 AMENDED** *(S22)* — liquidity-zone tolerance revised from one tick to
  `max(1 tick, 0.05 × ATR₁₄ 5m)`.
- **G23 provisionally dissolved** — pending owner confirm. See §4.2.
- **G25 opened** — the *retest* leg of `break_and_retest` is still unspecified.
- **§9 added** — v1 amendment register. `docs/STRATEGY_SPEC_v1.md` remains **untouched**;
  the amendment is recorded here and awaits explicit authorisation to edit v1.

### Changes in 0.10
- **S19 recorded (P1)** — swing-point definition: confirmed five-candle pivot. Full rule
  in the ledger and §3.4. Volunteered complete and unprompted; no options were offered.
- **G22 PARTIALLY CLOSED — 2 of 3 parts.** Swing-point definition ✅. Break condition ✅
  (close required; a wick through the level alone is not a break). **Remaining: which
  swing must break, and over what lookback.** G22 stays CRITICAL until that lands.
- **§3.4 added** — swing-point rule, stated in full.
- **G24 opened** — S19 states the break-and-retest logic measures against the confirmed
  wick level. v1's `entry.break_and_retest` never named *what* is broken. This may be a
  clarification of v1 rather than an addition to it. Owner-only; not assumed.
- **Convergence noted (not imported)** — S19's close-not-wick condition independently
  matches v1's `wick_tags_allowed: false`. Arrived at by the owner, not carried over by
  the assistant. Recorded as **P1**, not inference. See §3.4.

### Changes in 0.9
- **B5 partially resolved** — `strategies.markets` corrected `'spot'` → `'futures'` for
  slug `dca` by owner-authorised migration `20260716062240_b34f9039`. Verified post-apply.
- **§8 corrected** — this addendum is no longer migration-free. The one migration run is
  recorded there. The prior blanket claim was false once the migration applied.
- **§4.3 / §4.4 reordered** — closed items now precede the structural observation.
- **Document committed to the repository** at `docs/` as a candidate. Still NOT RATIFIED.

### Changes in 0.8
- **S16 RE-AFFIRMED** after the §4.4 disclosure. *(S18)* The owner was shown that the
  condition under which EMA was chosen had changed, and elected to keep EMA.
- **§4.4 observation CLOSED** — reviewed by owner, no change.
- S16 origin grade remains **P3** (grade records *origin*, which does not change).
  **Standing strengthened:** challenged twice, held twice. See §2.1.

### Changes in 0.7
- **G1 CLOSED (method class)** — the 5m reversal/pullback signal is **break of structure**.
  Grade **P1** — volunteered with no candidates offered. *(S17)*
- **G22 opened (CRITICAL)** — operational definition of BOS.
- **G23 opened** — BOS vs CHoCH semantics. A reversal signal and a continuation signal
  are different events; "break of structure" is the standard name for the latter.
- **§4.4 added — Structural observation.** The G19 problem has **returned**, relocated.
  Structure is now the reversal determinant. This bears on S16 (P3) and is flagged,
  not acted on.

### Changes in 0.6
- **S15 SUPERSEDED by S16.** 1H trend method is **EMA-based, with candle confirmation** —
  not candlestick structure.
- **G18 re-closed** on the new method class.
- **G19 RETIRED** — moot. Structure is no longer the trend determinant.
- **G20, G21 opened** — EMA period on 1H; what the candle confirms.
- **G10 unblocked (not closed)** — EMA is deterministic, so the 1H check no longer
  requires a human read. Whether S4's daily bias is retained is still open.
- **Provenance grade P3 introduced** — see §2.1. S16 is the first P3 entry.

### Changes in 0.5
- **G18 CLOSED (method class)** — 1H trend is read from **candlestick structure**.
  **Not indicator-based.** Explicitly rules out reuse of v1's EMA(15) / `close_above_ema`
  on the 1H. *(S15)*
- **G19 opened (CRITICAL)** — "bullish structure" has no operational definition.
- **G10 dependency noted** — G19's answer determines whether the bot is autonomous.

### Changes in 0.4
- **G14 CLOSED** — the overall-trend timeframe is **1H**. *(S14)*
- **G18 opened** — 1H names the *timeframe*, not the *method*. How trend is determined
  on the 1H is unstated. Promoted to CRITICAL.
- **G10 tension noted** — 1H is intraday; "bull day" is day-scale. The two may not be
  the same input.
- Criticals: **G1**, **G18**.

### Changes in 0.3
- **G6 CLOSED** — hedge-profile wallets take **discrete confirmed pullback trades**;
  they do **not** inherit unbounded resize. Critical risk retired. *(S13)*
- **M8 added** — hedge-profile resize behaviour.
- **G16 opened** — "not unbounded" ≠ "no resize." Depth behaviour still unstated.
- **G17 opened** — with G6 closed, the hedge profile shares almost nothing with v1's
  Accumulator. Identity question is now live.
- Criticals reduced to **G1** and **G14**.

### Changes in 0.2
- Branch structure confirmed by owner (S12). Reversal is now **conditional**, not absolute.
- **S9 recorded as a third exit path**, separate from the hedge rule — it is not one.
- **G2 CLOSED** — hedge-profile designator is deployment context.
- **G3 CLOSED** — margin basis, derived from owner's worked example and acknowledged.
- **G6 elevated to CRITICAL** — consequence of the confirmed branch structure.
- **G13, G14, G15 opened.**

---

## 1. Why this document exists

`docs/STRATEGY_SPEC_v1.md` describes a **single-account** Accumulator on a **5m
timeframe throughout**. It contains no wallets, no multiple deployments, no hedge,
no reversal entry, no reversal exit, no higher timeframe, and no second stop profile.
The owner introduced all of these in conversation on 2026-07-15.

Prior audit established that the repository's generic three-step / ATR / 50-100-200
Accumulator UI was authored **2026-06-21** — roughly 23 days *before* the earliest
trace of spec v1 (2026-07-14). It was pre-specification scaffolding, never reconciled.
The failure mode was **unrecorded intent**, not overwriting. This document exists to
prevent a recurrence.

---

## 2. Statement ledger

Owner statements in order, with disposition. Superseded statements are retained —
the supersession history is itself the artifact.

| # | Owner statement (as given) | Disposition |
|---|---|---|
| S1 | Up to 6 wallets connected; with 2 wallets the second can operate as a hedge. | **PARTIALLY STANDS** — enforced cap is 6 *connections*. See B1 |
| S2 | Every wallet is max $500. | **STANDS** |
| S3 | Every wallet looks for its own opportunity. | **STANDS, QUALIFIED** — see M3 |
| S4 | "If I believe today is a bull day" — owner's directional read. | **OPEN** — possibly formalised by S9's higher timeframe. See G10 |
| S5 | Hedge wallet also goes to 200%; trailing stop kicks in at 100%. | **STANDS** — subject now defined by M7 |
| S6 | Wallets 2, 4, 6 hedge wallets 1, 3, 5. | **RETRACTED by S8** |
| S7 | "lets make it simple its paired" | **RETRACTED by S8** |
| S8 | On confirmed reversal a new wallet may deploy. Not paired — hedge in practice, not theory. | **STANDS, REFINED by S11** — deploys on the pullback branch only |
| S9 | If an opposite position is confirmed the wallet exits, **unless** same direction still confirms on a higher timeframe. | **STANDS** — recorded as a third exit path, §3.2 |
| S10 | Worked example: enter ETH 1650 long, climbs to 1670, not quite 200% ROI, reversal confirms → exit and trigger short **unless** overall trend still long → second wallet's hedge opportunity; can result in big gains. | **STANDS** — basis of G3 closure |
| S11 | If market conditions are favorable, a reversal does **not** mean exit. Exit only at the top of the market on a real reversal. | **STANDS — CURRENT MODEL** |
| S12 | "ok" — confirming the branch structure as stated back. | **RATIFYING ACKNOWLEDGEMENT** of M4 branch logic, G2, G3 |
| S13 | Clarifying M4B: these are **confirmed pullback trades** — discrete entries, each with its own confirmation; not an unbounded resize campaign. Owner selected this reading explicitly when offered against a competing terminology reading. | **STANDS** — closes G6; see M8 |
| S14 | "1hr" — the overall-trend timeframe. | **STANDS** — closes G14 (timeframe only; method unstated, see G18) |
| S15 | The 1H trend is long when **candlestick structure is bullish**. | **SUPERSEDED by S16** |
| S16 | Base the 1H trend on **EMA**, with the **candle used for confirmation**. | **STANDS — CURRENT** — closes G18 (method class). Provenance **P3**, see §2.1 |
| S17 | The 5m reversal/pullback signal is a **break of structure**. | **STANDS** — closes G1 (method class). Grade **P1** — volunteered; no candidates were offered by the assistant. Operational rule open, see G22/G23 |
| S18 | "lets keep ema" — issued after the §4.4 disclosure that structure-definition work is now unavoidable via G22, and that S16's original basis had therefore weakened. | **RE-AFFIRMS S16.** Closes the §4.4 observation. Second challenge, second confirmation |
| S39 | **B-1 — original first-entry target.** `original_first_entry_target_margin_return_pct = 400`, frozen from the **actual first filled entry's VWAP**, **not** the re-anchored average. Long: `vwap × (1 + 4/leverage)`; short: `vwap × (1 − 4/leverage)`. Frozen at the initial entry's completed-fill state. Gross target before fees/funding/slippage; those still count in net P&L and safeguards. Nine persisted fields. TP order: TP1 200% (current avg) → sell half; TP2 300% (current avg) → sell half of remainder; TP3 frozen original target → full close. **TP3 cannot execute before TP1 and TP2 reach terminal filled states.** Invalid/unrepresentable/wrong-side/out-of-bounds target → **fail closed**. | **STANDS.** P1. **Closes B-1.** Open since 2026-07-15 |
| S40 | **B-2 — volatility floor.** `metric = atr_14_5m_ratio`; `threshold = 0.0008`. `atr_ratio = ATR(14, completed 5m) / latest completed 5m close`; pass only when `atr_ratio >= 0.0008` (≥0.08% of price). Wilder ATR(14), completed candles only, never the forming candle, reject missing/duplicate/stale/out-of-order, **never substitute zero**, decimal-safe, persist ATR/close/ratio/threshold/candle-close time/data fingerprint. **The threshold is now an owner-ratified rule, no longer a code fallback.** No activation or entry when the calculation is unavailable. | **STANDS.** P1. **Closes B-2** |
| S41 | **B-3 — cycle leverage.** Leverage **belongs to the cycle**. **Must not be inherited silently from `profiles.current_leverage_tier`** — that value is a **UI default suggestion only**. Added to activation inputs, activation requirements, frozen cycle values, `accumulator_cycles` (`leverage numeric, required, immutable after activation`), risk decisions, signals, orders/fills, journal. Candidates 50/100/200/300/400/500×, but permitted = `min(owner_selected, strategy_limit, venue_symbol_limit, account_limit, jurisdiction restriction, execution-system limit)` — **most restrictive wins**. Over-limit selection → **reject activation, do not silently reduce, show the blocking limit, require owner reselection**. Frozen at activation; changing it requires termination + zero position + reconciliation + a new authorised cycle. | **STANDS.** P1. **Closes B-3** — a gap G30 and G31 created between them |
| S42 | **B-4 — resize tranche model.** **Core tranche** = original initial-entry position, adjusted only by authorised take profits or risk-reducing exits. **Active resize tranche** = most recently filled DCA resize quantity. **Only one may await rebalance at a time**; no stacking while the previous remains unrebalanced. Unique tranche ID + chronological sequence number; persist VWAP, filled qty, entry-fee allocation, funding allocation, estimated exit fee. **Individual all-in break-even** must recover: tranche VWAP + allocated entry fee + allocated accrued funding + estimated taker exit fee + conservative exit slippage. Reduce-only exit at that price; **rebalance complete only when confirmed filled and reconciled**. **Do not use the whole position's average as the tranche's break-even. Do not call the core "the second tranche."** `sell_second_tranche_at_break_even` → **superseded by `close_active_resize_tranche_at_individual_all_in_break_even`**. | **STANDS.** P1. **Closes B-4.** Consistent with v1's existing resize gate (*prior rebalance filled*) |
| S43 | **B-5 — `a_trailing`.** An **Accumulator structural trailing stop**. **Not** fixed-percentage. **Not** based on resize fill price. **Not** the UI's 10% stop. **Arming:** dormant until the first break-even rebalance is **completely filled and reconciled**; a **partial rebalance fill does not arm it**; once armed, armed for the rest of the cycle. **Reference:** long → confirmed five-candle **swing lows** forming and confirming **after the most recent entry or resize event**, trigger boundary = **fixed lower edge** of the swing's structural zone; short mirrors with swing highs and the upper edge. **Ratchet:** may only tighten (long: boundary must be higher; short: lower); **never loosens**; **a resize cannot loosen an armed stop**; loosening candidates are **ignored**. **Trigger:** completed 5m close beyond the active fixed zone edge → full exit; **a wick alone does not trigger**. On trigger: exit overrides pending resize · cancel/invalidate unsubmitted resizes · prohibit new resizes · reduce-only/full-close only · reconcile to zero · terminate `STRUCTURAL_STOP_EXIT` after reconciliation and journal finalisation. Persist every candidate, selection, ratchet, rejection and trigger with structural fingerprint and strategy version. | **STANDS.** P1. **Closes B-5.** Resolves the resize-price-vs-structure ambiguity in favour of **structure** |
| S44 | **B-6 — staleness by data class.** **Candles:** stale when `now > scheduled close + 90s`; forming candle never satisfies freshness; missing intervals, duplicates, out-of-order → fail closed; **server-authoritative clock**; persist candle timestamp and retrieval time. **Mark/index:** >10s. **Order book:** >5s, or broken sequence continuity, or **bid ≥ ask**, or missing depth, or uncertain connection health. **Account/equity/margin:** >15s at activation or immediately before an executable risk decision. **Position/order state:** >10s during active reconciliation. **Fee schedule:** >24h, or immediately on venue fee-tier change. **Funding:** > venue expected update interval + 60s. **Effect:** blocks activation, initial entry, resize, TP creation when execution data is unsafe, and discretionary advancement; records `DATA_HALTED`; **fails closed**. Risk-reducing emergency actions may use a **separately authorised safe-exit path with fresh executable pricing**. Recovery requires fresh validation; **no halted instruction replays automatically**. | **STANDS.** P1. **Closes B-6** |
| S45 | **B-7 — cross-margin remediation.** v1.1 margin mode is **cross**. `user_strategy.cross_margin = false` is a **known pre-ratification data defect**, **not authoritative**, and must not override the recovered strategy. A1 must atomically: confirm row identity · confirm `params = {}` · **confirm `cross_margin = false` and record it as before-state** · insert the history snapshot · populate `params.margin_mode = cross` · set `cross_margin = true` · read both back · verify both · **abort and roll back if they disagree** · **verify the venue/account supports cross margin for the intended market before any activation** · **never silently fall back to isolated**. Add `previous_cross_margin` / `new_cross_margin` to the planned history record or a typed before/after metadata field. | **STANDS.** P1. **Closes B-7 at specification level.** Physical correction **migration-pending** |
| S46 | **B-8 — symbol contract.** Canonical universe: **BTC, ETH, SOL, ARB, XRP**. The canonical params field **remains `symbols`, an array — do not replace it with singular `symbol`.** Distinguish **`symbols`** (strategy-level allowed universe) from **`cycle_symbol`** (the single owner-selected symbol frozen for one cycle). **Remove the silent fallback `COALESCE(params->>'symbol','BTC-USDT')`** — a missing or invalid cycle symbol must produce **no executable configuration**, not an invented selection. Owner chooses one `cycle_symbol`; validate membership in `symbols`; persist on the cycle; expose only the frozen `cycle_symbol` to the worker; **no consumer reads `params->>'symbol'`**; checksum covers the `symbols` array; cycle immutability covers `cycle_symbol`. Future contract exposes typed `allowed_symbols` · `active_cycle_symbol` · `cycle_id` · `strategy_version` · `strategy_checksum` · `enabled` · `environment` · `connection_id`. **View not modified in this documentation-only turn.** | **STANDS.** P1. **Closes B-8 at specification level.** View/contract correction **pending** |
| S34 | **G31 ruling — capital sufficiency.** `required_cycle_equity = equity_floor_amount + operational_reserve + initial_margin + estimated_round_trip_fees + estimated_round_trip_slippage`; activation passes only when `available_strategy_equity >= required_cycle_equity`. Decimal-safe arithmetic, **rounded conservatively against activation**. `required_reserve_pct = 10` (separate from the 20% floor). `margin_fraction = 10 / leverage` as a **dimensionless fraction of the capital baseline** *(CORRECTED 0.17.1 from 20; K=20 was never the owner's rule)*. `max_slippage_bps_per_side = 25`. `maximum_fee_rate_per_side = 0.10%`, authenticated taker assumed both sides. Resize sufficiency recalculated every time. §13. | **STANDS.** Grade **P1**. **Closes G31.** Resolves `notional_constant` |
| S35 | **G32 ruling — canonical cycle storage.** **Do not use `strategy_state`.** Plan `accumulator_cycles` and `accumulator_cycle_events` (append-only). Status model: 14 nonterminal, 11 terminal. Invalid transitions rejected. Row stores current state; events preserve every transition. **No table or migration authorised.** §14. | **STANDS.** Grade **P1**. **Closes G32 at specification level.** Implementation pending |
| S36 | **§9.6 v1.1 scope ruling.** Eleven inclusions, thirteen exclusions. §9.6. | **STANDS.** Grade **P1**. Replaces the assistant's invalidated 0.13 reading |
| S37 | **C1 resolved — by exclusion from v1.1, not by changing G30.** M4A may not execute under v1.1. At zero position the cycle terminates; it cannot reverse direction, open an opposite position, or reuse the same authorisation. A future hedge/reversal product requires a separately ratified version with explicit authorisation scope, separate cycle identity, independent baseline, floor, risk limits and kill-switch checks, and **no silent inheritance**. | **STANDS.** Grade **P1**. **Resolves C1** |
| S38 | **C2 resolved — by exclusion of automatic signal-driven activation.** "Deployed" cannot mean create a cycle, authorise capital, select a wallet, activate a strategy, switch direction, or bypass owner approval. A qualifying signal may advance an **already activated and armed** cycle `ARMED_WAITING_FOR_SETUP → SETUP_PENDING`. That is entry evaluation **within** an existing authorisation, not activation by signal. | **STANDS.** Grade **P1**. **Resolves C2.** Confirms the assistant's 0.15 reading was directionally right but was correctly withheld as unrecorded |
| S33 | **G30 ruling — canonical Accumulator cycle.** **One cycle = one owner-authorised position campaign.** Activation is an **explicit authenticated owner action**; the cycle begins **when the activation record is successfully committed** — not at first signal, not at first fill. Never activates automatically (eleven prohibited triggers). 24 activation requirements; 18 frozen cycle values; baseline and floor fixed for the cycle's life. Multiple setups may be evaluated **before** entry; **only one position campaign may receive fills.** Resizes, rebalances and partial exits stay within the same cycle. **Floor halt and kill switch do not automatically end a cycle.** A position-bearing cycle ends only on **confirmed zero position + full reconciliation + journal finalisation + persisted terminal reason.** **No automatic re-entry or next cycle.** Full ruling §12. | **STANDS.** Grade **P1**. **Closes G30.** Resolves §11.4(b). Supersedes §11.4(a). Opens G32. Escalates G31. **Contradicts Addendum A M4A and M4B — see §12.10** |
| S32 | **G29 ruling — `equity_floor_pct: 20`.** The floor is **20% of the strategy capital baseline established when an Accumulator cycle is activated**; a $500 baseline → **$100** floor. **The baseline is fixed for the life of that cycle and cannot automatically reset downward as equity declines.** Equity = total equity assigned to the strategy: available balance, used margin, realised P&L, unrealised P&L, accrued fees and funding when available. On reaching or falling below the floor: ten actions, §11.2. Pre-live requirements and fail-closed rule: §11.3. **Withdrawals or transfers cannot silently lower the active cycle's baseline or floor**; capital-baseline changes require the current cycle to end and a new owner-authorised cycle to begin. | **STANDS.** Grade **P1**. **Closes G29.** Opens G30, G31 |
| S26 | **G26 ruling — the retest zone must not breathe.** Freeze the zone at the close of the completed breaking candle. Persist the exact values listed at §3.6.1. `zone_tolerance = max(1 minimum tick, 0.05 × ATR(14, 5m))`, ATR calculated **using the completed breaking candle**. ATR, tolerance and zone edges remain fixed for the entire setup and its six-candle retest window. **Do not recalculate on later candles.** Later ATR movement cannot widen the zone, narrow the zone, rescue an invalid setup, invalidate a valid setup, move the expiry threshold, or change the fixed retest level. | **STANDS.** Grade **P1**. **Closes G26** |
| S27 | **G27 ruling — RFC 8785 (JCS) + SHA-256, lowercase hex.** Checksum target is the **machine-readable JSON specification**, not the prose Markdown. Future artifact: `docs/strategy-specs/dca/v1.1.json`. 11-step canonicalisation procedure at §9.1. The Markdown **explains** the spec and **references** the canonical JSON artifact and checksum. **Do not claim Markdown prose and JSON produce the same hash.** Nine activation blockers at §9.2. | **STANDS.** Grade **P1**. **Closes G27.** Supersedes the loose 0.12 wording ("document and database produce the same checksum") |
| S28 | **G28 ruling — do not amend or replace v1 in place.** Preserve the original recovered specification; create new versioned artifacts. `docs/STRATEGY_SPEC_v1.md` (retained), `docs/STRATEGY_SPEC_v1.1.md` (new), `docs/strategy-specs/dca/v1.1.json` (new). Keep the v1 strategy body intact for audit; add **only** a historical-status notice without rewriting its substantive rules. Both versions remain visible side by side. **Git history alone is not the sole audit record.** v1.1 requirements at §9.3. | **STANDS.** Grade **P1**. **Closes G28** |
| S29 | **Empty-row preservation — both continuity and history.** Update the existing `user_strategy` row **in place**: primary identity, user association, connection association, strategy association and original `created_at` lineage all unchanged. **Before modifying**, snapshot the exact before-state into an **immutable append-only** structure: new table `strategy_spec_history`. First history record must preserve `previous_params = {}`. **Do not convert `{}` to null, omit it, or describe it only in prose — `{}` is the actual prior database state.** Append-only; normal application roles may not update or delete history records. | **STANDS.** Grade **P1**. Resolves the 0.12 open reading — the answer is **both (a) and (b)**, not either |
| S30 | **Future atomic migration procedure** — 23 steps, recorded at §9.4. Includes: lock the target row; verify identity; verify `params` exactly equals `{}`; **abort if the row already contains unexpected data**; insert the immutable history record before update; read back and independently re-canonicalise and re-hash; require artifact, migration and read-back checksums to all match; **commit only if every verification passes; roll back the row update and history insert on any mismatch.** **No broad UPDATE affecting multiple `user_strategy` rows.** **Do not populate every user's DCA configuration from one owner-specific strategy without a separately approved product-level decision.** | **STANDS.** Grade **P1**. **Recorded, not executed** |
| S31 | **Authority rule** — recorded verbatim at §9.5. Authority is conferred by **verified agreement**, not by the mere existence of a database row. | **STANDS.** Grade **P1**. Supersedes and sharpens the 0.12 governance ruling |
| S23 | **A1 procedure.** Version bump and `params` population must happen **together in one controlled migration — no doc-only v1.1.** The migration must: (1) preserve the existing empty row for audit evidence; (2) populate `params` with the complete ratified Accumulator specification; (3) set `spec_version: v1.1`; (4) include the new swing, structural-break, EMA-confirmation and retest rules; (5) update `docs/STRATEGY_SPEC_v1.md` to v1.1 in the same commit **or** create `STRATEGY_SPEC_v1.1.md` and mark v1 superseded; (6) verify the database JSON and the document produce the **same canonical checksum**; (7) make the database row authoritative **only after** that verification passes. **Ruling:** until the migration succeeds, **the document is the recovered specification of record and the empty row is a known data defect — not an authoritative empty strategy.** | **STANDS.** Grade **P1**. Governs §9. See G26/G27/G28 |
| S24 | **G23 dissolved.** No BOS/CHoCH label needed; behaviour is mechanical. Long entry setup watches the most recent confirmed **swing high**; short entry setup the most recent confirmed **swing low**; a **long position's defensive structural trigger** watches the most recent confirmed **swing low**; a **short position's defensive trigger** the most recent confirmed **swing high**. The label cannot change execution behaviour. | **STANDS.** Grade **P1**. **Dissolves G23.** Firms M4's trigger subject |
| S25 | **G25 retest, fully specified.** Break candle and retest-confirmation candle are two separate completed 5m candles; full rule at §3.6. | **STANDS.** Grade **P1**. **Closes G25.** Last gap in the entry path |
| S20 | **G22 subject:** the most recent confirmed swing in the relevant direction — long breaks the most recent confirmed swing high, short the most recent confirmed swing low. Evaluate the swing that existed **before the breaking candle began**; a newly confirmed pivot cannot retroactively become that candle's subject. **Lookback bounded to the previous 48 completed 5m candles (4 hours).** No qualifying swing in that window → **no valid setup**; do not scan indefinitely for an older level. Once broken, that swing is the setup's **fixed retest level**; a newer swing does not replace it mid-setup. | **STANDS.** Grade **P1**. **Closes G22.** |
| S21 | **G24:** structure is what gets broken; **EMA(15) is the confirmation filter.** The entry was never intended to mean "break the EMA." Long: the 5m candle must close **above both** the selected swing-high level **and** EMA(15). Short: close **below both** the swing-low level **and** EMA(15). Directs that this be recorded as a **clarifying amendment, versioned**, so the formerly ambiguous v1 wording is not silently reinterpreted. | **STANDS.** Grade **P1**. **Closes G24.** Triggers §9 |
| S22 | **Amends S19 rule 5.** Liquidity-zone tolerance revised from one minimum tick to `max(1 minimum tick, 0.05 × ATR₁₄ on 5m)`. Pivots within that distance form one zone; the outermost wick remains the measured break level. | **STANDS.** Grade **P1**. Supersedes S19 rule 5 only; the rest of S19 is unchanged |
| S19 | **Swing point = confirmed five-candle pivot** on the 5m. Stated in full at §3.4. Includes: the 2-left/2-right rule, wick extreme as the level, confirmation on close of the second candle to the right, the one-tick equal-high/low liquidity-zone clause, the inside-candle clause, and the close-not-wick break condition. | **STANDS.** Grade **P1** — volunteered complete; no candidates offered. Closes 2 of G22's 3 parts |

### 2.1 Provenance grades

Not all recorded rules have equal standing. Each entry carries a grade so a future
reader can tell how it got here and how much weight it should bear.

| Grade | Meaning | Entries |
|---|---|---|
| **P1** | **Owner-stated.** Volunteered directly, unprompted by a suggested option. | S1–S15, S17+ |
| **P2** | **Owner-derived.** Computed from an owner's worked example, shown to the owner, acknowledged. Derivation recorded and reversible. | G3 (via S10/S12) |
| **P3** | **Assistant-surfaced, owner-ratified after explicit challenge.** The option was named by the assistant before the owner adopted it. The assistant flagged the anchoring risk, offered the alternative, and the owner confirmed by explicit selection. | **S16** |

> **P3 disclosure — S16.** EMA was named by the assistant in revision 0.4/0.5 as an
> example of a guess it was *declining* to make. The owner then proposed it. The assistant
> flagged that it had anchored the option, noted that S15 (candlestick structure) was
> volunteered unprompted and was the more proprietary read, warned that specification
> difficulty is a poor reason to change a rule, and offered to work S15 into a rule instead.
> **The owner selected EMA explicitly, on the record, as their own call.**
>
> P3 is recorded because it is the exact provenance that was missing from the June 2026
> scaffolding. A future reader should know this rule originated in the assistant's mouth
> and was adopted after challenge — not volunteered cold. It is ratifiable; it is not P1.
>
> **Re-affirmation (0.8).** In 0.7 the assistant disclosed (§4.4) that S17 had made
> structure-definition unavoidable via G22, and that S16's original basis — *structure is
> too hard to specify* — had therefore weakened. The owner reviewed this and kept EMA
> (S18). **Challenged twice, held twice.** The grade stays P3: a provenance grade records
> where a rule *came from*, and that does not change with confirmation. What changes is
> standing, and S16's standing is now strong.

---

## 3. Current model

### 3.1 Deployment

**M1.** Up to six deployments per trader. *(S1 — see B1)*

**M2.** Each wallet capped at $500. *(S2)*

**M3.** Each wallet seeks its own opportunity. No formal pairing between wallets.
A wallet may enter either by v1's `break_and_retest` or by the reversal branch (M4B).
*(S3, S8)*

### 3.2 Reversal exit — THIRD EXIT PATH *(S9, S10, S11, S12)*

> Recorded as its own clause. **This is not a hedge rule.** It is an exit path v1
> does not have.

v1 provides two exits: the take-profit ladder (200% / 300% / `original_first_entry_target`)
and the trailing stop (`active_after: first_rebalance`).

**M4.** On a confirmed 5m **break of structure** against an open position *(S17 — rule
open, G22/G23)*, evaluate the **overall trend on the 1H timeframe** *(S14)*, determined
by **EMA with candle confirmation** *(S16 — P3; period G20, confirmation rule G21)*:

- **M4A — Trend has turned ("top of the market", real reversal):**
  the wallet **EXITS** and triggers the opposite direction. No hedge — there is
  nothing left to hedge. *(S10, S11)*

- **M4B — Trend still favorable (pullback, not reversal):**
  the wallet **HOLDS**. A new wallet deploys in the opposite direction to take the
  pullback. **This is the hedge.** *(S8, S10, S11)*

**M5.** The hedge exists **only** in branch M4B, and only while the timeframes
disagree. It is the only branch in which two positions are concurrently open.
Hedge by effect on the book, not by enforced relationship. *(S8, S11)*

**M6.** A hedge-profile wallet targets 200%; its trailing stop arms at **100% on the
margin basis**. *(S5, G3)*

**M7.** **Hedge-profile designator = deployment context.** *(closes G2)*
- Deployed via M4B (pullback against an intact trend) → **hedge profile** → trails from 100%.
- Deployed via v1 `break_and_retest` → **primary profile** → trails from `first_rebalance`.

**M8.** An M4B deployment is a **discrete confirmed pullback trade** — a single entry
carrying its own confirmation. It does **NOT** inherit v1's `resize.unbounded: true` /
`depth_ceiling: null`. A hedge-profile wallet does not martingale into the prevailing
trend. *(S13 — closes G6)*

> **Consequence.** M8 removes the model's most dangerous configuration. Because M4B fires
> only while the higher timeframe remains favorable, the hedge is countertrend by
> construction; unbounded resize would have compounded a position into a trend already
> confirmed to be running against it. M8 forecloses that.

### 3.3 Structural findings (descriptive of v1 — not new rules)

**F1 — M4 fills a genuine blind spot in v1.**
Per v1, `stop.active_after: first_rebalance`; a rebalance requires a resize; resize is
`direction: down`. In owner example S10 price moved **up** (1650 → 1670), so nothing
resized, nothing rebalanced, and **the trailing stop never armed.** At +121% the
position had exactly two possible outcomes under v1: reach 200%, or don't. A rollover
would give back the entire 121% and continue into unbounded downward resize with no
protection at any point.

**M4 is therefore the only mechanism capable of closing a winning position that has
neither resized nor reached the first ladder rung.** It is a structural addition.

**F2 — the pre-rebalance window justifies M4B.**
Before the first rebalance fills, the primary has no stop while `resize.unbounded: true`
and `depth_ceiling: null` remain in force. Fresh capital deployed on a pullback is the
only available response in that window. Once the rebalance fills and the stop arms, the
primary can exit unaided.

**F3 — v1's per-account constraints are not violated.**
`one_position_at_a_time: true` and `margin_mode: cross` are per-account. Separate
connections are separate accounts with separate margin. Intact.

### 3.4 Swing-point definition (S19 — P1)

Owner-stated in full. Reproduced without addition.

On the **5-minute** chart, a swing point is a **confirmed five-candle pivot**.

1. A candle's **high** becomes a **swing high** when its high is higher than the highs of
   the **two completed candles immediately before** it and the **two completed candles
   immediately after** it.
2. A candle's **low** becomes a **swing low** when its low is lower than the lows of the
   two completed candles immediately before it and the two completed candles immediately
   after it.
3. **The actual wick extreme establishes the level.**
4. The swing is **not confirmed or usable until the second candle to its right closes.**
5. **AMENDED BY S22 (0.11).** ~~Equal highs or lows within one minimum tick~~ → Equal highs
   or lows within **`max(1 minimum tick, 0.05 × ATR₁₄ on 5m)`** are treated as a **single
   liquidity zone**. Pivots within that distance form one zone; the **outermost wick**
   remains the measured break level.
   *(Original 0.10 wording — one minimum tick — retained above, struck, per supersession
   convention. Rationale for the amendment: at one tick the clause fires only on
   near-literal equality and would rarely engage; the ATR-scaled band makes it
   volatility-relative. Owner-initiated.)*
6. An **inside candle** cannot become a swing point unless its high or low **independently**
   satisfies the five-candle rule.

**Break condition (S19).** A **wick through the level alone does not count as a confirmed
break.**

> **Property — confirmation lag.** By rule 4 a level is never usable until at least two
> 5m candles (≈10 minutes) after the pivot candle closes. This is inherent to the
> definition and is the mechanism by which it avoids hindsight and repainting. It bounds
> how recent a referenced level can be; it does not delay detection of a break, since the
> broken level is by construction already confirmed.

> **Convergence, not import.** S19's close-not-wick condition independently matches v1's
> `entry.wick_tags_allowed: false`. In 0.7 the assistant explicitly declined to import that
> precedent into G22 on the grounds that it governs a different mechanism. The owner
> arrived at the same principle unprompted. It is recorded as **P1 owner-stated**, not as
> inference, and the two rules agree by the owner's choice rather than by carry-over.

### 3.5 Break of structure — subject, lookback, persistence (S20, S21 — P1)

**Subject.** The **most recent confirmed swing in the relevant direction**:
- **Long setup** → break the most recent confirmed **swing high**.
- **Short setup** → break the most recent confirmed **swing low**.

**No retroactive subject.** Evaluate the swing that existed **before the breaking candle
began**. A newly confirmed pivot cannot retroactively become that candle's subject.

**Bounded lookback.** The previous **48 completed 5m candles (4 hours)**. If no qualifying
swing exists in that window there is **no valid setup**. Do **not** scan indefinitely for
an older level.

**Setup persistence.** Once broken, that swing remains the setup's **fixed retest level**.
A newer swing does **not** replace it mid-setup.

**Confirmation (S21).** The break is confirmed when the 5m candle closes **beyond both**
the selected swing level **and** EMA(15) — above both for a long, below both for a short.
Structure is the thing broken; **EMA(15) is the confirmation filter.**

> **Implementation note (descriptive).** `junk_filter.py` already implements Wilder's
> **ATR(14) on 5m** for v1's `junk_filter.volatility_floor`. S22's tolerance term
> (`0.05 × ATR₁₄ 5m`) can reuse that existing computation; no new indicator is required.
> Recorded as an observation about existing code. **No code was written or changed.**

#### 3.5.1 Trigger subject table (S24 — P1)

The BOS/CHoCH taxonomy is **dissolved**. Behaviour is mechanical and label-independent:

| Context | Watches |
|---|---|
| **Long entry setup** | most recent confirmed **swing high** |
| **Short entry setup** | most recent confirmed **swing low** |
| **Long position — defensive structural trigger (M4)** | most recent confirmed **swing low** |
| **Short position — defensive structural trigger (M4)** | most recent confirmed **swing high** |

> The label cannot change execution behaviour. *(S24)*

### 3.6 Retest — entry confirmation (S25 — P1)

The **breaking candle** and the **retest-confirmation candle** are **two separate completed
5m candles.** The breaking candle **cannot** also count as the retest.

**Long:**
1. The **breaking candle** closes **above** the selected swing high **and above EMA(15)**.
2. Starting with the **next** candle, price must return to the **fixed broken-level zone**.
3. The **retest candle's low** must **enter that zone**.
4. That candle must **close back above** the swing level **and above EMA(15)**.
5. **Only that completed retest candle confirms the long entry.**

**Short — mirror of every condition:**
1. Break candle closes **below** the selected swing low **and EMA(15)**.
2. A later candle returns to the broken-level zone.
3. Its **high** enters the zone.
4. It **closes below** the swing level **and EMA(15)**.
5. That completed candle confirms the short entry.

**Zone tolerance:** `max(1 minimum tick, 0.05 × ATR₁₄ on 5m)` — same term as S22.

**Expiry and validity:**
- Retest must confirm within the **next six completed 5m candles**.
- A **long** setup **expires immediately** if a candle **closes below the lower edge** of the
  retest zone before confirmation.
- A **short** setup **expires immediately** if a candle **closes above the upper edge**
  before confirmation.
- No valid retest within six candles → **the setup expires**.
- A **wick into the zone is sufficient to establish that a retest occurred**, but the
  **completed close** beyond the level and EMA is required to **confirm** it.

> **S21 applies to both candles.** The first close confirms the **structural break**; the
> later close confirms that the **retested level held**. *(S25)*

#### 3.6.1 Frozen retest zone (S26 — P1) — CLOSES G26

**The retest zone must not breathe.** Freeze it at the **close of the completed breaking
candle**.

**Persist at break confirmation — exact values:**

| Field |
|---|
| selected confirmed swing ID or deterministic fingerprint |
| fixed swing level |
| break candle identifier / open time |
| break candle close time |
| **ATR(14) on 5m, calculated using the completed breaking candle** |
| market minimum tick |
| calculated tolerance |
| fixed **upper** zone edge |
| fixed **lower** zone edge |
| strategy version |
| symbol |
| direction |

```
zone_tolerance = max(one minimum tick, 0.05 × ATR(14, 5m))
```

The ATR value, tolerance and zone edges **remain fixed for the entire setup and its
six-completed-candle retest window. Do not recalculate the zone on later candles.**

**Later ATR movement cannot:** widen the zone · narrow the zone · rescue an invalid setup ·
invalidate a valid setup · move the expiry threshold · change the fixed retest level.

> **Resolves the 0.12 concern.** A breathing lower edge would have let a setup expire on an
> ATR shift rather than a price move. Freezing at break makes expiry a function of price
> alone, and makes the setup reproducible from the persisted values without replaying ATR.

---

## 4. Open items — `OWNER RULE NOT FOUND`

**No engine work may proceed on any rule depending on an unresolved item. None may be
filled by inference, convention, or analogy.**

### 4.1 CRITICAL

| ID | Question | Why it is critical |
|---|---|---|
| **G33** | **`original_first_entry_target` is undefined.** | **Opened and promoted in 0.16.** v1's take-profit rung 3 — *"at `original_first_entry_target` → sell_rest_full_close."* **The term is referenced and never defined anywhere in v1, the repo, or this session.** Flagged `OWNER RULE NOT FOUND` in the 2026-07-15 audit; never answered. **G30 §12.8 makes it structural:** the third rung is what *ends a cycle* under `TAKE_PROFIT_COMPLETE`. An undefined final rung means the cycle's intended natural termination is undefined. **BLOCKS V1.1 RATIFICATION.** *(Superseded G31 in §4.1; the old G31 entry text is retained in §4.3.)* **Not assumed.** |
| **G31_OLD** | **The capital-sufficiency check has three undefined terms.** | **CLOSED in 0.16 — see §4.3.** Prior text: **ESCALATED TO CRITICAL in 0.15.** Opened 0.14 against S32's pre-live requirement. G30 now makes it doubly blocking: **activation requirement 21** — *"The required capital-sufficiency checks pass"* — cannot be evaluated without it, so **no cycle can activate.** Undefined: **`required reserve`** (no value, no definition, absent from v1) · **`slippage allowance`** (v1 has `max_slippage_guard: true` with **no threshold**) · **`estimated fees`** (no fee model, source or venue schedule). Initial margin is derivable (`20 / leverage` — **as written at the time; the constant was corrected to 10 in 0.17.1**); these three are not. S27's activation blockers forbid activation when *any required field is absent or invalid*, and S32 + S33 both make these required. **Not assumed.** |
| **G19** | ~~Operational definition of "bullish candlestick structure" on the 1H.~~ | **RETIRED in 0.6 — MOOT.** S16 supersedes S15; structure is no longer the trend determinant. **Retained in the ledger, not deleted:** if S16 is ever revisited, G19 revives with it. |

### 4.2 Open

| ID | Question | Notes |
|---|---|---|
| **G4** | What does the hedge's trailing stop **follow**? Resize/retest levels (as v1's primary), or giveback from peak? | "Arms at 100%" defines *when*, not *what it tracks*. |
| **G5** | Does the hedge run v1's full ladder (200 → 300 → `original_first_entry_target`), or is 200% a full close? | Riding to 300% conflicts with the fast-bank intent of the 100% arm. |
| **G7** | Hedge sizing — own `10 / leverage` *(corrected 0.17.1 from 20)*, or matched to the primary's live exposure? | |
| **G8** | Does the primary stop resizing once an M4B wallet is live, or once it closes? | v1 resize has no external gate. |
| **G9** | May an M4B wallet re-enter after closing at 200% while the primary is still open and resizing? | The hedge is time-boxed by a target; the primary is not bounded at all. |
| **G10** | Is the daily bias (S4, "bull day") **retained**, or is the M4 1H check its formalisation? | **Unblocked in 0.6:** S16 makes the 1H check EMA-based and therefore deterministic — it no longer requires a human read, and the autonomy blocker noted in 0.5 is gone. What remains is narrower: **1H is intraday; "bull day" is day-scale.** Either the 1H retires S4, or they are two separate inputs and S4 needs its own definition. Owner-only. |
| **G11** | Portfolio exposure cap. 6 × $500 = $3,000. | v1 caps per deployment; nothing caps the book. See B4. |
| **G12** | What is `user_strategy.hedge_guard` for? | jsonb, `{}`, read by nothing, written by nothing, absent from v1. Two in-session guesses; one wrong. **No further guess recorded.** |
| **G13** | Is **"top of the market"** identical to the higher timeframe turning, or an additional condition on top of it? | S11 reads as two things ("at the top of the market **and** that's a real reversal"). |
| **G15** | Does the higher-timeframe veto reach **other exits**? | v1 has `exit_overrides_resize: true` — exit already wins over resize. If a higher timeframe can veto the M4 exit, can it veto the **trailing stop**? That would let the higher timeframe override the only unbounded-drawdown protection. Must be deliberate. |
| **G16** | **Does an M4B trade resize at all?** M8 establishes *not unbounded* — it does not establish *zero*. | "Not unbounded" ≠ "no resize." Three live possibilities: (a) single entry, no safety orders; (b) bounded resize with a `depth_ceiling` — value unstated; (c) resize permitted only while the pullback confirmation persists. Owner-only. |
| **G17** | **Is the hedge profile a *profile* of `dca`, or a distinct strategy identity?** | With G6 closed, an M4B deployment shares **almost nothing** with v1's Accumulator: different entry (pullback vs `break_and_retest`), no unbounded resize, no re-anchor, no rebalance, different stop arm (100% vs `first_rebalance`). The **only** common element is the 200% target. Schema impact: `strategies` holds 6 rows and `user_strategy.strategy_id` is a FK to it — if M4B is its own strategy it needs an identity; if it is a profile of `dca`, `params` must carry the profile flag. Determines where M6/M7/M8 are stored. |
| **G20** | **EMA period on the 1H.** | **Opened in 0.6.** v1 uses `ema_period: 15` — **on the 5m**. Whether the 1H reuses 15, or uses a slower period, is unstated. "Same as v1" is an obvious guess and is **NOT recorded**. |
| **G21** | **What does the candle confirm, and how?** | **Opened in 0.6.** S16 assigns the candle a *confirmation* role but not a rule. Whether this lifts v1's 5m rule to the 1H (`confirmation: close_above_ema`, `wick_tags_allowed: false`) or is a different condition is unstated. **Not recorded by analogy.** |
| **G24** | **Does v1's `entry.break_and_retest` measure against swing structure?** | **Opened in 0.10.** S19 states the break-and-retest logic "would measure against that confirmed wick level." v1's entry block specifies `type: break_and_retest`, `timeframe: 5m`, `ema_period: 15`, `confirmation: close_above_ema`, `wick_tags_allowed: false` — but **never names what is broken and retested.** The EMA is specified as the *confirmation*, not necessarily the broken level. Two readings: (a) S19 **clarifies** v1 — the broken level was always structure, with the EMA as a confirmation filter; or (b) S19 **revises** v1's entry. If (a), one swing definition serves both v1's entry and the M4 trigger, and v1 gains precision it always lacked. If (b), a ratified rule is changing and must be versioned. **Owner-only. Not assumed.** |
| **G26** | **Is the retest-zone tolerance frozen at break, or recomputed each candle?** | **Opened in 0.12.** The zone term is `max(1 tick, 0.05 × ATR₁₄ 5m)`. **ATR₁₄ changes every candle.** S20 fixes the *level*; S25 calls it the "**fixed** broken-level zone" — but if ATR is re-evaluated per candle the **edges breathe**, which moves the expiry threshold ("closes below the lower edge") between candles. Two readings: (a) tolerance computed **once at the breaking candle's close and frozen** for the setup's life; (b) **recomputed each candle**. Reproducibility differs materially. **Not assumed.** |
| **G27** | **What canonicalisation produces the "same canonical checksum"?** | **Opened in 0.12.** S23(6) requires the database JSON and the document to hash identically. That is only reproducible under a **defined canonicalisation** — key ordering, whitespace, unicode normalisation, number formatting. RFC 8785 (JCS) is one standard; there are others. It also implies the document must **embed the canonical JSON verbatim** rather than describe it in prose, or the two cannot hash to the same value. **No method recorded.** |
| **G32_OLD** | **Where do cycle records live?** | **CLOSED in 0.16 — see §4.3.** Prior text: **Opened in 0.15.** G30 requires a persisted activation record, a unique `cycle_id`, 18 frozen values, cycle status, and terminal reasons — with atomic commit. **No cycle table exists.** `strategy_state` exists (`state` jsonb) but holds **0 rows** and is written by nothing. Whether cycles live there, in a new dedicated table, or elsewhere is unstated — as is how `cycle_id` uniqueness and the "permanently prevented from creating another position" latch are enforced. Schema question; **owner-scoped because it determines what the v1.1 artifact must reference.** **Not assumed.** |
| **G28** | **v1 document disposition — amend in place, or supersede?** | **Opened in 0.12.** S23(5) offers an **OR**, not a choice: *update `docs/STRATEGY_SPEC_v1.md` to v1.1 in the same commit* **or** *create `STRATEGY_SPEC_v1.1.md` and mark v1 superseded*. These differ in audit character: amending in place loses the ratified v1 text from HEAD (recoverable only via git); superseding preserves both documents side by side. **Owner has not selected.** | **Opened in 0.7.** In standard structure vocabulary these are different events: a **BOS** breaks a swing *in the direction of the prevailing trend* — it signals **continuation**. A **CHoCH** is the first break *against* the prevailing trend — it signals **reversal**. M4 is described as a reversal trigger but named BOS. Owner may use "break of structure" as a general term covering both; the engine cannot. Determines *which* swing is watched and in which direction. |

### 4.3 Closed

| ID | Resolution | Provenance |
|---|---|---|
| **G31** | **Capital sufficiency fully defined.** Five components; reserve 10% ($50 on a $500 baseline, separate from the $100 floor); `margin_fraction = 10/leverage` dimensionless *(CORRECTED 0.17.1 from 20)*; slippage 25 bps/side; fee ceiling 0.10%/side, authenticated taker both sides; fail closed on missing/stale data; never substitute zero. §13. | **Owner-stated, S34 — grade P1.** Also resolves `notional_constant` — open since the 2026-07-15 audit. **Value corrected to 10 in 0.17.1, owner-confirmed P1** |
| **G32** | **Canonical cycle storage.** `accumulator_cycles` + `accumulator_cycle_events`, append-only, RLS, server-authorised only, no cycle-ID reuse, decimal-safe money. `strategy_state` explicitly rejected. §14. | **Owner-stated, S35 — grade P1.** Specification level; **physical implementation pending** |
| **G30** | **One cycle = one owner-authorised position campaign.** Begins at activation-record commit; never automatic. Baseline and floor frozen for the cycle. Multiple setups before entry; one position campaign after first fill. Ends only on verified zero position + reconciliation + journal finalisation. No auto re-entry. §12. | **Owner-stated, S33 — grade P1** |
| **G29** | **`equity_floor_pct: 20`** — 20% of the strategy capital baseline fixed at cycle activation. $500 baseline → $100 floor. Halt semantics, equity definition, pre-live requirements and the withdrawal rule at §11. | **Owner-stated, S32 — grade P1.** v1's oldest open `OWNER RULE NOT FOUND`, unanswered since the 2026-07-15 audit. **`capital-rules.ts` `floorUsd: 100` was NOT harvested** — the value arrived at $100 by the owner's own derivation (20% × $500), not by adopting June scaffolding |
| **G26** | **Retest zone frozen at the breaking candle's close.** ATR(14) 5m calculated using the completed breaking candle; tolerance and both zone edges fixed for the setup's entire six-candle window. No recalculation. Later ATR movement cannot widen, narrow, rescue, invalidate, move the expiry threshold, or change the level. Twelve persisted fields at §3.6.1. | **Owner-stated, S26 — grade P1.** Answers the 0.12 question (a) *frozen*, not (b) *recomputed* |
| **G27** | **RFC 8785 (JCS) + SHA-256, lowercase hex.** Checksum target is `docs/strategy-specs/dca/v1.1.json` — **the JSON artifact, not the Markdown.** The Markdown references the artifact and checksum. Nine activation blockers. §9.1–9.2. | **Owner-stated, S27 — grade P1.** Corrects the 0.12 framing: prose and JSON were never going to hash alike, and the owner said so explicitly |
| **G28** | **v1 is preserved, not amended.** Three artifacts side by side: `STRATEGY_SPEC_v1.md` (historical notice only), `STRATEGY_SPEC_v1.1.md` (new), `strategy-specs/dca/v1.1.json` (new). v1's substantive rules are not rewritten. **Git history alone is not the sole audit record.** §9.3. | **Owner-stated, S28 — grade P1.** Resolves the 0.12 OR in favour of supersession |
| **G25** | **Retest fully specified.** Break candle and retest candle are two separate completed 5m candles; the break candle cannot be the retest. Wick into the zone establishes that a retest occurred; a completed close beyond level and EMA confirms it. Six-candle window; immediate expiry on a close beyond the far zone edge. §3.6. | **Owner-stated, S25 — grade P1.** Resolves the S21 ambiguity: **S21 applies to both candles** |
| **G23** | **DISSOLVED.** No BOS/CHoCH label required. Behaviour is mechanical and label-independent; four-way trigger table at §3.5.1. | **Owner-confirmed, S24 — grade P1.** Provisionally dissolved in 0.11 on assistant reading; **owner confirmed explicitly in 0.12** |
| **G22** | **Break of structure fully defined.** Swing point = confirmed five-candle pivot (§3.4). Break = close beyond the level; a wick alone is not a break. Subject = most recent confirmed swing in the relevant direction, no retroactive subject, 48-candle (4h) bounded lookback, no valid setup if none in window, broken swing persists as the fixed retest level (§3.5). | **Owner-stated, S19 + S20 — grade P1.** No candidates offered on either. **This was the last CRITICAL conceptual gap.** |
| **G24** | **Structure is what breaks; EMA(15) is the confirmation filter.** v1's `entry.break_and_retest` was ambiguous as to what is broken; it never meant "break the EMA." Confirmation = close beyond **both** the swing level and EMA(15). | **Owner-stated, S21 — grade P1.** Recorded as a **clarifying amendment to v1, versioned** at owner's direction. See §9 |
| **G18** | **1H trend method class = EMA, with candle confirmation.** Supersedes the 0.5 closure (candlestick structure). Parameters open: G20 (period), G21 (confirmation rule). | **S16 — grade P3**, see §2.1 |
| **G1** | **5m reversal/pullback signal = break of structure.** Operational rule open (G22), semantics open (G23). | **Owner-stated, S17 — grade P1** (no candidates offered) |
| **G14** | **Overall-trend timeframe = 1H.** | **Owner-stated, S14** |
| **G6** | **A hedge-profile wallet does NOT inherit unbounded resize.** M4B deployments are discrete confirmed pullback trades (M8). Countertrend-martingale risk retired. | **Owner-stated, S13** — selected explicitly against a competing reading |
| **G2** | **Hedge-profile designator = deployment context** (M7). Not ordinal, not pairing. | Owner-confirmed structure, S11 + S12 |
| **G3** | **100% is on the margin basis** — consistent with v1 `take_profit.basis: margin`, `reference: current_average_entry`. | **Derived from owner example S10, acknowledged S12.** Audit trail: 1650 → 1670 = 20 pts = **1.212%** price. At 100x = **121% margin ROI** = "not quite 200%." The example computes on **no other basis**. |

> **Provenance grade note.** G3 is closed on *derived* evidence (arithmetic from the
> owner's own worked example, shown to the owner and acknowledged), not on a direct
> statement. The derivation is recorded above so it can be checked and reversed.
>
> **Scope limit:** S10 used **100x**. This closes the *basis* (margin), **not** the
> leverage. v1 treats leverage as a variable input (`margin_fraction_formula: 10 / leverage`
> — *corrected 0.17.1 from 20*).
> **100x is not recorded as a rule.**
>
> **0.17.1 AUDIT NOTE.** G3's derivation used the 20-point move in S10 (1650 → 1670) to compute
> the price percentage. That arithmetic is unaffected and G3 **remains closed**: the basis is
> margin. But the coincidence between that 20-point move and `notional_constant: 20` was **not**
> evidence for the constant, and must not be read as corroboration. The constant is **10**.

---

### 4.4 Structural observation (0.7) — the G19 problem returned — **CLOSED 0.8**

> **Disposition:** Reviewed by owner. **S16 re-affirmed (S18). No change.** Retained
> below as the record of a challenge raised and answered.

Recorded as an observation. **No action taken. No rule changed.**

In 0.5 the owner's 1H trend method was **candlestick structure** (S15). G19 was opened
against it: "bullish structure" had no operational definition, and pinning it down was
identified as the hardest item in the model. In 0.6 the owner superseded S15 with **EMA**
(S16, grade P3), and G19 was retired as moot.

In 0.7 the owner defined the 5m reversal signal as **break of structure** (S17).

**Structure is therefore back — as the reversal determinant rather than the trend
determinant.** G19's difficulty was not eliminated in 0.6; it was relocated, and it now
sits in G22.

Two consequences follow, both for the owner to weigh:

1. **The structure-definition work is now unavoidable.** It was deferred in 0.6 by
   switching the 1H to EMA. G22 requires it regardless — swing points, break conditions,
   lookback. There is no longer a version of this model that avoids defining structure.

2. **S16's basis is worth re-examining.** S16 (P3) was adopted at a point where defining
   structure looked like the blocker. If G22 is answered, that machinery exists — and the
   reason for moving the 1H off structure is weaker than it appeared in 0.6. S16 remains
   **STANDS**; this is not a recommendation to revisit it. It is a note that the condition
   under which it was chosen has changed, recorded so the choice can be reviewed on
   accurate grounds rather than remembered as settled.

*Cross-reference: G19 is retired but retained. If S16 is revisited, G19 revives.*

## 5. Architectural blockers (verified, read-only)

**B1 — The cap is 6 connections, not 6 wallets.**
```sql
is_connection_slot_available(_user_id):
  SELECT count(*) FROM exchange_connections
  WHERE user_id = _user_id
    AND status NOT IN ('disconnected','disabled')
  < 6
```
No cap on `wallet_connections` exists. Chain: wallet → `assigned_exchange_connection_id`
→ `exchange_connections` → `user_strategy(user_id, connection_id)`. The **connection**
is the strategy unit; the wallet authorises it. Owner language says "wallet"; the system
counts connections. Reconcile before M1 means anything.

**B2 — Per-wallet state does not exist. It is per-user.**
`profiles` is one row per user. These are single-valued for the entire account:

| Column | Default | Required per-wallet by |
|---|---|---|
| `active_wallet_usd` | 500 | M2 |
| `strategy_mode` (long/short) | 'long' | M3, M4 |
| `current_leverage_tier` | 100 | per-wallet leverage |

`AccumulatorSquadPage` writes direction via `persist({ strategy_mode: next })` against
`profiles`. **Flipping one wallet short flips every wallet short.** M4 is structurally
impossible until these move onto `user_strategy`, already keyed `(user_id, connection_id)`.

*(`lifetime_harvested_cash`, `target_budget_items` are correctly account-level.)*

**B3 — Retracting the ordinal removed a real hazard. Do not reintroduce it.**
`wallet_connections` has **no** slot / index / position / ordinal / role / pair column.
Under S6, "wallet 2" would have been derived from creation order — disconnecting wallet 1
would have silently promoted the hedge to primary and shifted every pairing by one, with
no alert, live positions running under inverted roles. **S8 eliminated this.** M7 keeps it
eliminated by designating on deployment context rather than position.

**B4 — No portfolio limits configured.**
`user_trading_limits` has **zero rows**. No `max_total_exposure_usd`, `daily_loss_limit_usd`,
or `max_order_size_usd` for any user. The execution guard already carries a
`DAILY_LOSS_LIMIT` reason code for a limit that was never set.

**B5 — Inherited v1 defects.**
- `user_strategy.params` = `{}` — zero keys. v1's declared authoritative source is empty.
  **STILL OPEN.**
- ~~`strategies.markets` = `'spot'` vs v1's `market: futures`~~ — **RESOLVED 2026-07-16.**
  Owner-authorised migration `20260716062240_b34f9039` set `markets = 'futures'` for slug
  `dca`. Verified post-apply: `dca=futures`; the other five strategy rows unchanged;
  `user_strategy.params` untouched (`{}`).
  **Residual:** the existing `user_strategy.market_type` row still reads `'spot'` — it was
  deliberately **not** backfilled. `StrategyConfigModal` will write `'futures'` on the next
  save. No code changed; the logic `isFutures = markets !== "spot"` was always correct — only
  the data was wrong.
- `active_bot_config.symbol` = `COALESCE(params->>'symbol','BTC-USDT')`. v1 stores `symbols`
  (plural). The view emits `BTC-USDT` as a silent default even after `params` is populated,
  unless key spelling is reconciled. **STILL OPEN.**

---

## 6. Impact on ratified v1, if adopted

v1 would require:

1. A **1H timeframe** — v1 is 5m end to end and has none. Method still open. *(S14, G18)*
2. A **reversal signal** definition — a second trigger beside `break_and_retest`, driving both M4A and M4B. *(G1)*
3. A **third exit path** (M4A) that can fire before the ladder and before the trailing stop arms. *(§3.2, F1)*
4. A **second stop profile** (arm at 100%) plus the M7 designator. *(M6, M7)*
5. A **deployment concept** — v1 describes one account, not N. *(M1, B1, B2)*
6. A **portfolio exposure rule**. *(G11, B4)*

---

## 7. Ratification sheet

Addendum A cannot be ratified while any §4.1 or §4.2 item is open.

| Item | Owner decision | Date | Initials |
|---|---|---|---|
| **G22 — BOS operational rule (CRITICAL)** | | | |
| G23 — BOS vs CHoCH semantics | | | |
| G20 — 1H EMA period | | | |
| G21 — candle confirmation rule | | | |
| G16 — M4B resize depth (zero / bounded / conditional) | | | |
| G17 — hedge = profile of `dca` or own strategy | | | |
| G4 — trailing reference | | | |
| G5 — ladder or full close at 200% | | | |
| G7 — hedge sizing | | | |
| G8 — primary resize gate | | | |
| G9 — hedge re-entry | | | |
| G10 — daily bias retained? | | | |
| G11 — portfolio exposure cap | | | |
| G12 — `hedge_guard` purpose | | | |
| G13 — "top of the market" | | | |
| G15 — veto scope over stop | | | |
| B1 — wallet vs connection | | | |
| B2 — per-wallet state relocation | | | |
| G3 confirm — margin basis (derived) | | | |
| **S16 confirm — EMA method (P3, assistant-surfaced)** | | | |

**Addendum A status on completion:** ______________  **Date:** ____________

---

## 8. What was deliberately not done

- `docs/STRATEGY_SPEC_v1.md` — **not touched.** Remains ratified v1.
- `user_strategy.params` — **not written.** Still `{}`. Populating it would constitute
  ratification by side effect.
- **Migrations: exactly one, owner-authorised.** `20260716062240_b34f9039` —
  `UPDATE public.strategies SET markets = 'futures' WHERE slug = 'dca';` — three lines,
  one file, no code touched. Scope verified by diff and by post-apply query. This is the
  only write made during this session.
- No seed, flag, deployment, or configuration change. No engine work. No order path.
- No gap filled by inference. No generic DCA convention imported.
- **100x not recorded as a rule** despite appearing in S10.
- `hedge_guard` — no third guess.

---

## 9. v1 → v1.1 amendment register

> **NOTHING IN THIS SECTION HAS BEEN EXECUTED.**
> `docs/STRATEGY_SPEC_v1.md` is **unedited**. `docs/STRATEGY_SPEC_v1.1.md` and
> `docs/strategy-specs/dca/v1.1.json` **do not exist**. No migration has been created or
> run. **No checksum has been generated. No checksum has been verified. No database
> authority has been conferred.** `user_strategy.params` remains `{}`.
> Recording a procedure is not performing one.

### A1 — `entry.break_and_retest` reference clarification

- **Status:** PENDING — recorded, not applied
- **Directed by:** owner, S21 (0.11) · procedure S23 (0.12) · rulings S26–S31 (0.13)
- **Grade:** P1
- **Class:** **Clarification, not revision.** v1 never named what is broken; A1 supplies
  the missing referent. Intent unchanged.

**v1 as written (ambiguous):**
```
entry:
  type: break_and_retest
  timeframe: 5m
  ema_period: 15
  confirmation: close_above_ema
  wick_tags_allowed: false
```

**A1:** the broken level is **swing structure** (§3.4/§3.5). EMA(15) is the **confirmation
filter**. Long → close above both the selected swing high and EMA(15). Short → close below
both.

### 9.1 Canonicalisation procedure (S27 — P1)

**RFC 8785 (JCS) + SHA-256.** Checksum target: **the machine-readable JSON specification —
not the prose Markdown.**

Future artifact: `docs/strategy-specs/dca/v1.1.json`

1. Parse the JSON specification.
2. Canonicalise per **RFC 8785 / JCS**.
3. Encode the canonical result as **UTF-8**.
4. Calculate **SHA-256** over those exact bytes.
5. Represent the checksum consistently as **lowercase hexadecimal**.
6. Store the checksum alongside the database specification.
7. Include / reference the same version and checksum in the v1.1 Markdown document.
8. **Independently** retrieve `user_strategy.params` from the database.
9. Canonicalise the retrieved params using the **same** RFC 8785 process.
10. Calculate its SHA-256 **independently**.
11. **Require an exact hash match before conferring database authority.**

> The Markdown **explains** the specification and **references** the canonical JSON artifact
> and checksum. **Do not claim Markdown prose and JSON produce the same hash.** *(S27)*

### 9.2 Activation blockers (S27 — P1)

The strategy **must not activate** if:

- canonicalisation fails
- the JSON artifact is missing
- the database params are missing
- the checksum is missing
- the checksums differ
- the database version differs from the artifact version
- `ratified` is not true
- the row identity does not match the intended user, connection and strategy
- **any required field is absent or invalid**

### 9.3 Version preservation (S28 — P1)

**Do not amend or replace v1 in place.** Three artifacts, side by side:

| Artifact | Disposition |
|---|---|
| `docs/STRATEGY_SPEC_v1.md` | **Retained.** Body intact. Historical-status notice only |
| `docs/STRATEGY_SPEC_v1.1.md` | **New.** Does not yet exist |
| `docs/strategy-specs/dca/v1.1.json` | **New.** Canonical artifact. Does not yet exist |

**v1 notice — additive only, substantive rules untouched:**
```
Status: Superseded by v1.1
Historical recovered specification
Never populated into user_strategy.params
Retained for audit
```

**The v1.1 document must:** identify v1 as its predecessor · list every clarification and
amendment · **distinguish recovered v1 rules from owner-ratified v1.1 additions** ·
reference the canonical JSON artifact · state the JCS/SHA-256 verification procedure ·
**include the verified checksum only after it is actually generated** · **never use
placeholder hashes as if verified.**

> **Both versions must remain visible side by side. Git history alone is not the sole audit
> record.** *(S28)*

### 9.4 Future atomic migration procedure (S30 — P1) — **NOT EXECUTED**

Must run **atomically**:

1. Identify the exact intended `user_strategy` row.
2. **Lock** the target row.
3. Verify the row's user, connection and strategy identity.
4. Verify `strategies.slug = 'dca'`.
5. **Verify current params exactly equal `{}`.**
6. **Abort if the row already contains unexpected data.**
7. Generate / validate the complete v1.1 canonical JSON specification.
8. Canonicalise using RFC 8785.
9. Calculate its SHA-256 checksum.
10. **Insert the immutable before/after history record.**
11. **Update the existing `user_strategy` row in place.**
12. Set the complete v1.1 params.
13. Set `spec_version = v1.1` in the authoritative structure.
14. Set `ratified = true`.
15. Store the checksum in the approved schema location.
16. **Read the updated row back** from the database.
17. **Independently** canonicalise the retrieved params.
18. **Independently** calculate the SHA-256.
19. Compare **artifact, migration and read-back** checksums.
20. Verify **all three** match exactly.
21. Verify the version and ratification state.
22. **Commit only if every verification passes.**
23. **Roll back the row update and history insert on any mismatch.**

**Prohibited:** a broad `UPDATE` affecting multiple `user_strategy` rows · populating every
user's DCA configuration from one owner-specific strategy without a **separately approved
product-level decision**.

### 9.5 Authority rule (S31 — P1) — recorded verbatim in meaning

> Until the v1.1 population migration succeeds and independent checksum verification passes,
> `docs/STRATEGY_SPEC_v1.md` together with the owner-ratified revision record remains the
> **recovered specification of record**. The empty `user_strategy.params` object is a
> **known data defect** and has **no authority to erase or override the recovered strategy**.
>
> After the migration succeeds and the v1.1 artifact, database row, version, ratification
> state and checksum all match, the populated database row becomes the **operational
> authoritative source for that specific `user_strategy` record**.
>
> **Authority is conferred by verified agreement — not by the mere existence of a database
> row.**

This resolves the precedence paradox standing since the 2026-07-15 audit. v1's own text made
the row authoritative on conflict; the row has never held content. Read literally, that
clause surrendered the specification to an empty object. **S31 suspends row-precedence until
the row is populated and checksum-verified.**

### 9.6 v1.1 scope — RESOLVED (S36 — P1)

> Replaces the assistant's 0.13 reading, invalidated in 0.14. **This is the owner's ruling.**

**Accumulator v1.1 CONSISTS OF:** (1) recovered v1 rules that remain valid · (2) owner-ratified
clarifications and completions from this session · (3) the complete structural swing, break and
retest entry path · (4) frozen retest-zone behaviour · (5) equity-floor definition · (6)
capital-baseline definition · (7) Accumulator cycle lifecycle · (8) capital sufficiency, reserve,
fee and slippage rules · (9) canonical JSON/JCS/SHA-256 governance · (10) version-preservation and
migration-audit requirements · (11) canonical cycle-storage requirements.

**v1.1 DOES NOT INCLUDE:** Addendum A hedge/opposite-direction model · AI v2 features ·
setup-quality AI · post-trade AI analysis · regime-adaptive AI safeguards · generic three-step
safety-order UI behaviour · random simulated metrics · forced Anti-Greed Harvest · the generic
50/100/200 take-profit template · the fixed 10% UI stop · ATR-band entry visualisation as strategy
truth · automatic next-cycle creation · automatic opposite-direction activation · automatic wallet
deployment from a signal.

**Excluded features require separately versioned future specifications.**

### 9.7 C1 / C2 — RESOLVED (S37, S38 — P1)

**C1 — resolved by EXCLUSION from v1.1, not by changing G30.** Addendum A is not part of v1.1.
M4A may not execute under v1.1. At zero position the cycle terminates; it cannot reverse
direction, cannot open an opposite position, cannot reuse the same authorisation. An
opposite-direction position requires a **new owner-authorised cycle**. A future hedge/reversal
product needing pre-authorised opposite-direction behaviour must be separately ratified with
explicit authorisation scope · separate cycle identity · independent capital baseline ·
independent equity floor · independent risk limits · independent kill-switch checks · **no silent
inheritance from the completed cycle**.

**C2 — resolved by EXCLUSION of automatic signal-driven activation.** Under v1.1 a signal may be
evaluated **only within an already owner-activated cycle**. **"Deployed" cannot mean:** create a
cycle · authorise capital · select a wallet · activate a strategy · switch direction · bypass owner
approval. An already activated and **armed** cycle may advance `ARMED_WAITING_FOR_SETUP →
SETUP_PENDING` on a qualifying signal — **entry evaluation within an existing authorisation, not
activation by signal.**

> *Provenance note.* In 0.15 the assistant identified this reconciliation and explicitly declined
> to record it, on the grounds that it was the assistant's reading rather than the owner's. The
> owner has now ruled it. It is **P1**, not P3 — the assistant withheld it rather than proposing it.

### 9.8 Addendum A status — RECORDED

Addendum A **remains candidate and unratified**. It has **no operational authority**. It is
**excluded from v1.1**. It **cannot** modify cycle behaviour · trigger reversal · deploy or
activate a wallet · activate another cycle. It requires a **separately versioned future
owner-ratified specification**.

---

## 13. Capital sufficiency (S34 — P1) — CLOSES G31

```
required_cycle_equity = equity_floor_amount
                      + operational_reserve
                      + initial_margin
                      + estimated_round_trip_fees
                      + estimated_round_trip_slippage

ACTIVATE ONLY IF:  available_strategy_equity >= required_cycle_equity
```
**Decimal-safe arithmetic. Round conservatively against activation.**

### 13.1 Operational reserve — `required_reserve_pct = 10`
10% of the owner-selected baseline. **$500 baseline → $50.** **Separate from the 20% floor**
($100). Absorbs: fee-rate movement · funding accrual · price movement between validation and
execution · rounding · partial-fill variance · exit-cost variance · minor equity drift.
**Cannot** be used as initial margin · fund a resize · be counted twice · reset downward. **Remains
reserved for the life of the cycle**; cannot be released before terminal state and finalised
accounting. If equity falls into the reserve after entry: **prohibit new resizes**; permit only
monitoring and risk-reducing actions. **Does not replace or weaken the equity floor.**

### 13.2 Initial margin — RESOLVES `notional_constant`
```
margin_fraction = 10 / leverage          (DIMENSIONLESS)   <-- CORRECTED 0.17.1
initial_margin  = capital_baseline × margin_fraction
position_notional = initial_margin × leverage = capital_baseline × 10
```

> **SUPERSEDED — DO NOT IMPLEMENT.** 0.16 and earlier stated `20 / leverage` and
> `capital_baseline × 20`. That is **incorrect** and doubles every position. See 0.17.1 changelog.

| Leverage | fraction | margin ($500) | margin ($300) | notional ($500) | notional ($300) |
|---|---|---|---|---|---|
| 50× | 0.20 | $100 | $60 | $5,000 | $3,000 |
| 100× | 0.10 | $50 | $30 | $5,000 | $3,000 |
| 200× | 0.05 | $25 | $15 | $5,000 | $3,000 |
| 300× | 0.0333… | conservatively rounded | conservatively rounded | $5,000 | $3,000 |
| 400× | 0.025 | $12.50 | $7.50 | $5,000 | $3,000 |
| 500× | 0.02 | $10 | $6 | $5,000 | $3,000 |

> **Venue reality (ApeX `/api/v3/symbols`, retrieved 2026-07-16):** `displayMaxLeverage` is
> **100** on BTC-USDT and ETH-USDT, **50** on SOL/XRP/ARB-USDT. **200×, 300×, 400×, 500× and
> 1000× do not exist on ApeX.** The rows above are formula illustration only.

> **`notional_constant` is NOT a dollar amount and NOT contracts.** It is the **numerator in the
> dimensionless inverse-leverage margin-fraction formula.** Open as `OWNER RULE NOT FOUND` since
> the 2026-07-15 audit. **Rename the field to `inverse_leverage_margin_numerator = 10`** so it
> cannot be misread as a monetary notional. **Value corrected 20 → 10 in 0.17.1.**
>
> **Consequence, recorded explicitly:** initial position notional is **constant at
> `capital_baseline × 10`** — **$5,000** at a $500 baseline, **$3,000** at $300 — **at every
> leverage**. Leverage changes
> only how much margin is committed, never the size. This is the intended mathematical consequence
> of inverse-leverage sizing. **Flag any venue leverage or account limit that makes the calculated
> position unavailable. The most restrictive venue, account, user or strategy limit always wins.**

### 13.3 Slippage — `max_slippage_bps_per_side = 25` (0.25%)
```
estimated_round_trip_slippage = position_notional × 0.0025 × 2   →  max  position_notional × 0.005
```
Estimate **entry** and **protective/full-exit** slippage before entry, using **current order-book
depth when available**.
1. Order-book-estimated entry slippage > 25 bps → **reject the order**.
2. Estimated full-exit slippage > 25 bps → **reject activation or resizing**.
3. Order-book data unavailable, stale or incomplete → **fail closed**.
4. **Never substitute zero slippage.**
5. **Do not** use favourable price improvement to reduce the required reserve before execution.
6. **Recalculate before each resize or executable order.**
7. The activation record stores the activation-time estimate; **execution requires a fresh estimate**.
8. Slippage allowance is **reserved capital, not expected P&L**.
9. **Use the worse** of the live estimate and the configured conservative allowance.

### 13.4 Fees — ceiling `maximum_fee_rate_per_side = 0.10%`
Use the **venue's current authenticated fee schedule**. Required inputs: maker rate · taker rate ·
account-specific fee tier · fee currency · **schedule retrieval timestamp**.
**Assume taker execution on both entry and full protective exit** unless a more conservative
applicable rate can be proven.
```
estimated_round_trip_fees = position_notional × effective_entry_fee_rate
                          + position_notional × effective_exit_fee_rate
```
1. Authenticated fee rate unavailable → **activation fails closed**.
2. Applicable rate > 0.10% per side → **activation fails pending explicit owner approval of a new
   specification version**.
3. **Do not hardcode an exchange's current fee as permanent strategy truth.**
4. **Persist the actual rate and schedule timestamp used for each decision.**
5. **Recalculate before each executable order.** 6. **Record actual fees after fills.**
7. **Funding is NOT an execution fee.** 8. Funding tracked separately, charged against cycle equity
when incurred. 9. **Unknown fee schedules cannot be treated as zero.**

### 13.5 Worked examples — CORRECTED 0.17.1 (K=10)

**$300 baseline, 100× — the owner's actual funding**
| Component | Amount |
|---|---|
| position notional (`$300 × 10`) | **$3,000** |
| equity floor (20%) | $60 |
| operational reserve (10%) | $30 |
| initial margin (`10/100 × $300`) | $30 |
| max round-trip slippage (25 bps/side) | $15 |
| max round-trip fees (10 bps/side ceiling) | $6 |
| **total required cycle equity** | **$141** |
| **available baseline** | **$300** — PASS |

`$60 + $30 + $30 + $15 + $6 = $141`

**$500 baseline, 100× — at the `capital.max_usd` ceiling**
| Component | Amount |
|---|---|
| position notional (`$500 × 10`) | **$5,000** |
| equity floor (20%) | $100 |
| operational reserve (10%) | $50 |
| initial margin (`10/100 × $500`) | $50 |
| max round-trip slippage (25 bps/side) | $25 |
| max round-trip fees (10 bps/side ceiling) | $10 |
| **total required cycle equity** | **$235** |
| **available baseline** | **$500** — PASS |

`$100 + $50 + $50 + $25 + $10 = $235`

> **SUPERSEDED — DO NOT USE.** 0.16 stated a $500/100× example with **$10,000 notional**,
> **$100 initial margin**, **$50 slippage** and a **$300 subtotal**. All K=20-derived. Wrong.

> **Do not claim the cycle passes without retrieving and applying the actual authenticated fee
> rate.**

### 13.5.1 Owner-verified geometry — CORRECTED 0.17.1

Account funded to **exactly** the baseline (required: ApeX is cross-only; see §5/B-7).
Maintenance-margin rates from ApeX `/api/v3/symbols`, retrieved 2026-07-16.

| | $300 baseline | $500 baseline |
|---|---|---|
| position notional | **$3,000** | **$5,000** |
| BTC/ETH liquidation distance (MMR 0.005) | **9.55%** | **9.55%** |
| SOL/XRP/ARB liquidation distance (MMR 0.010) | **9.09%** | **9.09%** |
| equity-floor distance | **8.00%** | **8.00%** |
| worst-symbol window (floor → liquidation) | **1.09%** | **1.09%** |
| minimum viable leverage | **15.9×** | **15.9×** |

Scale-invariant: notional `= baseline × 10` and floor `= baseline × 0.20` both scale, so the
percentages hold at any baseline.

> **SUPERSEDED K=20-DERIVED VALUES — REMOVED. DO NOT USE:**
> ~~$6,000 notional at $300~~ · ~~$10,000 notional at $500~~ · ~~4.52% BTC/ETH liquidation~~ ·
> ~~4.00% floor distance~~ · ~~0.04% alt window~~ · ~~35.7× minimum leverage~~
>
> **The "floor lands exactly on the alt maintenance margin" collision reported in 0.16 NEVER
> EXISTED.** It was purely an artifact of K=20. At K=10 the floor sits at **2.00% of notional**
> against a **1.00%** alt maintenance margin — 1.09% of real room on the worst symbol.

### 13.6 Resize sufficiency
> **"Unbounded resize" means no predefined count ceiling. It does NOT mean unlimited capital.**

Before **every** resize recalculate: current strategy equity · fixed equity floor · fixed
operational reserve · proposed resize margin · estimated resize-entry fee · estimated eventual-exit
fee attributable to the added notional · estimated entry slippage · estimated exit slippage ·
exposure after resize · **liquidation buffer** · all user, venue and strategy limits.

A resize is permitted **only if the post-resize state preserves**: the fixed equity floor · the
fixed operational reserve · required fees · required slippage allowance · margin requirements ·
liquidation safeguards.

**If insufficient, reject that resize. Do not end the cycle solely because a resize is rejected.**

---

## 14. Canonical cycle storage (S35 — P1) — CLOSES G32 at specification level

> **NO TABLE OR MIGRATION IS AUTHORISED. SCHEMA PLAN ONLY. NOTHING CREATED.**
> **`strategy_state` is explicitly rejected as the canonical Accumulator cycle ledger.**

### 14.1 `accumulator_cycles` (planned)
`id` · `cycle_id` · `user_id` · `connection_id` · `strategy_id` · `strategy_slug` ·
`strategy_version` · `strategy_checksum` · `venue` · `environment` · `symbol` ·
`permitted_direction` · `capital_baseline` · `equity_floor_pct` · `equity_floor_amount` ·
`required_reserve_pct` · `required_reserve_amount` · `activation_fee_rate` ·
`activation_slippage_bps` · `applicable_risk_limit_version` · `status` · `activated_at` ·
`activated_by` · `first_entry_filled_at` · `position_closed_at` · `finalized_at` ·
`terminal_reason` · `created_at` · `updated_at`

**Requirements:** `cycle_id` unique and immutable · **one nonterminal cycle per user and
connection** · strategy version and checksum immutable after activation · frozen capital/risk
fields immutable after activation · **RLS enabled** · users read only their own cycles · **client
roles cannot create, mutate or finalise cycles** · server-authorised operations only · **no private
keys, API secrets or signing material** · **no automatic cycle creation from a signal** · **no cycle
ID reuse** · decimal-safe monetary columns.

### 14.2 `accumulator_cycle_events` (planned)
`id` · `cycle_id` · `user_id` · `connection_id` · `event_type` · `prior_status` · `new_status` ·
`reason_code` · `event_payload` · `occurred_at` · `recorded_at` · `actor_type` · `actor_id` or
sanitised system actor · `correlation_id` · `idempotency_key`

**Requirements:** **append-only** · **no UPDATE** · **no DELETE by application roles** · event-type
allowlist · payload size limit · **secret-pattern rejection** · idempotency protection · ordered
index by cycle and occurrence time · user isolation · users read only their own cycles' events ·
**only approved server paths may insert**.

### 14.3 Status model (planned)
**Nonterminal (14):** `ACTIVATION_PENDING` · `ARMED_WAITING_FOR_SETUP` · `SETUP_PENDING` ·
`ENTRY_PENDING` · `POSITION_ACTIVE` · `RESIZE_PENDING` · `REBALANCE_PENDING` · `PARTIAL_EXIT` ·
`EQUITY_FLOOR_HALTED` · `KILL_SWITCH_HALTED` · `DATA_HALTED` · `CLOSE_PENDING` ·
`RECONCILIATION_PENDING` · `FINALIZATION_PENDING`

**Terminal (11):** `TAKE_PROFIT_COMPLETE` · `STRUCTURAL_STOP_EXIT` · `OWNER_MANUAL_CLOSE` ·
`RISK_REDUCTION_CLOSE` · `VENUE_LIQUIDATION` · `EXTERNAL_POSITION_CLOSE_DETECTED` ·
`CANCELLED_BEFORE_ENTRY` · `CONFIGURATION_INVALIDATED_BEFORE_ENTRY` ·
`CONNECTION_REVOKED_BEFORE_ENTRY` · `STRATEGY_VERSION_INVALIDATED_BEFORE_ENTRY` · `FAILED_CLOSED`

**Invalid transitions must be rejected.** The cycle row stores current state; **the events table
preserves every transition.**

### 14.4 Relationships — future migration design
Future signals, orders, fills, positions, risk decisions and journal records **must reference
`cycle_id`**. **Not created in this turn.** The future migration design must determine how existing
`order_intents` · `order_audit` · `strategy_state` · `user_strategy` · `user_trading_limits` ·
`kill_switches` relate to the cycle **without overwriting historical data**.

**Physical implementation: PENDING.**

---

## 10. `strategy_spec_history` — planned (S29 — P1) — **DOES NOT EXIST**

Append-only, immutable. Snapshot **before** any modification.

| Field |
|---|
| `id` |
| `user_strategy_id` |
| `user_id` |
| `connection_id` |
| `strategy_id` |
| `strategy_slug` |
| `previous_params` |
| `previous_spec_version` |
| `previous_checksum` |
| `new_params` |
| `new_spec_version` |
| `new_checksum` |
| `change_reason` |
| `migration_identifier` |
| `changed_at` |
| `changed_by` / `system_actor` |

**The first history record must preserve `previous_params = {}`.**

> **Do not convert `{}` to null, omit it, or describe it only in prose. `{}` is the actual
> prior database state.** *(S29)*

**Append-only.** Normal application roles may not `UPDATE` or `DELETE` history records.

> **Row continuity (S29).** The migration updates the existing row **in place** — primary
> identity, user association, connection association, strategy association and original
> `created_at` lineage all unchanged. The 0.12 open question asked whether "preserve the
> empty row" meant continuity **or** snapshot. **The answer is both.**

---

*Candidate document. Owner intent only. Not a specification. Not in force.*

---

## 15. Complete specification gap sweep (0.16)

**Method:** every field of recovered v1, every ruling of this session, and every verified
repository/database fact, swept once. **No answer invented. No gap filled by inference.**

### 15.1 v1.1 RATIFICATION BLOCKERS — 8

| # | Item | Detail |
|---|---|---|
| **B-1** | **`original_first_entry_target` undefined** *(G33)* | TP rung 3 — *"sell_rest_full_close."* Referenced in v1, **defined nowhere**. Flagged 2026-07-15; never answered. §12.8 makes it structural: rung 3 is what ends a cycle as `TAKE_PROFIT_COMPLETE`. **The cycle's intended natural termination is undefined.** |
| **B-2** | **`junk_filter.volatility_floor.threshold: null`** *(G34)* | `junk_filter.enabled: true`, `metric: atr_5m`, **threshold null**. `junk_filter.py` carries `DEFAULT_ATR_RATIO_FLOOR = 0.0008` — **a code default, NOT an owner rule** (flagged 2026-07-15). An enabled filter with a null threshold either blocks everything or nothing. |
| **B-3** | **Leverage has no home** *(G35)* | `margin_fraction = 10/leverage` *(corrected 0.17.1)* and activation requirement 21 both need leverage. It is **absent from §12.4's 18 frozen values**, **absent from the 24 activation requirements**, and **absent from `accumulator_cycles`**. Today it lives in `profiles.current_leverage_tier` — **per-user June scaffolding**, not per-cycle. A frozen cycle cannot compute its own margin. |
| **B-4** | **`rebalance: sell_second_tranche_at_break_even` underspecified** *(G36)* | Which tranche is "second" — second resize, or second entry overall? Break-even of **what** — the re-anchored average, or that tranche's own cost? `safeguards.rebalance_fill_required: true` and `stop.active_after: first_rebalance` both **depend on this event**, so the stop's arming condition inherits the ambiguity. |
| **B-5** | **`stop.level_mode: a_trailing` undefined** *(G37)* | The token `a_trailing` is defined nowhere. `level: most_recent_resize_or_retest_level` — a **retest level** is now a swing level (G25), but a **resize level** is a fill price. Whether the stop trails structure, fills, or the max of both is unstated. |
| **B-6** | **`stale_feed_halt: true` has no threshold** *(G38)* | v1 asserts the safeguard; **no staleness bound exists**. G31.3/13.4 and activation requirements 14–15 all turn on "current"/"stale" without defining either. The worker's 30s kill-switch staleness is a **guard-read** bound, not a market-data bound, and must not be borrowed. |
| **B-7** | **`user_strategy.cross_margin = false` contradicts v1 `margin_mode: cross`** | **Verified in the live database.** S30 step 12 sets `params`; it does **not** address this column. Post-migration the row would assert `cross` in `params` and `false` in the column. |
| **B-8** | **`active_bot_config` reads `params->>'symbol'`; v1 stores `symbols`** | `COALESCE(us.params ->> 'symbol', 'BTC-USDT')`. **Verified.** Populating `params` with a `symbols` array leaves the view emitting **`BTC-USDT`** as if chosen. The checksum would verify a correct `params` while the only consumer view reads a silent default. |

### 15.2 CLOSED

| Item | Provenance |
|---|---|
| `market: futures` | v1 · DB corrected by migration `20260716062240_b34f9039` |
| `symbols` (5-asset universe) | v1 *(consumer defect B-8 separate)* |
| `one_position_at_a_time`, `capital.max_usd: 500` | v1 |
| `capital.variable: true` | Resolved §12.5 — variable **between** cycles |
| `sizing.model: inverse_leverage`, `sizing.cap` | v1 |
| **`notional_constant`** | **S34 — dimensionless numerator. VALUE = 10** *(corrected 0.17.1 from 20; owner-confirmed P1)*. Open since 2026-07-15 |
| Entry: swing point, break, subject, lookback, persistence | S19, S20 — G22 |
| Entry: structure breaks, EMA(15) confirms | S21 — G24 |
| Entry: retest | S25 — G25 |
| Frozen retest zone | S26 — G26 |
| BOS/CHoCH taxonomy | S24 — G23 dissolved |
| 1H trend timeframe / method | S14, S16 — G14, G18 *(P3 origin)* |
| `equity_floor_pct: 20` | S32 — G29 |
| Cycle lifecycle | S33 — G30 |
| Capital sufficiency, reserve, slippage, fees | S34 — G31 |
| Cycle storage (specification level) | S35 — G32 |
| v1.1 scope | S36 — §9.6 |
| C1, C2 | S37, S38 — by exclusion |
| Canonicalisation (JCS + SHA-256) | S27 — G27 |
| Version preservation | S28 — G28 |
| Empty-row preservation | S29 |
| Atomic migration procedure | S30 |
| Authority rule | S31 |
| `max_slippage_guard` | S34 — 25 bps/side |
| `equity_floor_required_before_live` | S32 |
| `kill_switch_checked_each_cycle` | v1 — **implemented and verified** in `bot_worker.py` |
| `junk_filter.level_quality.min_score: null` | **Moot** — `enabled_flag: false` |
| `ai_layers_v2` (4) | **FUTURE VERSION** — excluded §9.6 |

### 15.3 DERIVABLE — no owner decision needed

| Item | Derivation |
|---|---|
| Position notional | `capital_baseline × 10` = **$5,000** at $500, **$3,000** at $300, every leverage *(S34, corrected 0.17.1)*|
| Minimum viable leverage | **≈15.9×** *(corrected 0.17.1; was wrongly 35.7× under K=20)*. At $500: `margin ≤ 500 − (100+50+10+25) = 315`; `5000/L ≤ 315 → L ≥ 15.9`. Scale-invariant. **Both usable ApeX rungs (50× and 100×) pass comfortably.** Arithmetic, not a rule |
| Effective resize depth | Unbounded in rule; bounded in practice by floor + reserve *(§12.12)* |
| Round-trip slippage at max | `$5,000 × 0.005 = $25` at $500; `$3,000 × 0.005 = $15` at $300 *(corrected 0.17.1)* |
| Round-trip fees at ceiling | `$5,000 × 0.001 × 2 = $10` at $500; `$3,000 × 0.001 × 2 = $6` at $300 *(corrected 0.17.1)* |

### 15.4 IMPLEMENTATION DETAIL — not owner decisions

Decimal library choice · conservative-rounding mechanics · order-book depth-walk algorithm ·
`cycle_id` generation · state-machine transition enforcement · idempotency-key construction ·
event allowlist and payload limits · secret-pattern rejection · RLS policy text · index
strategy · worker restart/cycle-state recovery · reconciliation loop · partial-fill accounting ·
`duplicate_submit_protection` mechanism (`idempotency_key` planned) · `EQUITY_FLOOR_HALT` reason-code
wiring · journal finalisation format.

### 15.5 OWNER DECISION REQUIRED — non-blocking for v1.1

| Item | Class |
|---|---|
| `permitted_direction` valid values — long-only, short-only, or both per cycle? | BLOCKS PAPER |
| `G28` — v1 doc disposition | *Resolved by S28: supersede. Retained for the record* |
| `hedge_guard` column purpose *(G12)* | FUTURE VERSION — Addendum A excluded |
| June UI removal/rename — 3-step, ATR bands, 50/100/200, 10% stop, Anti-Greed Harvest, `Math.random()` metrics, `LEVERAGE_TIERS`, `WALLET_CAP`, "Advance cycle step" | BLOCKS PAPER — non-authoritative per §9.6/§12.12; **still in the repo** |
| `profiles.strategy_mode` / `active_wallet_usd` / `current_leverage_tier` per-user *(B2)* | BLOCKS PAPER — superseded by `accumulator_cycles` but **not yet removed** |
| `user_trading_limits` — 0 rows; `DAILY_LOSS_LIMIT` reason code exists for a limit never set | BLOCKS LIVE ONLY |
| ApeX `permissions_verified: false`, `status: pending_verification`, `environment: test` | BLOCKS LIVE ONLY |
| Addendum A — G4, G5, G7–G11, G13, G15–G17, G20, G21 | FUTURE VERSION — excluded §9.6 |

### 15.6 CONTRADICTIONS

| ID | Status |
|---|---|
| **C1** — G30 vs Addendum A M4A | **RESOLVED** by exclusion *(S37)* |
| **C2** — G30 vs Addendum A M4B | **RESOLVED** by exclusion *(S38)* |
| **C3** — `cross_margin = false` vs `margin_mode: cross` | **OPEN** — B-7 |
| **C4** — `active_bot_config.symbol` vs `symbols` | **OPEN** — B-8 |
| **C5** — June UI vs every ratified rule | **OPEN** — non-authoritative but present |

### 15.7 Verdict

> **THE SPECIFICATION IS NOT COMPLETE. EIGHT v1.1 RATIFICATION BLOCKERS REMAIN (B-1 … B-8).**
>
> Five are **owner decisions** (B-1 … B-5, B-6). Two are **verified data/schema contradictions**
> (B-7, B-8) requiring an owner-authorised fix. **The A1 migration must not run** until all are
> resolved: S30 step 14 sets `ratified = true`, and S27's activation blockers forbid activation
> when any required field is absent or invalid. **Ratifying now would checksum a specification
> containing six null or undefined required fields — conferring cryptographic authority on a
> document known to be incomplete.**

---

---

## 17. Post-ruling consistency audit (0.17)

**16 cross-checks run. 14 pass. 2 fail. Four new items surfaced by the audit itself.**

### 17.1 Cross-check results

| # | Check | Result |
|---|---|---|
| 1 | Frozen cycle leverage drives inverse-margin sizing | **PASS** — S41 freezes it; S34 consumes it |
| 2 | Frozen leverage drives original-first-entry target | **PASS** — S39 uses `frozen_cycle_leverage` |
| 3 | Original target fixed from initial-entry VWAP | **PASS** — explicitly *not* the re-anchored average |
| 4 | TP3 cannot precede TP1/TP2 | **PASS — and arithmetically guaranteed.** No resize: TP1 `vwap×(1+2/L)` < TP2 `×(1+3/L)` < TP3 `×(1+4/L)`. After a downward re-anchor, `current_avg < original_vwap` and `(1+3/L) < (1+4/L)`, so TP2 < TP3 **always**. Ordering is monotonic under every resize path. The explicit terminal-fill gate is belt-and-braces |
| 5 | Active resize tranche distinct from core | **PASS** — S42 |
| 6 | Only one tranche awaits rebalance | **PASS** — and **consistent with v1's own gate** (*prior rebalance filled*). Not a new constraint |
| 7 | First completed rebalance arms the stop | **PASS** — S42 and S43 agree; partial fill does not arm |
| 8 | Stop references swing structure, not fill price | **PASS** — S43 resolves the old B-5 ambiguity in favour of structure |
| 9 | Stop ratchets only favourably | **PASS** — a resize cannot loosen an armed stop |
| 10 | Fixed zones use breaking/confirming-candle ATR and do not breathe | **FAIL — see B-12.** G26 froze the *retest* zone at the **breaking candle's** ATR. S43's **stop** zone belongs to a swing that forms *later*. **Which candle's ATR freezes the stop zone is unstated** |
| 11 | Stale feeds fail closed | **PASS** — S44, seven data classes |
| 12 | Cross margin consistent between params and column | **PASS at specification level** — S45. **Physically still inconsistent**; migration-pending |
| 13 | Allowed-symbol array distinct from cycle symbol | **PASS** — S46 |
| 14 | No silent BTC-USDT default in the intended contract | **PASS at specification level** — S46. **The live view still contains it**; correction pending |
| 15 | Every monetary calculation decimal-safe | **PASS** — S34, S39, S40 |
| 16 | No UI scaffolding becomes strategy authority | **FAIL in fact, PASS in rule.** §9.6/§12.12/S41 all exclude it; **the code is still in the repo** and `profiles.current_leverage_tier` is still the only leverage store that exists |

### 17.2 New items surfaced by the audit

| ID | Item | Class |
|---|---|---|
| **B-9** | **The structural stop can never arm.** v1's resize gate requires *prior rebalance filled*; S42 forbids stacking while a tranche is unrebalanced; S43 keeps the stop **dormant until the first rebalance is completely filled and reconciled**. In a sustained adverse move the first resize tranche **never reaches its break-even**, so: no further resizes (gate + floor), **no stop — ever**, no TP (price moving away). The equity floor prohibits *new* risk but S32 rule 6 and §12.9 explicitly say **do not force-close solely because the floor was reached**. **The remaining exits are venue liquidation or a manual owner close.** This is not a null field — it is an **emergent consequence of four separately-correct ratified rules**. | **OWNER DECISION REQUIRED · BLOCKS TESTNET · BLOCKS LIVE** |
| **B-10** | **Take-profit tranche attribution.** S39: TP1 sells *"half of current position."* S42: the core is *"adjusted only by authorized take profits or risk-reducing exits"* and the tranche's reduce-only exit covers *"that active resize tranche's remaining quantity."* **Whether a TP draws from the core, the active resize tranche, or pro-rata is unstated.** Normally moot — by +200% margin return the tranche's break-even would have been crossed and rebalanced — but **a gap through both levels leaves it live**. | **OWNER DECISION REQUIRED · BLOCKS PAPER** |
| **B-11** | **Average entry after rebalance.** `reanchor_average: true` re-anchors on resize fills. **Whether closing the active tranche re-anchors the average back up to the core's VWAP is unstated.** It directly moves TP1/TP2 thresholds, which are measured from *current average entry*. Standard accounting says yes; the spec does not say. | **OWNER DECISION REQUIRED · BLOCKS PAPER** |
| **B-12** | **Stop-zone ATR freeze reference.** S43 says use *"the already-ratified swing definition and frozen ATR-zone procedure."* G26's procedure freezes at the **breaking candle's** close. A stop swing has **no breaking candle** — it forms after an entry or resize. **Which candle's ATR(14) fixes its zone edges — the pivot candle, the confirming (2nd-right) candle, or the entry/resize event candle — is unstated.** The lower zone edge **is** the trigger boundary, so this is not cosmetic. | **OWNER DECISION REQUIRED · BLOCKS PAPER** |

### 17.3 Consolidated final gap table

| Domain | Status |
|---|---|
| Strategy identity / version | **CLOSED** — slug `dca`, v1.1, JCS+SHA-256 governance *(S27, S36)* |
| Direction | **OWNER DECISION** — `permitted_direction` valid values unstated *(BLOCKS PAPER)* |
| Symbols | **CLOSED** spec-level *(S46)* · **CONTRADICTION** live view *(B-8, pending)* |
| Leverage | **CLOSED** *(S41)* · UI store still per-user *(BLOCKS PAPER)* |
| Margin mode | **CLOSED** spec-level *(S45)* · **CONTRADICTION** live column *(B-7, pending)* |
| Capital baseline | **CLOSED** *(S33, §12.5)* |
| Equity floor | **CLOSED** *(S32)* — 20%, $100 at $500 |
| Operational reserve | **CLOSED** *(S34)* — 10%, $50 at $500 |
| Fees | **CLOSED** *(S34)* — authenticated taker both sides, 0.10%/side ceiling |
| Funding | **CLOSED** *(S34)* — not a fee; tracked separately; staleness *(S44)* |
| Slippage | **CLOSED** *(S34)* — 25 bps/side, worse-of rule |
| Market-data freshness | **CLOSED** *(S44)* — seven classes |
| Swing detection | **CLOSED** *(S19, S22)* |
| Break | **CLOSED** *(S20, S21)* |
| Retest | **CLOSED** *(S25)* · zone frozen *(S26)* |
| Entry | **CLOSED** — structure breaks, EMA(15) confirms |
| Initial sizing | **CLOSED** *(S34, corrected 0.17.1)* — `10/leverage` dimensionless; notional constant `baseline × 10` |
| Resize eligibility | **CLOSED** — v1 gate + S42 serialisation + floor/reserve/liquidation *(S34 §13.6)* |
| Resize sizing | **DERIVABLE** — same inverse-leverage formula on the frozen baseline |
| Resize tranche identity | **CLOSED** *(S42)* |
| Break-even calculation | **CLOSED** *(S42)* — individual all-in |
| Rebalance | **CLOSED** *(S42)* — reduce-only, filled + reconciled |
| Stop arming | **CLOSED** *(S43)* · **B-9 consequence OPEN** |
| Stop trailing | **CLOSED** *(S43)* · **B-12 zone-ATR reference OPEN** |
| Take-profit ordering | **CLOSED** *(S39)* · **B-10 attribution OPEN** |
| Original target | **CLOSED** *(S39)* — 400%, frozen from first-entry VWAP |
| Average re-anchoring | **B-11 OPEN** |
| Partial fills | **CLOSED** for arming *(S43)* · **IMPLEMENTATION DETAIL** for accounting |
| Order types | **DERIVABLE / IMPLEMENTATION** — reduce-only mandated for rebalance and stop exit |
| Order expiration | **OWNER DECISION** — 6-candle retest window is a *setup* expiry; **order TIF unstated** *(BLOCKS PAPER)* |
| Liquidation buffer | **OWNER DECISION** — required by §13.6; **no value or formula** *(BLOCKS TESTNET)* |
| One-position enforcement | **CLOSED** — v1 + §12.3 req 1–3 |
| Cycle lifecycle | **CLOSED** *(S33)* |
| Cycle storage | **CLOSED** spec-level *(S35)* · **IMPLEMENTATION PENDING** |
| Kill switch | **CLOSED** *(§12.9)* — verified implemented in `bot_worker.py` |
| Restart / reconciliation | **IMPLEMENTATION DETAIL** |
| Duplicate protection | **CLOSED** as rule · **IMPLEMENTATION DETAIL** (`idempotency_key` planned) |
| Migration | **CLOSED** *(S23, S30)* — **UNEXECUTED** |
| History | **CLOSED** *(S29, S35)* — `strategy_spec_history` **does not exist** |
| Canonicalisation | **CLOSED** *(S27)* — **no checksum generated** |
| UI contradictions | **CONTRADICTION — OPEN.** All June scaffolding still present *(BLOCKS PAPER)* |
| Testnet boundary | **BLOCKED** — B-9, B-12, liquidation buffer |
| Live boundary | **BLOCKED** — all of the above + `user_trading_limits` 0 rows + `permissions_verified: false` |
| Addendum A | **FUTURE VERSION** — excluded *(S36, S37, S38)* |

### 17.4 Verdict

> **B-1 … B-8 are closed. Zero required v1.1 fields remain null or undefined.**
>
> **No v1.1 ratification blocker remains.** The specification is **ready for artifact and
> migration preparation** — with the qualifications below, which do **not** block ratification
> because none is an absent or invalid required field.
>
> **BUT: B-9 must be an owner decision before testnet.** It is not a hole in the specification —
> it is what the specification *says*. Four correct rules compose into a path with no stop.
> Ratifying and checksumming v1.1 does not make B-9 safe; it makes it **cryptographically
> authoritative**.


---

## 18. Complete close-out register (0.17)

Everything outstanding, in one place. **Nothing omitted. Nothing invented.**

### 18.0 DURABILITY — read first

**The repository holds revision 0.9. This document is at 0.17.**
**S13 … S46 — thirty-four owner rulings, including every blocker closure — exist only in the
assistant's working container and in this file.** If this session ends without a push or a
download, they are lost. That is precisely the failure that left `params` empty for a month and
cost two full audits to reconstruct. **This is the highest-priority item in this register and it
is not a strategy decision.**

### 18.1 OWNER DECISIONS — 8

| # | Item | Gate |
|---|---|---|
| **1** | **B-9 — the unarmed-stop drawdown path.** Not a gap; a composition of four ratified rules. Accept as intended, or add a rule. | **TESTNET · LIVE** |
| **2** | **Liquidation buffer.** Required by §13.6's resize check. **No value, no formula.** | **TESTNET** |
| **3** | **B-12 — stop-zone ATR freeze reference.** Pivot candle, confirming (2nd-right) candle, or the entry/resize event candle? The lower edge **is** the trigger. | **PAPER** |
| **4** | **B-10 — take-profit tranche attribution.** Core, active resize tranche, or pro-rata? | **PAPER** |
| **5** | **B-11 — average re-anchoring after rebalance.** Does closing the tranche return the average to core VWAP? Moves TP1/TP2. | **PAPER** |
| **6** | **`permitted_direction` valid values.** Long-only, short-only, or both per cycle? §12.3 req 12 validates it; the domain is unstated. | **PAPER** |
| **7** | **Order time-in-force / expiration.** The 6-candle retest window is a *setup* expiry. **Order TIF is unstated.** | **PAPER** |
| **8** | **`available_strategy_equity` vs `capital_baseline`.** §13's activation test compares them; whether they are identical at activation is unstated. | **PAPER** |

### 18.2 PHYSICAL DEFECTS — ruled, unapplied — 3

| Defect | Live value | Ruling | Status |
|---|---|---|---|
| `user_strategy.params` | `{}` | S23/S30 — populate in A1 | **migration-pending** |
| `user_strategy.cross_margin` | **`false`** | S45 — set `true`, verify both sides, roll back on disagreement | **migration-pending** |
| `active_bot_config.symbol` | **`BTC-USDT`** *(silent COALESCE default)* | S46 — remove fallback; typed `allowed_symbols` + `active_cycle_symbol` | **contract-pending** |

### 18.3 ARTIFACTS TO AUTHOR — 3

1. `docs/strategy-specs/dca/v1.1.json` — canonical JSON. **Does not exist.**
2. **Checksum** — JCS (RFC 8785) → UTF-8 → SHA-256 → lowercase hex. **Not generated.**
3. `docs/STRATEGY_SPEC_v1.1.md` — must identify v1 as predecessor · list every clarification and
   amendment · **distinguish recovered v1 rules from owner-ratified v1.1 additions** · reference
   the JSON artifact · state the verification procedure · **include the checksum only after it is
   actually generated** · **never use a placeholder hash as if verified**.
4. `docs/STRATEGY_SPEC_v1.md` — **additive historical notice only.** Body untouched.

### 18.4 SCHEMA TO CREATE — 3 tables

`strategy_spec_history` *(S29)* · `accumulator_cycles` *(S35/§14.1, + `leverage` per S41)* ·
`accumulator_cycle_events` *(S35/§14.2)*. **None exists.** Plus §14.4: how `order_intents`,
`order_audit`, `strategy_state`, `user_strategy`, `user_trading_limits`, `kill_switches` relate to
`cycle_id` **without overwriting historical data**.

### 18.5 MIGRATION — 1

The A1 atomic migration: **23 steps** *(§9.4)* + **12 cross-margin steps** *(S45)*. Prohibited:
broad `UPDATE`; populating other users' DCA configs without a separate product-level decision.
**Unexecuted.**

### 18.6 ENGINE — Stages 1–3

**Does not exist.** Order transmission was removed at Stage 0.5 and is **test-enforced out** of the
worker source (`test_no_execution_broker_reference_in_worker_source`). Everything in §16 — swing
detection, break, retest, sizing, resize, tranche accounting, rebalance, stop, TP ladder,
sufficiency, staleness — is **specified and unbuilt**.

### 18.7 UI REMEDIATION — non-authoritative, still present

3-step cycle · "Advance cycle step" · ATR-band visualisation · 50/100/200 ladder · fixed 10% stop ·
`LEVERAGE_TIERS` (500× = 2.5% vs `LEVERAGE_RISK_MAP` 2%) · `WALLET_CAP` · Anti-Greed Harvest ·
`Math.random()` metrics · `capital-rules.ts` `floorUsd: 100` · `profiles.strategy_mode` /
`active_wallet_usd` / `current_leverage_tier` *(per-user; superseded by `accumulator_cycles`)* ·
`StrategyConfigModal` never writing `params`.

### 18.8 LIVE-ONLY GATES

`user_trading_limits` **0 rows** — no `max_total_exposure_usd`, `daily_loss_limit_usd`,
`max_order_size_usd`; the guard carries a `DAILY_LOSS_LIMIT` reason code for a limit never set ·
`EQUITY_FLOOR_HALT` and `DATA_HALTED` reason codes have no implementation · ApeX
`permissions_verified: false`, `status: pending_verification`, `environment: test` · venue cross-margin
support unverified *(S45 step 11)* · authenticated fee schedule never retrieved.

### 18.9 FUTURE VERSIONS — excluded from v1.1

**Addendum A** (M4 branch, hedge, reversal exit) — and with it **S8–S11, S13, S14, S16, S24's
defensive-branch reading, G4, G5, G7–G13, G15–G17, G20, G21**.

> **Consequence worth stating plainly: the 1H trend check is NOT in v1.1.** S14 (1H) and S16 (1H
> EMA + candle, grade P3) exist **only** to branch M4A/M4B, which §9.6 excludes. **v1.1 is 5m end
> to end.** The 5m `EMA(15)` entry confirmation *(S21)* is v1's own and **is** in v1.1 — a
> different rule from the 1H EMA.

**AI v2** (4 layers) · `hedge_guard` column *(G12 — unused, unread, unwritten)* · Addendum A's B1
(wallet vs connection) and B2 (per-wallet state).

### 18.10 OBSERVABILITY

`worker_ingest_nonces` records no request type → deploy items **7 and 8** (`ACTIVE_CONFIG_READ`,
`EXECUTION_GUARD_READ`) remain unverifiable from data already collected.

### 18.11 Ordering

**Ratification blockers: zero.** v1.1 can be authored and checksummed today.

**But B-9 should be decided first.** Ratifying does not make B-9 safe — it makes it
cryptographically authoritative.

