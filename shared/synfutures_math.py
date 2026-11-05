"""Exact SynFutures legacy TickMath, ported from oyster-sdk/src/math/tickMath.ts.

Signal prices may use floats; execution amounts and price bounds never do.
"""
import re

WAD = 10**18
MIN_TICK, MAX_TICK = -322517, 443636
_FACTORS = tuple(int(x, 16) for x in (
    "fffcb933bd6fad37aa2d162d1a594001", "fff97272373d413259a46990580e213a",
    "fff2e50f5f656932ef12357cf3c7fdcc", "ffe5caca7e10e4e61c3624eaa0941cd0",
    "ffcb9843d60f6159c9db58835c926644", "ff973b41fa98c081472e6896dfb254c0",
    "ff2ea16466c96a3843ec78b326b52861", "fe5dee046a99a2a811c461f1969c3053",
    "fcbe86c7900a88aedcffc83b479aa3a4", "f987a7253ac413176f2b074cf7815e54",
    "f3392b0822b70005940c7a398e4b70f3", "e7159475a2c29b7443b29c7fa6e889d9",
    "d097f3bdfd2022b8845ad8f792aa5825", "a9f746462d870fdf8a65dc1f90e061e5",
    "70d869a156d2a1b890bb3df62baf32f7", "31be135f97d08fd981231505542fcfa6",
    "9aa508b5b7a84e1c677de54f3e99bc9", "5d6af8dedb81196699c329225ee604",
    "2216e584f5fa1ea926041bedfe98", "48a170391f7dc42444e8fa2",
))


def price_at_tick(tick):
    if type(tick) is not int or not MIN_TICK <= tick <= MAX_TICK:
        raise ValueError("SYNFUTURES_TICK_INVALID")
    ratio = 1 << 128
    for bit, factor in enumerate(_FACTORS):
        if abs(tick) & (1 << bit):
            ratio = ratio * factor >> 128
    if tick > 0:
        ratio = ((1 << 256) - 1) // ratio
    sqrt = (ratio + (1 << 32) - 1) >> 32
    return ((sqrt * sqrt >> 96) * WAD) >> 96


def tick_at_price(price):
    if type(price) is not int or not price_at_tick(MIN_TICK) <= price < price_at_tick(MAX_TICK):
        raise ValueError("SYNFUTURES_PRICE_INVALID")
    low, high = MIN_TICK, MAX_TICK
    while low + 1 < high:
        middle = (low + high) // 2
        if price_at_tick(middle) <= price:
            low = middle
        else:
            high = middle
    return low


def decimal_wad(value):
    if not isinstance(value, str) or not re.fullmatch(r"(?:0|[1-9][0-9]{0,19})(?:\.[0-9]{1,18})?", value):
        raise ValueError("SYNFUTURES_EXACT_AMOUNT_REQUIRED")
    whole, _, fraction = value.partition(".")
    amount = int(whole) * WAD + int((fraction + "0" * 18)[:18])
    if not 0 < amount < 2**127:
        raise ValueError("SYNFUTURES_AMOUNT_INVALID")
    return amount


def wad_decimal(value):
    if type(value) is not int or value < 0:
        raise ValueError("SYNFUTURES_AMOUNT_INVALID")
    return f"{value // WAD}.{value % WAD:018d}".rstrip("0").rstrip(".")
