"""Entry-FREQUENCY study over real ApeX history. NOT a P&L backtest.

WHAT THIS IS
------------
Replays the ratified entry path (accumulator_signal) candle-by-candle over a
real window of ApeX mainnet history and counts how often it would have wanted
to act. It answers exactly one question: "three times a day, or thirty?"

WHAT THIS IS NOT
----------------
There is NO P&L here, and there cannot be yet:
  * LEVERAGE is undefined -> S39's target is vwap x (1 +- 4/leverage), so no
    exit price exists, so no profit or loss exists.
  * The STOP is unratified (B-12: "NOT an owner ruling. Verify before
    testnet.") -> no loss side.
  * Fees / funding / slippage are not modelled. S39 says the target is GROSS
    and those still count in net P&L and safeguards.
Anything claiming performance from this file would be fabricated.

METHOD
------
Walks a sliding 198-candle window forward one completed candle at a time and
calls `detect_break` at the window edge only. It never looks past the edge, so
the lookahead guard that governs live observation governs the study too. A
gap, duplicate, or misalignment raises rather than being smoothed.

Public data only. No key, no signing, no order, nothing on the wire but GETs.

    python backtest_entries.py [SYMBOL] [HOURS]
"""
from __future__ import annotations

import sys
from collections import Counter

import accumulator_signal as sig
import market_data

WINDOW = market_data.MAX_NEED_PER_CALL  # 198


def study(symbol: str = "BTC-USDT", hours: int = 168) -> int:
    feed = market_data.ApexPublicFeed()
    print(f"fetching {hours}h of {symbol} {sig.LOOKBACK_CANDLES and 5}m candles (paged)...")
    f = feed.fetch_range(symbol, 5, hours=hours)
    c = f.candles
    print(f"  candles={len(c)}  tick={f.tick}  span={(len(c)*5)/60:.1f}h  age_sec={f.age_sec:.1f}")

    atr = sig.wilder_atr_series(c)
    ema = sig.ema_series(c)
    swings = sig.group_liquidity_zones(sig.find_confirmed_swings(c), atr, f.tick)

    per_dir = {}
    for direction in ("long", "short"):
        breaks, states = [], Counter()
        for i in range(WINDOW, len(c)):
            be = sig.detect_break(c, direction, f.tick, swings, atr, ema, at_index=i)
            if be is None:
                continue
            breaks.append(be)
            states[sig.detect_retest(c, be, ema).state] += 1
        per_dir[direction] = (breaks, states)

    hrs = (len(c) - WINDOW) * 5 / 60
    print(f"\nevaluated {len(c)-WINDOW} completed candles ({hrs:.1f}h of decisions)\n")
    print(f"{'dir':<6}{'breaks':>8}{'confirmed':>11}{'expired_w':>11}{'expired_b':>11}{'pending':>9}{'entries/day':>13}")
    total = 0
    for d, (breaks, st) in per_dir.items():
        conf = st['confirmed']; total += conf
        print(f"{d:<6}{len(breaks):>8}{conf:>11}{st['expired_window']:>11}"
              f"{st['expired_breach']:>11}{st['pending']:>9}{conf/(hrs/24):>13.1f}")
    print(f"\nBOTH DIRECTIONS: {total} confirmed entries over {hrs:.1f}h "
          f"= {total/(hrs/24):.1f} per day")
    print("\nNO P&L. Leverage undefined -> no S39 target -> no exit price.")
    print("B-12 stop unratified. Fees/funding/slippage not modelled.")
    return 0


if __name__ == "__main__":
    sym = sys.argv[1] if len(sys.argv) > 1 else "BTC-USDT"
    hrs = int(sys.argv[2]) if len(sys.argv) > 2 else 168
    raise SystemExit(study(sym, hrs))
