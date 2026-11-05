"""Hard max-loss cap — live-worker mirror of the TS `shouldTriggerMaxLoss`.

DEBT-02 closure. Pure predicate. Loads its threshold from the shared parity
JSON so TS paper engine and Python live worker share the SAME value; no
in-module literal permitted here beyond structural sentinels.

Predicate (identical to `src/lib/paper/constants.ts::shouldTriggerMaxLoss`):

    margin > 0 AND -unrealized_worst >= margin * MAX_LOSS_MARGIN_FRAC

`unrealized_worst` is the worst-case unrealized PnL on the position over the
current cycle (typically the most-negative mark-to-market since the last
check; the worker computes it from the newest candle's low for longs / high
for shorts).
"""
from __future__ import annotations

from shared.parity_constants import get as _pc_get

MAX_LOSS_MARGIN_FRAC: float = float(_pc_get("risk", "max_loss_margin_frac"))


def should_trigger_max_loss(margin: float, unrealized_worst: float) -> bool:
    """True iff the position has crossed the hard max-loss cap.

    Args:
        margin: Committed margin on the position (USD, > 0).
        unrealized_worst: Worst-case unrealized PnL in USD (negative when
            underwater).
    """
    if margin is None or unrealized_worst is None:
        return False
    try:
        m = float(margin)
        u = float(unrealized_worst)
    except (TypeError, ValueError):
        return False
    return m > 0 and (-u) >= m * MAX_LOSS_MARGIN_FRAC
