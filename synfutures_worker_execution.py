"""SynFutures strategy requests contain no address, size, tick or authority flag."""
import live_eligibility
from shared.execution_configuration import configured_leverage
from shared.synfutures_math import decimal_wad
from synfutures_market_data import MARKETS


class SynFuturesIntentError(ValueError):
    pass


def build_entry_intent(*, cfg, live_enabled, user_id, connection_id, symbol,
                       direction, idempotency_key, strategy):
    if not live_enabled:
        raise SynFuturesIntentError("LIVE_TRADING_DISABLED")
    reason = live_eligibility.live_execution_block_code(cfg)
    if reason:
        raise SynFuturesIntentError(reason)
    if (cfg.get("exchange_type") != "synfutures" or cfg.get("user_id") != user_id
            or cfg.get("connection_id") != connection_id):
        raise SynFuturesIntentError("SYNFUTURES_CONNECTION_MISMATCH")
    if cfg.get("enabled") is not True or cfg.get("environment") not in ("mainnet", "production"):
        raise SynFuturesIntentError("SYNFUTURES_STRATEGY_NOT_ACTIVE")
    if symbol not in MARKETS or direction not in ("long", "short"):
        raise SynFuturesIntentError("SYNFUTURES_MARKET_OR_DIRECTION_INVALID")
    if strategy == "sweep":
        raise SynFuturesIntentError("ZEN_SWEEP_LIVE_PARITY_PENDING")
    params = cfg.get("params") or {}
    leverage = configured_leverage(params.get("leverage"), maximum=33) if isinstance(params, dict) else None
    if leverage is None:
        raise SynFuturesIntentError("SYNFUTURES_LEVERAGE_INVALID")
    margin = params.get("margin_usdc")
    try:
        decimal_wad(margin)
    except ValueError:
        raise SynFuturesIntentError("SYNFUTURES_EXACT_MARGIN_REQUIRED") from None
    if not isinstance(idempotency_key, str) or not 8 <= len(idempotency_key) <= 64:
        raise SynFuturesIntentError("SYNFUTURES_CAMPAIGN_INVALID")
    return {"user_id": user_id, "connection_id": connection_id, "venue": "synfutures",
            "symbol": symbol, "side": "BUY" if direction == "long" else "SELL",
            "order_type": "MARKET", "purpose": "AUTOMATED_ENTRY",
            "idempotency_key": idempotency_key, "leverage": int(leverage), "margin_usdc": margin}
