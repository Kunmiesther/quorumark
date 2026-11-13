from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone

from .models import Candle, RiskPolicy, SignalInput


KNOWN_QUOTE_ASSETS = ("USDT", "USDC", "USD", "NEAR", "BTC", "ETH")


def normalize_asset(asset: str, approved_assets: list[str] | tuple[str, ...] = ()) -> str:
    """Return the base asset used by follower policy approval.

    Strategies may emit exchange symbols such as BTCUSDT while a follower
    policy is intentionally configured with the human-readable base asset BTC.
    Exact symbols remain valid, and only known quote suffixes are removed so a
    malformed or unsupported symbol cannot become approved accidentally.
    """
    normalized = "".join(asset.upper().split()).replace("/", "").replace("-", "").replace("_", "")
    approved = {
        "".join(item.upper().split()).replace("/", "").replace("-", "").replace("_", "")
        for item in approved_assets
    }
    if normalized in approved:
        return normalized
    for quote in KNOWN_QUOTE_ASSETS:
        if normalized.endswith(quote) and normalized[: -len(quote)] in approved:
            return normalized[: -len(quote)]
    return normalized


@dataclass(frozen=True)
class RiskDecision:
    status: str
    reason_code: str
    reason: str
    notional: float
    quantity: float
    reserved_capital: float
    estimated_loss: float


def evaluate_signal_risk(
    signal: SignalInput,
    policy: RiskPolicy,
    candles: list[Candle],
    *,
    current_exposure: float = 0,
    now: datetime | None = None,
) -> RiskDecision:
    if policy.paused:
        return RiskDecision("rejected", "POLICY_PAUSED", "Follower has paused paper execution", 0, 0, 0, 0)
    approved_assets = {normalize_asset(asset, policy.approved_assets) for asset in policy.approved_assets}
    normalized_signal = normalize_asset(signal.asset, policy.approved_assets)
    if normalized_signal not in approved_assets:
        return RiskDecision("rejected", "ASSET_NOT_APPROVED", f"{signal.asset} is not approved by the follower", 0, 0, 0, 0)
    if not candles:
        return RiskDecision("rejected", "MARKET_DATA_REQUIRED", "A completed market-data snapshot is required", 0, 0, 0, 0)

    reference = (now or datetime.now(timezone.utc)).astimezone(timezone.utc)
    latest = candles[-1].timestamp.astimezone(timezone.utc)
    age = (reference - latest).total_seconds()
    if age < -60 or age > policy.max_data_age_seconds:
        return RiskDecision("rejected", "STALE_MARKET_DATA", f"Market data is outside the {policy.max_data_age_seconds}s freshness limit", 0, 0, 0, 0)

    if signal.entry <= 0 or signal.stop <= 0 or signal.target <= 0:
        return RiskDecision("rejected", "INVALID_LEVELS", "Entry, stop, and target must be positive", 0, 0, 0, 0)
    if signal.side == "long" and not signal.stop < signal.entry < signal.target:
        return RiskDecision("rejected", "INVALID_LONG_LEVELS", "Long levels must satisfy stop < entry < target", 0, 0, 0, 0)
    if signal.side == "short" and not signal.target < signal.entry < signal.stop:
        return RiskDecision("rejected", "INVALID_SHORT_LEVELS", "Short levels must satisfy target < entry < stop", 0, 0, 0, 0)

    notional = policy.capital * signal.size_pct / 100
    if notional <= 0:
        return RiskDecision("rejected", "ZERO_ALLOCATION", "Signal allocation produced no notional", 0, 0, 0, 0)
    if notional > policy.max_trade:
        return RiskDecision("rejected", "MAX_TRADE_EXCEEDED", f"Notional {notional:.2f} exceeds max trade {policy.max_trade:.2f}", notional, 0, 0, 0)
    if current_exposure + notional > policy.max_position:
        return RiskDecision("rejected", "MAX_EXPOSURE_EXCEEDED", "Signal would exceed the follower position limit", notional, 0, 0, 0)
    quantity = notional / signal.entry
    if quantity < policy.min_order_size:
        return RiskDecision("rejected", "MIN_ORDER_SIZE", "Calculated quantity is below the follower market minimum", notional, quantity, 0, 0)
    if policy.quantity_step > 0:
        quantity = (quantity // policy.quantity_step) * policy.quantity_step
    if quantity <= 0:
        return RiskDecision("rejected", "QUANTITY_ROUNDED_TO_ZERO", "Quantity rules reduced the order to zero", notional, quantity, 0, 0)

    reserved = quantity * signal.entry * (1 + policy.fee_bps / 10_000)
    estimated_loss = quantity * abs(signal.entry - signal.stop) + reserved * policy.fee_bps / 10_000
    if estimated_loss > policy.max_loss:
        return RiskDecision("rejected", "MAX_LOSS_EXCEEDED", f"Estimated stop loss {estimated_loss:.2f} exceeds {policy.max_loss:.2f}", notional, quantity, reserved, estimated_loss)
    if reserved > policy.capital:
        return RiskDecision("rejected", "CAPITAL_RESERVED_EXCEEDED", "Required capital reservation exceeds follower capital", notional, quantity, reserved, estimated_loss)
    return RiskDecision("accepted", "POLICY_APPROVED", "Follower policy approved paper execution", notional, quantity, reserved, estimated_loss)
