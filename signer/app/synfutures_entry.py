"""Exact native entry preflight. Does not grant activation or broadcast authority.

Sizing consumes a block-pinned venue quote and the account adapter's own reads.
Unknown positions, available collateral or portfolio limits are refusal states.
"""
from shared.synfutures_math import WAD, decimal_wad, tick_at_price, price_at_tick


class SynFuturesEntryError(ValueError):
    pass


def require(condition, code):
    if not condition:
        raise SynFuturesEntryError(code)


def plan_entry(*, margin_usdc, leverage, long, quote, account, managed_size=None):
    margin = decimal_wad(margin_usdc)
    require(type(leverage) is int and 1 <= leverage <= 33 and type(long) is bool,
            "SYNFUTURES_ENTRY_INVALID")
    required = ("available_margin", "budget_remaining", "max_margin", "max_size", "max_notional",
                "max_leverage", "initial_margin_ratio", "minimum_margin", "portfolio_notional",
                "portfolio_limit", "slippage_bps", "position_size", "position_balance", "position_notional")
    require(all(type(account.get(k)) is int for k in required), "SYNFUTURES_ACCOUNT_INPUT_UNCONFIRMED")
    require(all(account[k] >= 0 for k in required if k not in ("position_size", "position_balance")),
            "SYNFUTURES_ACCOUNT_INPUT_INVALID")
    # A campaign must not silently net, reverse or add to an unmanaged position.
    if managed_size is None:
        require(account["position_size"] == 0 and account["position_notional"] == 0,
                "SYNFUTURES_EXISTING_EXPOSURE")
    else:
        require(type(managed_size) is int and managed_size == account['position_size']
                and (managed_size == 0 or (managed_size > 0) == long), 'SYNFUTURES_UNEXPLAINED_POSITION')
    require(margin <= min(account["available_margin"], account["budget_remaining"], account["max_margin"]),
            "SYNFUTURES_MARGIN_ABOVE_LIMIT")
    require(margin >= account["minimum_margin"] > 0, "SYNFUTURES_MARGIN_BELOW_MINIMUM")
    require(leverage <= account["max_leverage"], "SYNFUTURES_LEVERAGE_ABOVE_LIMIT")
    require(all(type(quote.get(k)) is int for k in ("size", "mark", "entry_notional", "fee", "min_amount")),
            "SYNFUTURES_QUOTE_UNCONFIRMED")
    size, mark, notional, fee = (quote[k] for k in ("size", "mark", "entry_notional", "fee"))
    require(0 < abs(size) < 2**127 and (size > 0) == long and mark > 0 and notional > 0 and fee >= 0,
            "SYNFUTURES_QUOTE_INVALID")
    require(0 < account["initial_margin_ratio"] <= 10_000, "SYNFUTURES_MARGIN_RATIO_INVALID")
    minimum_notional = account["minimum_margin"] * 10_000 // account["initial_margin_ratio"]
    require(notional >= minimum_notional, "SYNFUTURES_NOTIONAL_BELOW_MINIMUM")
    require(0 <= quote["min_amount"] <= margin, "SYNFUTURES_QUOTED_MARGIN_REQUIRED")
    require(abs(account['position_size'] + size) <= account["max_size"]
            and account['position_notional'] + notional <= account["max_notional"],
            "SYNFUTURES_MARKET_EXPOSURE_LIMIT")
    net_balance = account["position_balance"] + margin - fee
    require(net_balance > 0 and account['position_notional'] + notional <= net_balance * leverage,
            "SYNFUTURES_FEE_ADJUSTED_LEVERAGE_LIMIT")
    require((account['position_notional'] + notional) * account["initial_margin_ratio"] <= net_balance * 10_000,
            "SYNFUTURES_INITIAL_MARGIN_LIMIT")
    require(account["portfolio_notional"] + notional <= account["portfolio_limit"],
            "SYNFUTURES_PORTFOLIO_EXPOSURE_LIMIT")
    bps = account["slippage_bps"]
    require(0 < bps < 10_000, "SYNFUTURES_SLIPPAGE_INVALID")
    reference = abs(size) * mark // WAD
    require(reference > 0 and (notional <= reference * (10_000 + bps) // 10_000 if long
            else notional >= reference * (10_000 - bps) // 10_000), "SYNFUTURES_SLIPPAGE_ABOVE_LIMIT")
    bound = mark * (10_000 + bps if long else 10_000 - bps) // 10_000
    tick = tick_at_price(bound)
    # Buy ceiling rounds down, sell floor rounds up. No unrestricted-price tick.
    if not long and price_at_tick(tick) < bound:
        tick += 1
    return {"signed_size": str(size), "margin": str(margin), "limit_tick": tick,
            "entry_notional": str(notional), "fee": str(fee)}
