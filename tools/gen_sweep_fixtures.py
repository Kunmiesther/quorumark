"""Generate deterministic sweep parity fixtures.

Produces 4 fixtures under tests/fixtures/parity/:
  sweep_15m_long_rejection.json
  sweep_15m_short_rejection.json
  sweep_1h_momentum_hold.json
  sweep_1h_momentum_flip.json

The candle arrays are hand-tuned to fire the deterministic sweep detector
in sweep_signal.detect_sweep_15m and momentum evaluator in
evaluate_1h_momentum. Both TS and Python read the SAME arrays and MUST
produce the SAME verdict.
"""
import json, os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from sweep_signal import detect_sweep_15m, evaluate_1h_momentum

MIN15 = 15 * 60 * 1000
HOUR = 60 * 60 * 1000

def mk_candles_long_rejection():
    """40 15m candles ending in a sweep-low + reclaim-close (long)."""
    base_ts = 1_700_000_000_000 - (1_700_000_000_000 % MIN15) - 40 * MIN15
    out = []
    # 30 quiet candles ~100 with steady swings around 98-102 to seed ATR/RSI
    px = 100.0
    for i in range(30):
        # small alternating range to keep ATR nonzero and RSI mid
        hi = px + 1.0
        lo = px - 1.0
        op = px + (0.2 if i % 2 else -0.2)
        cl = px + (-0.2 if i % 2 else 0.2)
        out.append([base_ts + i * MIN15, op, hi, lo, cl, 100])
    # pivot low @ candle idx 32 = 95 (needs 2 higher lows either side)
    # Build clearer swing structure candles 30-38
    # idx30: normal, idx31: down, idx32: low pivot @95, idx33: up, idx34: normal
    struct = [
        (99.5, 100.5, 98.5, 99.0),   # 30
        (99.0, 99.5, 97.0, 97.5),    # 31
        (97.5, 98.0, 95.0, 96.0),    # 32  ← pivot low
        (96.0, 98.0, 96.0, 97.5),    # 33
        (97.5, 99.0, 97.0, 98.5),    # 34
        (98.5, 99.5, 98.0, 99.0),    # 35
        (99.0, 100.0, 98.5, 99.5),   # 36
        (99.5, 100.5, 99.0, 100.0),  # 37
    ]
    for i, (o, h, l, c) in enumerate(struct):
        out.append([base_ts + (30 + i) * MIN15, o, h, l, c, 100])
    # Newest candle: sweep-low (pierces 95 well below) then reclaim-close well above
    # ATR is ~1-2 so min_disp = 1.5*ATR ~ 2-3; pierce to 92, close 98.
    out.append([base_ts + 38 * MIN15, 93.0, 98.5, 92.0, 98.0, 200])
    return out

def mk_candles_short_rejection():
    """Mirror: sweep-high + reject-close (short)."""
    base_ts = 1_700_000_000_000 - (1_700_000_000_000 % MIN15) - 40 * MIN15
    out = []
    px = 100.0
    for i in range(30):
        hi = px + 1.0
        lo = px - 1.0
        op = px + (0.2 if i % 2 else -0.2)
        cl = px + (-0.2 if i % 2 else 0.2)
        out.append([base_ts + i * MIN15, op, hi, lo, cl, 100])
    struct = [
        (100.5, 101.5, 99.5, 101.0), # 30
        (101.0, 103.0, 101.0, 102.5),# 31
        (102.5, 105.0, 102.0, 104.0),# 32  ← pivot high @ 105
        (104.0, 104.0, 102.0, 102.5),# 33
        (102.5, 103.0, 101.0, 101.5),# 34
        (101.5, 102.0, 100.5, 101.0),# 35
        (101.0, 101.5, 100.0, 100.5),# 36
        (100.5, 101.0, 99.5, 100.0), # 37
    ]
    for i, (o, h, l, c) in enumerate(struct):
        out.append([base_ts + (30 + i) * MIN15, o, h, l, c, 100])
    # Newest: pierce 105 to 108, reclaim-close 102
    out.append([base_ts + 38 * MIN15, 107.5, 108.0, 101.5, 102.0, 200])
    return out

def mk_1h_hold_long():
    """12 1h candles trending up: close > ema, no lower-highs."""
    base = 1_700_000_000_000 - (1_700_000_000_000 % HOUR) - 12 * HOUR
    out = []
    px = 100.0
    for i in range(12):
        px += 0.5
        out.append([base + i * HOUR, px - 0.2, px + 0.4, px - 0.3, px + 0.2, 1000])
    return out

def mk_1h_flip_long():
    """12 1h candles: uptrend then last 3 candles roll over (lower highs + close under EMA)."""
    base = 1_700_000_000_000 - (1_700_000_000_000 % HOUR) - 12 * HOUR
    out = []
    px = 100.0
    for i in range(9):
        px += 1.0
        out.append([base + i * HOUR, px - 0.2, px + 0.6, px - 0.3, px + 0.4, 1000])
    # 3 rolling-over candles, each with lower highs and lower closes
    highs = [108.0, 106.0, 104.0]
    closes = [107.0, 104.5, 100.5]
    for k in range(3):
        i = 9 + k
        out.append([base + i * HOUR, closes[k-1] if k > 0 else 109.4, highs[k],
                    closes[k] - 0.5, closes[k], 1000])
    return out

FIX = os.path.join(os.path.dirname(os.path.abspath(__file__)), "tests/fixtures/parity")
os.makedirs(FIX, exist_ok=True)

def run():
    fixtures = {}

    c = mk_candles_long_rejection()
    r = detect_sweep_15m(c, "none", 0.01)
    assert r is not None and r.direction == "long" and r.mode == "rejection", f"long rejection failed: {r}"
    fixtures["sweep_15m_long_rejection.json"] = {
        "candles_15m": c, "htf_bos_state": "none", "tick": 0.01,
        "expected": {
            "direction": "long", "mode": "rejection",
            "entry": r.entry, "stop": r.stop, "swept_level": r.swept_level,
            "level_source": r.level_source, "entry_tf": "15m",
        },
    }

    c = mk_candles_short_rejection()
    r = detect_sweep_15m(c, "none", 0.01)
    assert r is not None and r.direction == "short" and r.mode == "rejection", f"short rejection failed: {r}"
    fixtures["sweep_15m_short_rejection.json"] = {
        "candles_15m": c, "htf_bos_state": "none", "tick": 0.01,
        "expected": {
            "direction": "short", "mode": "rejection",
            "entry": r.entry, "stop": r.stop, "swept_level": r.swept_level,
            "level_source": r.level_source, "entry_tf": "15m",
        },
    }

    c = mk_1h_hold_long()
    m = evaluate_1h_momentum(c, "long")
    assert m.favorable is True, f"hold long failed: {m}"
    fixtures["sweep_1h_momentum_hold.json"] = {
        "candles_1h": c, "direction": "long", "ema_len": 9,
        "expected": {"favorable": True, "reason": "favorable"},
    }

    c = mk_1h_flip_long()
    m = evaluate_1h_momentum(c, "long")
    assert m.favorable is False, f"flip long failed: {m}"
    fixtures["sweep_1h_momentum_flip.json"] = {
        "candles_1h": c, "direction": "long", "ema_len": 9,
        "expected": {"favorable": False, "reason": m.reason},
    }

    for name, data in fixtures.items():
        with open(os.path.join(FIX, name), "w") as f:
            json.dump(data, f, indent=2)
        print("wrote", name)

if __name__ == "__main__":
    run()
