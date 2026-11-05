"""Scout Guardian v2 — deterministic, position-aware Position Monitoring Layer.

Owner-ratified clean rewrite. Supersedes v1's reflex rules. The directive
contract (`scout_guardian_directives` types + reason_codes + engine enforcement
path) is UNCHANGED — v2 is a new brain behind the same mouth.

DESIGN
------
Every verdict is a function of the position's full context:
  * strategy leg (accumulator / vanguard / sniper / hunter / arbiter-pair)
  * age in completed 5m candles
  * promoted (HTF-runner) flag
  * pair_id (arbiter pair member)
  * pending rungs, deepest filled rung, unrealized PnL vs. entry
Rules read the defendant's file before ruling.

GATE PIPELINE (evaluated in order; every gate outcome captured in evidence):
  1. pair_id set                → HOLD "arbiter_pair_delegated"
  2. no market data             → HOLD "no_market_data"   (worker owns stale
                                    counter and emits data_stale alarm)
  3. promoted (runner)          → HOLD "runner_5m_skipped" — 5m rules are
                                    engine-side runner exits only.
  4. rung-cancel (vol-scaled)   → may emit CANCEL_UNFILLED_RUNGS. Allowed
                                    during grace; independent of BOS.
  5. grace_candles gate         → age < grace → closes suppressed.
  6. strategy-specific rule     → BOS/breach evaluated with the FRESH and
                                    SIGNIFICANT gates:
                                       - FRESH:      break_ts > opened_at_ms
                                       - SIGNIFICANT delegated to shared
                                         bos_significance via
                                         accumulator_signal.detect_break
                                    Sniper is exempt from adverse-BOS closes
                                    (counter-trend by design) and uses its
                                    own entry-swing breach + fallback max
                                    adverse rule.
  7. otherwise                  → HOLD "none"

Cluster rule (portfolio-level):
  * Same-direction underwater grouping, vol-scaled per-symbol threshold =
    max(cluster_floor_pct, cluster_drawdown_atr_mult × atr_pct).
  * Promoted runners: drawdown measured from runner_breakeven_stop, capping
    the value near 0 so runners never drag a cluster over threshold.

PURE MODULE — no I/O, no DB, no LLM, no orders, no signer touch. All
thresholds live in shared/mainnet_parity_constants.json under `guardian_v2`
and `bos_significance`.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Optional, Sequence

import accumulator_signal
from shared.parity_constants import get as _pc_get

# ─── constants ───────────────────────────────────────────────────────────────
GRACE_CANDLES = int(_pc_get("guardian_v2", "grace_candles"))
STALE_DATA_CYCLES = int(_pc_get("guardian_v2", "stale_data_cycles"))
RUNG_CANCEL_ATR_MULT = float(_pc_get("guardian_v2", "rung_cancel_atr_mult"))
RUNG_CANCEL_FLOOR_PCT = float(_pc_get("guardian_v2", "rung_cancel_floor_pct"))
CLUSTER_DRAWDOWN_ATR_MULT = float(_pc_get("guardian_v2", "cluster_drawdown_atr_mult"))
CLUSTER_FLOOR_PCT = float(_pc_get("guardian_v2", "cluster_floor_pct"))
CLUSTER_MIN_POSITIONS = int(_pc_get("guardian_v2", "cluster_min_positions"))
SNIPER_MAX_ADVERSE_PCT = float(_pc_get("guardian_v2", "sniper_max_adverse_pct"))
GUARDIAN_RULES_VERSION = int(_pc_get("guardian_v2", "rules_version"))

# Shared BOS-significance floor (consumed via accumulator_signal.detect_break;
# also referenced in evidence for auditability).
BOS_MIN_DISPLACEMENT_ATR = float(_pc_get("bos_significance", "min_displacement_atr"))

CANDLE_MS = 5 * 60 * 1000  # 5m — the guardian's supervising timeframe

# Directive types (must match the scout_guardian_directives CHECK + the engine).
DIRECTIVE_CANCEL_UNFILLED_RUNGS = "cancel_unfilled_rungs"
DIRECTIVE_CLOSE_POSITION = "close_position"

# Reason codes emitted by v2. `scout_guardian_bos` is the ONE structural
# force-close code (adverse BOS on trend legs, entry-swing breach on sniper);
# `scout_guardian_cluster` is the correlated-cluster code; the ladder cancel
# uses `scout_guardian_ladder_underwater` (no close, cancel-only).
REASON_ADVERSE_BOS = "scout_guardian_bos"
REASON_CLUSTER = "scout_guardian_cluster"
REASON_LADDER_UNDERWATER = "scout_guardian_ladder_underwater"
REASON_SNIPER_INVALIDATED = "scout_guardian_bos"  # collapses onto the CHECK-allowed code
REASON_DATA_STALE = "data_stale"


# ─── value objects ───────────────────────────────────────────────────────────
@dataclass(frozen=True)
class Directive:
    position_id: str
    directive_type: str
    reason_code: str
    symbol: str
    wallet_key: Optional[str]
    evidence: dict


@dataclass(frozen=True)
class Verdict:
    """One position's per-cycle result. `decision` is an onyx_decisions verdict
    (open|add|close|hold|reject); Guardian only ever emits close or hold."""
    position_id: str
    symbol: str
    side: str  # long | short | flat
    decision: str
    reason_code: Optional[str]
    directives: list = field(default_factory=list)
    evidence: dict = field(default_factory=dict)


@dataclass(frozen=True)
class PortfolioResult:
    verdicts: list  # list[Verdict]
    cluster_directives: list  # list[Directive]


# ─── pure numeric helpers ────────────────────────────────────────────────────
def _num(v, default: float = 0.0) -> float:
    try:
        f = float(v)
    except (TypeError, ValueError):
        return default
    return f if f == f else default  # reject NaN


def _rungs(pos: dict, key: str) -> list[dict]:
    v = pos.get(key)
    return [r for r in v if isinstance(r, dict)] if isinstance(v, list) else []


def position_side(pos: dict) -> str:
    d = str(pos.get("direction") or "").lower()
    return d if d in ("long", "short") else "flat"


def avg_entry(pos: dict) -> float:
    """VWAP of filled lots; falls back to the row's entry_price aggregate."""
    fills = _rungs(pos, "fills")
    tot_qty = sum(_num(r.get("qty")) for r in fills)
    if tot_qty > 0:
        tot_notional = sum(_num(r.get("price")) * _num(r.get("qty")) for r in fills)
        return tot_notional / tot_qty
    return _num(pos.get("entry_price"))


def deepest_filled_price(pos: dict) -> Optional[float]:
    """Long: lowest filled rung price. Short: highest. None if no fills."""
    fills = _rungs(pos, "fills")
    prices = [_num(r.get("price")) for r in fills if _num(r.get("price")) > 0]
    if not prices:
        px = _num(pos.get("entry_price"))
        return px if px > 0 else None
    return min(prices) if position_side(pos) == "long" else max(prices)


def pending_rung_count(pos: dict) -> int:
    p = _rungs(pos, "pending_rungs")
    if p:
        return len(p)
    return len(_rungs(pos, "resize_levels"))


def adverse_drawdown_frac(pos: dict, mark: float) -> float:
    """Positive => position is underwater. Long: (entry - mark) / entry."""
    entry = avg_entry(pos)
    if not (entry > 0) or not (mark > 0):
        return 0.0
    if position_side(pos) == "long":
        return (entry - mark) / entry
    return (mark - entry) / entry


def adverse_direction(side: str) -> Optional[str]:
    """The break direction that is ADVERSE to holding `side`.

    A long is hurt by a bearish break (accumulator_signal expresses that as
    direction='short'). Mirror for short.
    """
    if side == "long":
        return "short"
    if side == "short":
        return "long"
    return None


def _atr_pct(candles: Sequence[Sequence[float]], mark: float) -> float:
    """Latest ATR as a fraction of `mark`. 0.0 when undefined (no vol scaling
    kicks in and floors take over)."""
    if mark <= 0 or not candles:
        return 0.0
    series = accumulator_signal.wilder_atr_series(candles)
    if not series:
        return 0.0
    atr = series[-1]
    if atr is None or atr <= 0:
        return 0.0
    return atr / mark


# ─── position context ────────────────────────────────────────────────────────
@dataclass(frozen=True)
class Context:
    pos_id: str
    symbol: str
    wallet_key: Optional[str]
    side: str
    strategy: str
    opened_at_ms: int
    age_candles: int
    promoted: bool
    pair_id: Optional[str]
    mark: float
    tick: float
    candles: Sequence[Sequence[float]]
    atr_pct: float
    avg_entry: float
    deepest_filled: Optional[float]
    pending: int
    runner_breakeven_stop: Optional[float]


def build_context(pos: dict, market: dict, now_ms: int) -> Context:
    candles = market.get("candles") or []
    mark = _num(market.get("mark"))
    tick = _num(market.get("tick"))
    opened_at_ms = int(_num(pos.get("entry_candle_ts_ms")))
    age_candles = max(0, (now_ms - opened_at_ms) // CANDLE_MS) if opened_at_ms > 0 else 0
    strategy = str(pos.get("strategy") or "").lower()
    promoted = bool(pos.get("promoted"))
    pair_id_raw = pos.get("pair_id")
    pair_id = str(pair_id_raw) if isinstance(pair_id_raw, str) and pair_id_raw else None
    rbe = pos.get("runner_breakeven_stop")
    runner_be = float(rbe) if isinstance(rbe, (int, float)) and rbe else None
    return Context(
        pos_id=str(pos.get("id") or ""),
        symbol=str(pos.get("symbol") or ""),
        wallet_key=pos.get("wallet_key") if isinstance(pos.get("wallet_key"), str) else None,
        side=position_side(pos),
        strategy=strategy,
        opened_at_ms=opened_at_ms,
        age_candles=int(age_candles),
        promoted=promoted,
        pair_id=pair_id,
        mark=mark,
        tick=tick,
        candles=candles,
        atr_pct=_atr_pct(candles, mark),
        avg_entry=avg_entry(pos),
        deepest_filled=deepest_filled_price(pos),
        pending=pending_rung_count(pos),
        runner_breakeven_stop=runner_be,
    )


# ─── BOS detection with FRESH + SIGNIFICANT gates ────────────────────────────
def _detect_adverse_bos_fresh_significant(ctx: Context) -> tuple[Optional[dict], dict]:
    """Returns (evidence_or_None, gate_log).

    Uses accumulator_signal.detect_break (which itself enforces the shared
    BOS-significance filter — no re-implementation here). Adds the FRESH gate
    on top: break_ts > opened_at_ms.
    """
    gates: dict = {"fresh": None, "significant": None, "detected": False}
    adv = adverse_direction(ctx.side)
    if adv is None or not ctx.candles or ctx.tick <= 0:
        return None, gates
    try:
        be = accumulator_signal.detect_break(ctx.candles, adv, ctx.tick)
    except Exception:
        return None, gates
    if be is None:
        # No break at all (could be sub-significance OR no structure). We
        # cannot tell them apart from here without duplicating the primitive,
        # so we log 'detected: false'. The paper engine emits a distinct
        # SCOUT_BOS_REJECTED event when it sees a sub-significance poke.
        return None, gates
    gates["detected"] = True
    break_ts = int(be.break_ts)
    fresh = break_ts > ctx.opened_at_ms
    gates["fresh"] = fresh
    gates["significant"] = True  # detect_break already applied the floor
    gates["break_ts"] = break_ts
    gates["opened_at_ms"] = ctx.opened_at_ms
    if not fresh:
        return None, gates
    return {
        "adverse_direction": adv,
        "broken_level": round(float(be.swing.level), 10),
        "break_close": round(float(be.break_close), 10),
        "ema_at_break": round(float(be.ema_at_break), 10),
        "break_ts": break_ts,
        "min_displacement_atr": BOS_MIN_DISPLACEMENT_ATR,
    }, gates


# Public helper kept for backwards-compat with older callers/tests. Delegates
# to the primitive with no fresh gate applied.
def detect_adverse_bos(
    candles: Sequence[Sequence[float]],
    tick: float,
    side: str,
) -> Optional[dict]:
    adv = adverse_direction(side)
    if adv is None or not candles:
        return None
    try:
        be = accumulator_signal.detect_break(candles, adv, tick)
    except Exception:
        return None
    if be is None:
        return None
    return {
        "adverse_direction": adv,
        "broken_level": round(float(be.swing.level), 10),
        "break_close": round(float(be.break_close), 10),
        "ema_at_break": round(float(be.ema_at_break), 10),
        "break_ts": int(be.break_ts),
    }


# ─── strategy-specific rules ─────────────────────────────────────────────────
_TREND_LEGS = {"accumulator", "vanguard", "hunter"}


def _sniper_invalidation(ctx: Context) -> tuple[bool, dict]:
    """Sniper is EXEMPT from adverse-BOS closes. Invalidation = adverse
    drawdown ≥ vol-scaled floor (sniper_max_adverse_pct, scaled up on very
    calm symbols so noise doesn't clip us).

    If entry_swing_level is ever persisted on the row, extend here to prefer
    that structural breach.
    """
    dd = adverse_drawdown_frac({"direction": ctx.side, "entry_price": ctx.avg_entry,
                                "fills": []}, ctx.mark)
    threshold = SNIPER_MAX_ADVERSE_PCT
    # vol scaling: don't fire on high-vol symbols where 3% is one wick.
    if ctx.atr_pct > 0:
        threshold = max(threshold, 2.0 * ctx.atr_pct)
    return dd >= threshold, {
        "sniper_dd_frac": round(dd, 6),
        "sniper_threshold": round(threshold, 6),
        "atr_pct": round(ctx.atr_pct, 6),
    }


def _rung_cancel_threshold(ctx: Context) -> float:
    return max(RUNG_CANCEL_FLOOR_PCT, RUNG_CANCEL_ATR_MULT * ctx.atr_pct)


def _cluster_dd_threshold(ctx_atr_pct: float) -> float:
    return max(CLUSTER_FLOOR_PCT, CLUSTER_DRAWDOWN_ATR_MULT * ctx_atr_pct)


# ─── gate pipeline ───────────────────────────────────────────────────────────
def evaluate_context(ctx: Context) -> Verdict:
    gates: dict = {
        "pair": bool(ctx.pair_id),
        "promoted": ctx.promoted,
        "grace_required": GRACE_CANDLES,
        "age_candles": ctx.age_candles,
        "atr_pct": round(ctx.atr_pct, 6),
        "strategy": ctx.strategy or "unknown",
    }
    base_ev = {
        "rule_version": GUARDIAN_RULES_VERSION,
        "mark": round(ctx.mark, 10) if ctx.mark > 0 else None,
        "avg_entry": round(ctx.avg_entry, 10),
        "pending_rungs": ctx.pending,
        "promoted": ctx.promoted,
    }

    # Gate 1 — arbiter pair delegation.
    if ctx.pair_id:
        return Verdict(
            ctx.pos_id, ctx.symbol, ctx.side, "hold", None, [],
            {**base_ev, "rule": "arbiter_pair_delegated", "pair_id": ctx.pair_id, "gates": gates},
        )

    if ctx.side == "flat":
        return Verdict(
            ctx.pos_id, ctx.symbol, "flat", "hold", None, [],
            {**base_ev, "rule": "flat_no_direction", "gates": gates},
        )

    # Gate 3 — promoted runner: worker never closes; engine owns the runner exit.
    if ctx.promoted:
        return Verdict(
            ctx.pos_id, ctx.symbol, ctx.side, "hold", None, [],
            {**base_ev, "rule": "runner_5m_skipped", "gates": gates},
        )

    directives: list = []

    # Gate 4 — rung-cancel (allowed at any age, including grace).
    rung_ev: dict = {}
    if ctx.pending > 0 and ctx.deepest_filled and ctx.deepest_filled > 0 and ctx.mark > 0:
        beyond = (
            (ctx.deepest_filled - ctx.mark) / ctx.deepest_filled
            if ctx.side == "long"
            else (ctx.mark - ctx.deepest_filled) / ctx.deepest_filled
        )
        thr = _rung_cancel_threshold(ctx)
        rung_ev = {
            "deepest_filled": round(ctx.deepest_filled, 10),
            "beyond_deepest_frac": round(beyond, 6),
            "rung_cancel_threshold": round(thr, 6),
        }
        if beyond >= thr:
            ev = {**base_ev, "rule": "ladder_underwater", **rung_ev, "gates": gates}
            directives.append(Directive(
                ctx.pos_id, DIRECTIVE_CANCEL_UNFILLED_RUNGS, REASON_LADDER_UNDERWATER,
                ctx.symbol, ctx.wallet_key, ev,
            ))
            gates["rung_cancel_fired"] = True

    # Gate 5 — grace window: closes suppressed while ripening.
    within_grace = ctx.age_candles < GRACE_CANDLES
    gates["within_grace"] = within_grace

    # Gate 6 — strategy rule.
    if ctx.strategy == "sniper":
        invalidated, sniper_ev = _sniper_invalidation(ctx)
        gates["sniper_invalidated"] = invalidated
        gates.update(sniper_ev)
        if invalidated and not within_grace:
            ev = {**base_ev, "rule": "sniper_invalidated", **sniper_ev, "gates": gates}
            if ctx.pending > 0:
                directives.append(Directive(
                    ctx.pos_id, DIRECTIVE_CANCEL_UNFILLED_RUNGS, REASON_SNIPER_INVALIDATED,
                    ctx.symbol, ctx.wallet_key, ev,
                ))
            directives.append(Directive(
                ctx.pos_id, DIRECTIVE_CLOSE_POSITION, REASON_SNIPER_INVALIDATED,
                ctx.symbol, ctx.wallet_key, ev,
            ))
            return Verdict(ctx.pos_id, ctx.symbol, ctx.side, "close",
                           REASON_SNIPER_INVALIDATED, directives, ev)
    elif ctx.strategy in _TREND_LEGS or ctx.strategy == "":
        # Default any unknown strategy to the trend-leg rulebook — safer than
        # letting an unrecognised strategy escape structural invalidation.
        bos_ev, bos_gates = _detect_adverse_bos_fresh_significant(ctx)
        gates.update({k: v for k, v in bos_gates.items() if k in ("fresh", "significant", "detected")})
        if bos_ev is not None and not within_grace:
            ev = {**base_ev, "rule": "adverse_bos", **bos_ev, "gates": gates}
            if ctx.pending > 0:
                directives.append(Directive(
                    ctx.pos_id, DIRECTIVE_CANCEL_UNFILLED_RUNGS, REASON_ADVERSE_BOS,
                    ctx.symbol, ctx.wallet_key, ev,
                ))
            directives.append(Directive(
                ctx.pos_id, DIRECTIVE_CLOSE_POSITION, REASON_ADVERSE_BOS,
                ctx.symbol, ctx.wallet_key, ev,
            ))
            return Verdict(ctx.pos_id, ctx.symbol, ctx.side, "close",
                           REASON_ADVERSE_BOS, directives, ev)
        if bos_ev is not None and within_grace:
            # Fresh + significant, but we're still ripening. Rejected close
            # logged; rung-cancels above (if any) still stand.
            gates["close_blocked_by_grace"] = True

    # Rung-cancel-only or clean HOLD.
    if directives:
        return Verdict(
            ctx.pos_id, ctx.symbol, ctx.side, "hold", REASON_LADDER_UNDERWATER,
            directives, {**base_ev, "rule": "ladder_underwater", **rung_ev, "gates": gates},
        )
    return Verdict(
        ctx.pos_id, ctx.symbol, ctx.side, "hold", None, [],
        {**base_ev, "rule": "none", "gates": gates},
    )


# ─── backwards-compatible entry points ───────────────────────────────────────
def evaluate_position(
    pos: dict,
    candles: Sequence[Sequence[float]],
    tick: float,
    mark: float,
    now_ms: Optional[int] = None,
) -> Verdict:
    """v2 entry point. `now_ms` defaults to opened_at + GRACE_CANDLES + 1
    candle so calls without a clock still exit the grace window naturally
    for tests that predate v2."""
    market = {"candles": candles, "tick": tick, "mark": mark}
    opened = int(_num(pos.get("entry_candle_ts_ms")))
    if now_ms is None:
        now_ms = opened + (GRACE_CANDLES + 1) * CANDLE_MS if opened > 0 else 0
    ctx = build_context(pos, market, int(now_ms))
    return evaluate_context(ctx)


# ─── cluster rule (vol-scaled, runner-safe) ──────────────────────────────────
def evaluate_cluster(
    positions: Sequence[dict],
    mark_by_symbol: dict,
    atr_pct_by_symbol: Optional[dict] = None,
) -> list[Directive]:
    """Same-direction correlated cluster. Per-position drawdown threshold is
    vol-scaled off the symbol's 5m ATR%; promoted runners have their drawdown
    clamped near 0 (measured from runner_breakeven_stop) so they cannot drag
    a cluster over threshold."""
    atr_pct_by_symbol = atr_pct_by_symbol or {}
    directives: list[Directive] = []
    for side in ("long", "short"):
        members = []
        for pos in positions:
            if position_side(pos) != side:
                continue
            sym = str(pos.get("symbol") or "")
            mark = _num(mark_by_symbol.get(sym))
            if not (mark > 0):
                continue
            if bool(pos.get("promoted")):
                # Runner protected by a breakeven stop → its realized loss is
                # capped at 0. Clamp its cluster-drawdown to 0 so it can never
                # drag the cluster over threshold. Without a BE stop set we
                # treat it as an unprotected member.
                if pos.get("runner_breakeven_stop"):
                    dd = 0.0
                else:
                    dd = adverse_drawdown_frac(pos, mark)
            else:
                dd = adverse_drawdown_frac(pos, mark)
            thr = _cluster_dd_threshold(_num(atr_pct_by_symbol.get(sym)))
            members.append((pos, mark, dd, thr))
        underwater = [m for m in members if m[2] >= m[3]]
        if len(underwater) >= CLUSTER_MIN_POSITIONS:
            symbols = sorted(str(p.get("symbol") or "") for p, _, _, _ in underwater)
            for pos, mark, dd, thr in underwater:
                pid = str(pos.get("id") or "")
                ev = {
                    "rule": "correlated_cluster",
                    "rule_version": GUARDIAN_RULES_VERSION,
                    "cluster_side": side,
                    "cluster_size": len(underwater),
                    "cluster_symbols": symbols,
                    "min_positions": CLUSTER_MIN_POSITIONS,
                    "drawdown_frac": round(dd, 6),
                    "drawdown_threshold": round(thr, 6),
                    "mark": round(mark, 10),
                    "vol_scaled": True,
                }
                directives.append(Directive(
                    pid, DIRECTIVE_CLOSE_POSITION, REASON_CLUSTER,
                    str(pos.get("symbol") or ""),
                    pos.get("wallet_key") if isinstance(pos.get("wallet_key"), str) else None,
                    ev,
                ))
    return directives


# ─── portfolio orchestration ────────────────────────────────────────────────
def evaluate_portfolio(
    positions: Sequence[dict],
    market_by_symbol: dict,
    now_ms: Optional[int] = None,
) -> PortfolioResult:
    """Evaluate every position through the v2 gate pipeline plus the
    cross-position cluster rule.

    `market_by_symbol[symbol]` = {"candles": [...], "tick": float, "mark": float}
    for each symbol with usable market data. A position whose symbol has no
    market data still gets a HOLD verdict (recorded), just no BOS/mark rule.
    """
    verdicts: list[Verdict] = []
    mark_by_symbol: dict[str, float] = {}
    atr_pct_by_symbol: dict[str, float] = {}
    for pos in positions:
        sym = str(pos.get("symbol") or "")
        md = market_by_symbol.get(sym) or {}
        candles = md.get("candles") or []
        tick = _num(md.get("tick"))
        mark = _num(md.get("mark"))
        if mark > 0:
            mark_by_symbol[sym] = mark
            atr_pct_by_symbol[sym] = _atr_pct(candles, mark)
        if not candles or not (mark > 0) or not (tick > 0):
            verdicts.append(Verdict(
                str(pos.get("id") or ""), sym, position_side(pos), "hold", None, [],
                {"rule": "no_market_data", "rule_version": GUARDIAN_RULES_VERSION},
            ))
            continue
        v = evaluate_position(pos, candles, tick, mark, now_ms=now_ms)
        verdicts.append(v)

    cluster = evaluate_cluster(positions, mark_by_symbol, atr_pct_by_symbol)
    return PortfolioResult(verdicts, cluster)
