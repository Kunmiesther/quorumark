"""Aster worker intent contract. Pure: no credentials or venue mutations.

The signer owns authenticated sizing and venue preflight; worker hints must
never override it. ApeX's size/TP fields must not leak into this protocol.
"""
from shared.execution_configuration import configured_leverage
import live_eligibility


class AsterIntentError(ValueError):
    pass


def build_entry_intent(*, cfg, live_enabled, user_id, connection_id, symbol,
                       direction, idempotency_key, strategy):
    if not live_enabled:
        raise AsterIntentError("LIVE_TRADING_DISABLED")
    reason = live_eligibility.live_execution_block_code(cfg)
    if reason:
        raise AsterIntentError(reason)
    if cfg.get("exchange_type") != "aster":
        raise AsterIntentError("ASTER_CONNECTION_MISMATCH")
    if cfg.get("enabled") is not True:
        raise AsterIntentError("STRATEGY_NOT_ENABLED")
    if cfg.get("environment") not in ("mainnet", "production"):
        raise AsterIntentError("ASTER_MAINNET_REQUIRED")
    if (cfg.get("connection_id") != connection_id or cfg.get("user_id") != user_id):
        raise AsterIntentError("ASTER_CONNECTION_MISMATCH")
    if symbol not in {"BTC-USDT", "ETH-USDT", "SOL-USDT", "XRP-USDT"}:
        raise AsterIntentError("ASTER_SYMBOL_UNSUPPORTED")
    if direction not in ("long", "short"):
        raise AsterIntentError("ASTER_ENTRY_DIRECTION_REQUIRED")
    if strategy == "sweep":
        raise AsterIntentError("ZEN_SWEEP_LIVE_PARITY_PENDING")
    params = cfg.get("params") or {}
    if not isinstance(params, dict) or params.get("dynamic_wallet_sizing") is not True:
        raise AsterIntentError("ASTER_FIVE_RUNG_CONFIGURATION_REQUIRED")
    leverage = configured_leverage(params.get("leverage"), maximum=125)
    if leverage is None:
        raise AsterIntentError("ASTER_LEVERAGE_INVALID")
    if not isinstance(idempotency_key, str) or not 8 <= len(idempotency_key) <= 64:
        raise AsterIntentError("ASTER_CAMPAIGN_INVALID")
    return {
        "user_id": user_id, "connection_id": connection_id, "venue": "aster",
        "symbol": symbol, "side": "BUY" if direction == "long" else "SELL",
        "order_type": "MARKET", "campaign_rung_count": 5,
        "purpose": "CREATE_ORDER", "idempotency_key": idempotency_key,
        "leverage": int(leverage),
    }
