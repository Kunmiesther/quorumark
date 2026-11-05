"""Execution pipeline — CREATE_ORDER, protection placement, RECONCILE.

Callable primitives are injected so tests exercise every branch without
touching the network or the STARK signer. Production wiring lives in
`app/main.py`.

Rules ratified by the owner (2026-07-17):
  - Single BTC-USDT position per user/connection.
  - $30 canary baseline -> $300 notional -> $3 margin at 100x.
  - authenticated free-collateral guard; $100 account floor; server-side.
  - Reduce-only exits ALWAYS.
  - If protective-order placement fails after entry submit, cancel/close
    the entry FAIL-CLOSED — never leave a naked position.
  - Never blindly retry an ambiguous submission. Reconcile by
    `client_order_id`.
"""
from __future__ import annotations

from dataclasses import dataclass
from decimal import Decimal
from typing import Callable, Optional, Protocol

from .builder import BuiltOrder, ACCOUNT_FLOOR_USD, STRATEGY_CAP_USD
from .orders_v3 import OrderRestError
from .test_mode import assert_cross_margin



# THERE IS NO WALLET-SIZE MINIMUM. This carried MIN_EQUITY_USD = 500, which
# refused any account below that outright.
#
# It contradicted the ratified sizing rule. `accumulator_sizing` §13.2 sets
# margin_fraction = 10 / leverage, so an entry commits 10% of the wallet as
# margin — scale-invariant, with the §13.5 ledger holding at a constant 47%
# of capital at any balance. A small wallet takes a small position; there is
# no balance at which the arithmetic stops working.
#
# What still binds, and should:
#   * ACCOUNT_FLOOR_USD — the owner-ratified `allocation_reserve_floor_usd`
#     from shared/mainnet_parity_constants.json. A RESERVE, not a minimum:
#     "the reserve floor NEVER goes on-desk". Shared with the broker
#     translator and the worker sizing helper, so it is changed in that one
#     JSON file, not here.
#   * INSUFFICIENT_FREE_COLLATERAL — whether this order's own margin is
#     actually available. Arithmetic about the order, not a rule about the
#     account.
#   * The venue minimums on the sizing path (min_notional, minOrderSize,
#     stepSize), read live from /api/v3/symbols. That is the real floor.


class PipelineError(Exception):
    def __init__(self, code: str, *, unattempted_client_ids: tuple[str, ...] = (),
                 accepted_orders: tuple[tuple[str, str], ...] = ()) -> None:
        super().__init__(code)
        self.code = code
        self.unattempted_client_ids = unattempted_client_ids
        self.accepted_orders = accepted_orders


@dataclass(frozen=True)
class Protection:
    kind: str            # "STOP" | "TP1" | "TP2" | "TP3"
    trigger_price: str   # server-observable trigger
    size: str            # fraction of entry size
    order_type: str      # "STOP_MARKET" | "TAKE_PROFIT_MARKET"


@dataclass(frozen=True)
class ExecutionRequest:
    intent_id: str
    user_id: str
    connection_id: str
    client_order_id: str
    environment: str
    built: BuiltOrder
    protections: tuple[Protection, ...]  # empty tuple means "no exit plan" -> refused
    # Maker-only resting entry (LIMIT + POST_ONLY). Off for every strategy path.
    post_only: bool = False
    # Reduce-only exit submission (council TP, partial TP, EXIT_NOW). When
    # True the order can only shrink an existing position: `reduceOnly` is
    # forced true, no STOP is attached, no TP ladder is built and the
    # no-exit-plan guard does not apply (an exit IS the exit plan).
    reduce_only: bool = False




@dataclass(frozen=True)
class ExecutionResult:
    venue_order_id: str
    protection_venue_ids: dict[str, str]  # kind -> venue order id
    status: str
    stop_attachment_confirmed: bool = False


@dataclass(frozen=True)
class CampaignExecutionResult:
    orders: tuple[ExecutionResult, ...]
    status: str


# --- Adapters (injected in tests) ---------------------------------------


class RestPort(Protocol):
    def create_order(self, params: dict) -> dict: ...
    def cancel_by_client_order_id(self, client_order_id: str) -> dict: ...
    def get_open_orders(self, symbol: Optional[str] = None) -> list[dict]: ...
    def get_positions(self) -> list[dict]: ...


# --- Preflight ----------------------------------------------------------

def resolve_preflight_equity(
    available_balance: Optional[object],
    total_equity: Optional[object],
) -> Optional[Decimal]:
    """Free collateral for the collateral gate, or None when UNREADABLE.

    Free collateral is preferred; total equity is the fallback ONLY when the
    venue omits `availableBalance`. A missing, empty, or unparsable pair
    returns None — it is NEVER normalized to zero, because a failed read and a
    drained account are different facts and must reject with different codes.
    """
    for raw in (available_balance, total_equity):
        parsed = _to_decimal(raw)
        if parsed is not None:
            return parsed
    return None


def resolve_account_equity(
    available_balance: Optional[object],
    total_equity: Optional[object],
) -> Optional[Decimal]:
    """Total account equity for the funding gate, or None when UNREADABLE.

    Total equity is preferred here; free collateral is the fallback ONLY when
    the venue omits it. Funding adequacy is a property of the whole account —
    margin already locked in an open position does not un-fund the account.
    """
    for raw in (total_equity, available_balance):
        parsed = _to_decimal(raw)
        if parsed is not None:
            return parsed
    return None


def _to_decimal(raw: Optional[object]) -> Optional[Decimal]:
    if raw is None or raw == "":
        return None
    try:
        value = Decimal(str(raw))
    except Exception:
        return None
    if not value.is_finite():
        return None
    return value


def preflight(
    *,
    equity_usd: Optional[Decimal],
    open_orders_for_symbol: list[dict],
    open_positions_for_symbol: list[dict],
    kill_switch_halted: bool,
    allow_existing_exposure: bool = False,
    total_equity_usd: Optional[Decimal] = None,
    required_margin_usd: Optional[Decimal] = None,
) -> None:
    """Server-side gate. Every check MUST pass or the pipeline refuses.
    None of these are advisory — a bypass means an unsized live entry.

    `equity_usd` is FREE collateral; `total_equity_usd` is whole-account
    equity (defaults to `equity_usd` when the caller cannot separate them).
    Both are still validated for finiteness and sign. There is NO wallet-size
    minimum — see the note above `PipelineError`. Free collateral must clear
    the ratified reserve floor and cover this order's own margin.

    `equity_usd=None` means the authenticated balance read produced no usable
    number. That is `EQUITY_UNAVAILABLE`, and it is deliberately distinct from
    a real balance of zero: the account may be fully funded and the read
    simply failed. A negative figure is `EQUITY_INVALID`.

    `allow_existing_exposure` is the ONLY scoped bypass: when True (owner-
    triggered proof-of-life ONLY, keyed by purpose='proof_of_life'), the
    two existing-order / existing-position guards are skipped so the
    canary can stack alongside pre-existing exposure. All other checks
    (kill switch, equity floors) remain fully active.
    """
    if kill_switch_halted:
        raise PipelineError("KILL_SWITCH_ACTIVE")
    if equity_usd is None:
        raise PipelineError("EQUITY_UNAVAILABLE")
    total = total_equity_usd if total_equity_usd is not None else equity_usd
    for value in (equity_usd, total):
        if not value.is_finite() or value < 0:
            raise PipelineError("EQUITY_INVALID")
    if equity_usd < ACCOUNT_FLOOR_USD:
        raise PipelineError("EQUITY_BELOW_FLOOR")
    if required_margin_usd is not None:
        if equity_usd - ACCOUNT_FLOOR_USD < required_margin_usd:
            raise PipelineError("INSUFFICIENT_FREE_COLLATERAL")
    if not allow_existing_exposure:
        if open_orders_for_symbol:
            raise PipelineError("EXISTING_OPEN_ORDER")
        if open_positions_for_symbol:
            raise PipelineError("EXISTING_OPEN_POSITION")




# --- Pipeline -----------------------------------------------------------

def _entry_params(req: ExecutionRequest) -> dict:
    b = req.built
    params = {
        "symbol": b.symbol,
        "side": b.side,
        # MARKET for every automated entry; LIMIT only when the builder was
        # given an explicit rung/limit price (manual ladder, post-only proof).
        "type": b.order_type or "MARKET",
        "size": b.size,
        "price": b.protected_price,
        "clientId": req.client_order_id,
        "reduceOnly": "true" if req.reduce_only else "false",
        "limitFee": b.taker_fee_rate,
        "makerFeeRate": b.maker_fee_rate,
    }
    if req.post_only:
        # Maker-only: the venue cancels rather than crossing the book.
        params["timeInForce"] = "POST_ONLY"
    # CROSS ONLY — refuse any payload that would select isolated margin.
    assert_cross_margin(params)
    return params




def _protection_params(req: ExecutionRequest, p: Protection, client_order_id: str) -> dict:
    exit_side = "SELL" if req.built.side == "BUY" else "BUY"
    return {
        "symbol": req.built.symbol,
        "side": exit_side,
        "type": p.order_type,
        "size": p.size,
        "price": p.trigger_price,
        "triggerPrice": p.trigger_price,
        "triggerPriceType": "INDEX",
        "clientId": client_order_id,
        "reduceOnly": "true",  # NON-NEGOTIABLE
        "limitFee": req.built.taker_fee_rate,
        "makerFeeRate": req.built.maker_fee_rate,
    }


def _attached_sl_from_protection(req: ExecutionRequest, p: Protection, client_order_id: str) -> dict:
    """SDK-native TP/SL attachment. Avoids the reduce-only race where a
    separate STOP submitted immediately after a MARKET entry is rejected
    because the position row does not yet exist on the venue."""
    exit_side = "SELL" if req.built.side == "BUY" else "BUY"
    return {
        "trigger_price": p.trigger_price,
        # Protective limit price for the SL leg — use the trigger so the SL
        # fires as a marketable close.
        "price": p.trigger_price,
        "size": p.size,
        "side": exit_side,
        "client_id": client_order_id,
        "trigger_price_type": "INDEX",
    }


def create_order_pipeline(
    req: ExecutionRequest,
    rest: RestPort,
    *,
    nonce_seed: int,
    allow_no_protections: bool = False,
) -> ExecutionResult:
    """Submit entry + attached STOP + ladder TPs.

    `allow_no_protections` is the ONLY scoped bypass and is keyed to the
    owner-triggered proof-of-life path (purpose='proof_of_life'). When True
    AND `req.protections` is empty, the pipeline submits ONLY the entry
    MARKET order — no attached STOP, no TP ladder, and NO fail-closed
    unwind. Strategy orders NEVER take this branch: they still require a
    populated `protections` tuple with an atomically-attached STOP.
    """
    if req.reduce_only:
        # REDUCE-ONLY EXIT. Never attaches a stop, never builds a ladder and
        # never unwinds: an order that can only shrink the position is safe
        # on its own. Callers (council TP / PARTIAL_TP / EXIT_NOW) must have
        # already reconciled size against the venue.
        if req.protections:
            raise PipelineError("REDUCE_ONLY_TAKES_NO_PROTECTIONS")
        try:
            exit_order = rest.create_order(_entry_params(req))
        except OrderRestError as e:
            raise PipelineError(f"EXIT_SUBMIT_FAILED:{e.args[0] if e.args else 'UNKNOWN'}") from e
        return ExecutionResult(
            venue_order_id=exit_order["venue_order_id"],
            protection_venue_ids={},
            status="submitted",
        )

    if not req.protections:
        if not allow_no_protections:
            raise PipelineError("NO_EXIT_PLAN")

        # Proof-of-life: entry-only, no protections, no unwind.
        try:
            entry = rest.create_order(_entry_params(req))
        except OrderRestError as e:
            raise PipelineError(f"ENTRY_SUBMIT_FAILED:{e.args[0] if e.args else 'UNKNOWN'}") from e
        return ExecutionResult(
            venue_order_id=entry["venue_order_id"],
            protection_venue_ids={},
            status="submitted",
        )

    for p in req.protections:
        if not p.trigger_price or Decimal(p.size) <= 0:
            raise PipelineError("BAD_PROTECTION")

    # Preferred path: atomically attach the protective STOP to the entry via
    # the SDK's TP/SL fields (`isOpenTpslOrder=True, isSetOpenSl=True`).
    # ApeX signs entry + SL together; there is never a window where the
    # position is unprotected. This also removes the reduce-only race
    # (code 20016 "Failed to check signature" / position-not-found) that a
    # follow-up STOP hits before the entry's position row is visible.
    stop = next((p for p in req.protections if p.kind == "STOP"), None)
    tps = [p for p in req.protections if p.kind != "STOP"]

    entry_params = _entry_params(req)
    if stop is not None:
        entry_params["attached_sl"] = _attached_sl_from_protection(
            req, stop, f"{req.client_order_id}-stop"
        )

    try:
        entry = rest.create_order(entry_params)
    except OrderRestError as e:
        raise PipelineError(f"ENTRY_SUBMIT_FAILED:{e.args[0] if e.args else 'UNKNOWN'}") from e
    venue_entry_id = entry["venue_order_id"]

    placed: dict[str, str] = {}
    if stop is not None:
        sl_id = entry.get("sl_venue_order_id")
        if sl_id:
            placed["STOP"] = str(sl_id)
        elif entry.get("sl_attachment_confirmed") is not True:
            # Accept either a venue child order ID or an independently
            # verified server-returned openSlParam receipt. Neither the
            # outgoing request nor entry acceptance alone proves protection.
            _fail_closed_unwind(
                req, rest, entry_client_order_id=req.client_order_id,
                placed=placed, nonce_seed=nonce_seed + 100,
            )
            raise PipelineError("PROTECTION_UNCONFIRMED:STOP",
                accepted_orders=((req.client_order_id, str(venue_entry_id)),))

    # Remaining protections (ladder TPs) placed as separate reduce-only
    # orders. Attached-STOP already guarantees protection, so a TP failure
    # degrades to log + reconcile instead of an entry unwind.
    for p in tps:
        prot_coid = f"{req.client_order_id}-{p.kind.lower()}"
        try:
            resp = rest.create_order(_protection_params(req, p, prot_coid))
            placed[p.kind] = resp["venue_order_id"]
        except (OrderRestError, PipelineError, Exception) as e:
            if stop is None:
                _fail_closed_unwind(req, rest, entry_client_order_id=req.client_order_id,
                                    placed=placed, nonce_seed=nonce_seed + 100)
                raise PipelineError(f"PROTECTION_FAILED:{p.kind}",
                    accepted_orders=((req.client_order_id, str(venue_entry_id)),)) from e
            placed[f"{p.kind}_FAILED"] = str(e)[:64]

    return ExecutionResult(
        venue_order_id=venue_entry_id,
        protection_venue_ids=placed,
        status="submitted",
        stop_attachment_confirmed=stop is not None and entry.get("sl_attachment_confirmed") is True,
    )


def create_campaign_pipeline(
    requests: tuple[ExecutionRequest, ...],
    rest: RestPort,
    *,
    nonce_seed: int,
) -> CampaignExecutionResult:
    """Submit one protected five-rung campaign with fail-closed cleanup.

    ApeX's pinned batch helper has an upstream attached-stop signing defect,
    so each rung uses the already verified atomic entry+SL SDK path. The
    campaign reserves all five database intents before this function runs.
    If any rung fails, every earlier resting rung is cancelled and any net
    position created by the campaign is closed reduce-only.
    """
    if len(requests) != 5:
        raise PipelineError("CAMPAIGN_REQUIRES_FIVE_RUNGS")
    first = requests[0]
    if any(
        r.user_id != first.user_id
        or r.connection_id != first.connection_id
        or r.built.symbol != first.built.symbol
        or r.built.side != first.built.side
        or r.built.order_type != "LIMIT"
        or r.reduce_only
        for r in requests
    ):
        raise PipelineError("CAMPAIGN_SHAPE_INVALID")
    completed: list[tuple[ExecutionRequest, ExecutionResult]] = []
    try:
        for index, req in enumerate(requests):
            result = create_order_pipeline(
                req, rest, nonce_seed=nonce_seed + (index * 1000),
                allow_no_protections=False,
            )
            completed.append((req, result))
    except Exception as exc:
        # Cancel all previously accepted entry and attached-stop client IDs.
        for prior, _result in completed:
            for client_id in (prior.client_order_id, f"{prior.client_order_id}-stop"):
                try:
                    rest.cancel_by_client_order_id(client_id)
                except Exception:
                    pass
        # A top rung may have filled before a later rung failed. There was no
        # pre-existing symbol exposure (campaign preflight enforces that), so
        # any venue position on this symbol belongs to this failed campaign.
        _close_symbol_position(first, rest, f"{first.client_order_id}-campaign-close")
        # Only the currently attempted rung is ambiguous. Later requests were
        # never handed to the transport. Preserve that fact across the route
        # boundary instead of manufacturing five uncertain orders.
        code = exc.code if isinstance(exc, PipelineError) else "SUBMIT_UNHANDLED"
        raise PipelineError(f"CAMPAIGN_PARTIAL_FAILURE:{code}",
            unattempted_client_ids=tuple(r.client_order_id for r in requests[len(completed)+1:]),
            accepted_orders=tuple((r.client_order_id,result.venue_order_id) for r,result in completed)
                + (exc.accepted_orders if isinstance(exc, PipelineError) else ()),
        ) from exc
    return CampaignExecutionResult(
        orders=tuple(result for _req, result in completed), status="submitted"
    )


def _close_symbol_position(req: ExecutionRequest, rest: RestPort, client_order_id: str) -> None:
    try:
        positions = rest.get_positions()
    except Exception:
        return
    for pos in positions:
        if str(pos.get("symbol")) != req.built.symbol:
            continue
        signed_size = Decimal(str(pos.get("size") or pos.get("openSize") or "0"))
        if signed_size == 0:
            continue
        position_side = str(pos.get("side") or "").upper()
        if position_side in ("LONG", "BUY") or (not position_side and signed_size > 0):
            close_side = "SELL"
        else:
            close_side = "BUY"
        try:
            rest.create_order({
                "symbol": req.built.symbol, "side": close_side, "type": "MARKET",
                "size": format(abs(signed_size), "f"), "price": req.built.protected_price,
                "clientId": client_order_id, "reduceOnly": "true",
                "limitFee": req.built.taker_fee_rate,
                "makerFeeRate": req.built.maker_fee_rate,
            })
        except Exception:
            pass
        return



def _fail_closed_unwind(
    req: ExecutionRequest,
    rest: RestPort,
    *,
    entry_client_order_id: str,
    placed: dict[str, str],
    nonce_seed: int,
) -> None:
    """Best-effort: cancel any protections we placed, cancel the entry, then
    if a position exists, submit a reduce-only market close."""
    # Cancel placed protections
    for kind in list(placed.keys()):
        try:
            rest.cancel_by_client_order_id(f"{entry_client_order_id}-{kind.lower()}")
        except Exception:
            pass
    # Cancel entry if still resting
    try:
        rest.cancel_by_client_order_id(entry_client_order_id)
    except Exception:
        pass
    # If a position appeared, close it reduce-only
    try:
        positions = rest.get_positions()
    except Exception:
        positions = []
    for pos in positions:
        if str(pos.get("symbol")) != req.built.symbol:
            continue
        signed_size = Decimal(str(pos.get("size") or pos.get("openSize") or "0"))
        if signed_size == 0:
            continue
        size = format(abs(signed_size), "f")
        close_side = "SELL" if str(pos.get("side", "")).upper() in ("LONG", "BUY") else "BUY"
        coid = f"{entry_client_order_id}-close"
        try:
            rest.create_order({
                "symbol": req.built.symbol, "side": close_side, "type": "MARKET",
                "size": size, "price": req.built.protected_price,
                "clientId": coid, "reduceOnly": "true",
                "limitFee": req.built.taker_fee_rate,
                "makerFeeRate": req.built.maker_fee_rate,
            })
        except Exception:
            # Nothing more we can do here without operator intervention. State
            # will be marked reconciliation_required by the caller.
            pass


# --- Reconcile ----------------------------------------------------------

@dataclass(frozen=True)
class ReconcileReport:
    matched: int
    updated: int
    unknown_venue_orders: list[str]


def reconcile(
    rest: RestPort,
    known_client_ids: list[str],
    on_match: Callable[[str, dict], None],
) -> ReconcileReport:
    """Query the venue for our open orders, match by client_order_id, and
    hand each matched row to `on_match(client_order_id, venue_row)` for
    persistence. Positions are queried separately and driven through the
    same callback with a synthetic 'position' row shape."""
    open_orders = rest.get_open_orders(symbol=None) or []
    positions = rest.get_positions() or []
    known = set(known_client_ids)
    matched = 0
    updated = 0
    unknown: list[str] = []

    for row in open_orders:
        coid = row.get("clientOrderId") or row.get("clientId")
        if coid and coid in known:
            matched += 1
            on_match(coid, {"kind": "order", "row": row}); updated += 1
        elif row.get("id"):
            unknown.append(str(row["id"]))
    for pos in positions:
        # Positions are keyed by symbol; caller re-associates.
        on_match(str(pos.get("symbol") or ""), {"kind": "position", "row": pos}); updated += 1

    return ReconcileReport(matched=matched, updated=updated, unknown_venue_orders=unknown)
