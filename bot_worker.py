"""Autonomous TurtleBot market worker.

Reads configuration and kill switches through authenticated worker-ingest.
Evaluates closed-candle signals using each venue's own public market data.
Independent venues scan concurrently; same-venue work remains serialized.
Every canonical decision is recorded. Eligible live decisions pass execution
checks and a replay-protected broker request to the private signer; the signer
reserves database intents before venue mutations and repeats account checks.

No administrative database key or private wallet key is held by this worker.
LIVE_TRADING_ENABLED alone does not authorize trading: configured ownership,
permissions, venue gates, explicit mandate leverage and database admission
must also pass. Sweep live campaign parity is still explicitly blocked.

Scout Guardian records paper risk directives and decisions. It does not sign
live exits; live management belongs to the venue/signer reconciliation path.
"""

import hashlib
import hmac
import json
import logging
import os
import re
import socket
import ssl
import time
from typing import Any, Callable, Mapping, Optional
from urllib.parse import urlparse

import requests
from dotenv import load_dotenv
# The Supabase Python client is imported for backward compatibility with
# tests that patch `bot_worker.create_client`. The worker itself no longer
# constructs a PostgREST client: the ONLY privileged path is the signed
# worker-ingest edge function. Any code that uses the imported `create_client`
# would re-open the anon read surface the kill-switch hardening closed.
from supabase import create_client  # noqa: F401  (compat re-export only)

import uuid
import threading
from concurrent.futures import ThreadPoolExecutor

_WORKER_STATE_LOCK = threading.RLock()

import accumulator_signal
import accumulator_sizing
import accumulator_live_size
import decision_contract
import decision_reducer
import entry_eligibility
import safety_checks
import hunter_entry
import sweep_entry
import sweep_htf_gate

import live_eligibility
import market_data
import aster_market_data
import aster_worker_execution
import synfutures_market_data
import synfutures_worker_execution
from order_identity import entry_order_key
import pilot_sizing
import scout_guardian
import worker_live_wiring as _live
from worker_ingest_client import (
    WorkerIngestAuthError,
    WorkerIngestClient,
    WorkerIngestConfigError,
    WorkerIngestTransientError,
)
from shared.parity_constants import get as parity_get
from shared.orchestration_policy import bucket_start_ms

load_dotenv()
logging.basicConfig(level=logging.INFO, format="%(asctime)s - %(levelname)s - %(message)s")


# ---------------------------------------------------------------------------
# Running revision reporting
# ---------------------------------------------------------------------------
# Railway sets RAILWAY_GIT_COMMIT_SHA automatically on GitHub-linked deploys;
# WORKER_VERSION is the explicit owner-set override and wins when present.
# The resolved value is reported on every heartbeat as `version`, so the
# running commit SHA is observable from `public.worker_heartbeats`.
_WORKER_VERSION_VARS = ("WORKER_VERSION", "RAILWAY_GIT_COMMIT_SHA")


def resolve_worker_version() -> Optional[str]:
    """Returns the running revision identifier, or None if unset."""
    for name in _WORKER_VERSION_VARS:
        value = (os.environ.get(name) or "").strip()
        if value:
            return value[:64]
    return None


def log_worker_version() -> Optional[str]:
    """Logs which env var supplied the running revision (name, not secret)."""
    for name in _WORKER_VERSION_VARS:
        value = (os.environ.get(name) or "").strip()
        if value:
            logging.info("Worker version source var=%s version=%s", name, value[:64])
            return value[:64]
    logging.warning(
        "Worker version unknown: set WORKER_VERSION on the Railway worker service "
        "to the deployed commit SHA so heartbeats report the running revision."
    )
    return None





# ---------------------------------------------------------------------------
# Config validation
# ---------------------------------------------------------------------------
class ConfigValidationError(Exception):
    """Raised when a required env var is missing or malformed. The message
    identifies the env-var NAME only — never its value."""


_PLACEHOLDER_RE = re.compile(r"\$\{|\$[A-Z_]+|<[^>]+>|SUPABASE_PROJECT_ID", re.IGNORECASE)
_HOSTNAME_RE = re.compile(
    r"^[A-Za-z0-9]([A-Za-z0-9\-]{0,61}[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9\-]{0,61}[A-Za-z0-9])?)+$"
)

# DNS retry schedule (seconds between attempts). Bounded exponential backoff.
DNS_RETRY_DELAYS = [0, 2, 4, 8, 16, 30]  # 6 attempts total
DNS_MAX_ATTEMPTS = len(DNS_RETRY_DELAYS)

# How often to recheck connectivity while in demo mode.
DEMO_RECHECK_INTERVAL_SEC = 60

# Reasonable network timeouts for Supabase operations (connect, read).
SUPABASE_TIMEOUT = (5, 10)
BROKER_ORDER_TIMEOUT = (5, 60)

# Owner-controlled live-trading switch. When "true" AND the worker successfully
# activates its ingest client, the worker enters `mode="live"` and stamps
# `is_live=true` on every intent it submits to the broker. Defense-in-depth:
# the signer and broker independently gate execution via
# APEX_MAINNET_SIGNER_ENABLED / APEX_MAINNET_CANARY_ENABLED, so this flag alone
# does not route real orders — all three must be true.
LIVE_TRADING_ENABLED = os.environ.get("LIVE_TRADING_ENABLED", "false").strip().lower() == "true"
logging.info(
    "Worker startup: LIVE_TRADING_ENABLED=%s (%s)",
    LIVE_TRADING_ENABLED,
    "will promote to live mode after ingest activation"
    if LIVE_TRADING_ENABLED
    else "worker will stay in paper mode (is_live=false on all intents)",
)

# Maximum clock skew (seconds) the `worker-ingest` edge function is expected
# to accept between the signed request timestamp and server time. Railway
# container drift beyond this window will surface as HMAC auth failures
# (HTTP 401 INVALID_SIGNATURE / CLOCK_SKEW), NOT as an explicit clock error.
# If HMAC auth starts failing shortly after a redeploy, suspect drift first
# before assuming key rotation. This constant does NOT change signing logic;
# it documents the contract with the edge function.
WORKER_INGEST_MAX_SKEW_SEC = 60

# Any guard response older than this (worker clock vs evaluated_at) is
# considered stale and fails closed. 30s chosen so a slow network hop does
# not become a bypass path while still tolerating one retry cycle. Decision
# needing owner ratification — see runbook.
EXECUTION_GUARD_MAX_AGE_SEC = 30


# ---------------------------------------------------------------------------
# Observational signal constants — see the module docstring. EXECUTES NOTHING.
# ---------------------------------------------------------------------------

# One shared orchestration contract: entry decisions use completed 15m bars;
# the Guardian independently supervises held positions every 5m. Neither
# interval is user-configurable, so a config row cannot make the two clocks
# drift apart.
SIGNAL_INTERVAL_MIN = int(parity_get("orchestration", "decision_interval_min"))
GUARDIAN_INTERVAL_MIN = int(parity_get("orchestration", "health_interval_min"))
SIGNAL_INTERVAL_SOURCE = "orchestration_policy"

# Only ApeX Omni is observed: market_data.py speaks that venue's public API
# and nothing else.
SIGNAL_EXCHANGE_TYPE = "apex_omni"

# CANONICAL repository spelling. `market_type` is the Postgres enum
# `account_mode`, whose only labels are 'spot' and 'futures' (verified against
# the live database). 'futures' is therefore this repository's perpetual
# value. No other spelling is accepted and none is invented: a 'spot' row is
# NOT silently treated as perpetual.
ACCEPTED_PERPETUAL_MARKET_TYPES = frozenset({"futures"})

# Both directions are evaluated and reported. The worker does NOT select a
# trading direction, and nothing here infers one from G33, S37, entries,
# market conditions, or configuration.
SIGNAL_DIRECTIONS = ("long", "short")

# Completed candles requested per observation. Bounded by the venue's verified
# 200 limit ceiling (market_data.MAX_NEED_PER_CALL == 198), and comfortably
# above the evaluator's own floor (48 lookback + 14 ATR + 15 EMA + 4 pivot
# shoulders + 6 retest window).
SIGNAL_NEED_CANDLES = market_data.MAX_NEED_PER_CALL

# ---------------------------------------------------------------------------
# Scout Guardian — Position Monitoring Layer constants.
# ---------------------------------------------------------------------------
# The Guardian is ALWAYS ON (no env flag; the six-var worker contract is
# unchanged). Each cycle it reads every open paper position, evaluates the pure
# deterministic rules in scout_guardian.py against public candles, records a
# decision per position (including HOLD) to onyx_decisions, and enqueues action
# directives (cancel unfilled rungs / force-close) that the paper engine
# enforces. It signs nothing and mutates no position row.
GUARDIAN_NEED_CANDLES = SIGNAL_NEED_CANDLES
# Server caps GUARDIAN_DECISION_INSERT / _DIRECTIVE_UPSERT at 100 items; chunk
# below that with headroom so a single 32KB body is never at risk.
GUARDIAN_BATCH_SIZE = 50

# Dedup cache bound, measured in COMPLETED CANDLES (not entries, not bytes).
# 24 x 5m = 2 hours of history per (user, connection, symbol, interval). The
# loop sleeps 15s, so ~20 iterations fall inside one candle; this only needs
# to outlive a candle by a wide margin. The cache is pruned against this bound
# on every observation, so it cannot grow without limit.
SIGNAL_DEDUP_MAX_CANDLES = 24

# Hard caps for the bounded projection.
SIGNAL_MAX_ENTRY_SUMMARIES = 3
SIGNAL_DETAIL_SOFT_LIMIT_BYTES = 3072   # drop optional summaries above this
SIGNAL_DETAIL_HARD_LIMIT_BYTES = 4096   # edge function MAX_METADATA_BYTES
SIGNAL_ERROR_TEXT_MAX_CHARS = 200

SIGNAL_RETEST_STATES = ("confirmed", "expired_window", "expired_breach", "pending")


# ---------------------------------------------------------------------------
# Canonical decision path constants.
# ---------------------------------------------------------------------------
# Leg the worker falls back to when `entry_gate` itself raised and produced no
# routing. Matches the pre-refactor behaviour: the Accumulator evaluator runs
# for a None armed_leg, and the gate failure alone denies authorization.
DEFAULT_STRATEGY = "accumulator"

from shared.turtle_strategy_ownership import resolve_strategy_turtle

def executing_turtle(cfg: Optional[dict], armed_leg: Optional[str]) -> Optional[str]:
    if not isinstance(cfg, dict):
        return None
    strategy = armed_leg or DEFAULT_STRATEGY
    params = cfg.get("params")
    if not isinstance(params, dict) or "enabled_turtles" not in params:
        return resolve_strategy_turtle(strategy)
    enabled = params.get("enabled_turtles")
    if not isinstance(enabled, list):
        return None
    return resolve_strategy_turtle(strategy, enabled)


def routed_turtle_enabled(cfg: Optional[dict], armed_leg: Optional[str]) -> bool:
    """Authorize the execution agent, independently of the strategy detector.

    Sweep can execute inside the selected Accumulator or Sniper. Preserve
    Sniper ownership when selected; never enable an unselected Turtle.
    Rows without an explicit mandate retain their legacy routing behavior.
    """
    if not isinstance(cfg, dict):
        return False
    params = cfg.get("params")
    if not isinstance(params, dict) or "enabled_turtles" not in params:
        return True
    return executing_turtle(cfg, armed_leg) is not None

# Customer-selectable leverage range on ApeX.
#
# 1 is the floor, not 0: ApeX has no 0x leverage — 0 would be "no position",
# which is expressed by not trading, not by a leverage value. `pilot_leverage`
# has always applied `max(1, ...)`, so 0 silently became 1; the UI should not
# offer a value that means something different from what it says.
#
# 100 is the ceiling and it is NOT redefined here — it is read from the same
# ratified `pilot.max_leverage` in shared/mainnet_parity_constants.json that
# the broker translator and the signer use. A second literal would be exactly
# the drift these constants exist to prevent.
MIN_SELECTABLE_LEVERAGE = 1
MAX_SELECTABLE_LEVERAGE = pilot_sizing.MAX_LEVERAGE


def _requested_leverage(cfg: Optional[dict]) -> Optional[int]:
    """The customer's chosen leverage from `active_bot_config.params`.

    Returns None when nothing usable is configured, which preserves the
    previous default (the pilot ceiling) rather than refusing. An unreadable
    preference is missing information, never a reason to stop a trade.

    The value is only ever clamped DOWNWARD from here: `plan_entry_size`
    applies the live venue ceiling and the pilot ceiling, and the signer
    clamps again to 1..100. Nothing in this path can raise leverage above
    what the venue and the ratified constants already allow.
    """
    params = (cfg or {}).get("params")
    if not isinstance(params, Mapping):
        return None
    raw = params.get("leverage")
    if isinstance(raw, bool) or raw is None:
        return None
    try:
        value = int(float(raw))
    except (TypeError, ValueError, OverflowError):
        return None
    if value < MIN_SELECTABLE_LEVERAGE:
        # Below the venue floor is not a refusal — it is a preference we
        # cannot honour literally. Take the floor and let the trade proceed.
        return MIN_SELECTABLE_LEVERAGE
    return min(value, MAX_SELECTABLE_LEVERAGE)
ACCUMULATOR_LEGS = frozenset({"accumulator", "vanguard"})

# H2 take-profit ladder. UNCHANGED from the three pre-refactor bridges
# (50/30/20 at 1.75/2.0/2.5R) and forwarded verbatim to the signer, which
# tick-rounds each trigger. This is the ratified TP policy — do not retune it
# here; `tests/test_signer_contract_parity.py` pins the exact literal.
STRATEGY_TP_TIERS = (
    {"rr_multiple": 1.75, "size_frac": 0.5},
    {"rr_multiple": 2.0,  "size_frac": 0.3},
    {"rr_multiple": 2.5,  "size_frac": 0.2},
)
# Owner-triggered proof-of-life canary size ONLY. This is NOT a strategy
# sizing input: every strategy leg (Accumulator, Vanguard, Hunter, Sweep)
# derives its size from `accumulator_live_size.plan_entry_size` and REFUSES
# when it cannot. Do not reintroduce this constant on a dispatch path.
CANARY_ORDER_SIZE = 0.001


# Default symbol for the two OWNER-TRIGGERED TEST commands (proof-of-life and
# strategy test). ETH, not BTC, and deliberately so:
#
#   * The signer's preflight refuses a symbol that already carries an open
#     order or position (EXISTING_OPEN_ORDER / EXISTING_OPEN_POSITION). BTC
#     carries live exposure, so a BTC test order fails before it can prove
#     anything — the test can never run while a BTC position is open.
#   * A test should also risk the least capital that still exercises the real
#     path, and one venue step of ETH is a far smaller notional than one step
#     of BTC.
#
# The owner can still target any symbol explicitly: `worker_commands.symbol`
# overrides this, so SOL or anything else is one field away.
TEST_ORDER_SYMBOL = "ETH-USDT"

# Completed candles carried inside a decision's immutable evidence. Bounded so
# one decision row can never grow without limit; wide enough that the AI
# committee sees real structure rather than a summary.
DECISION_CONTEXT_CANDLES = 60

# Durable execution states for one decision. Monotonic — the server refuses a
# backwards transition, so a late retry can never downgrade a recorded result.
EXECUTION_NOT_REACHED = "not_reached"
# "No information", never a verdict. Returned when the decision ledger could
# not be written or its op is not deployed. It must always behave as PROCEED:
# an audit write that failed is not evidence that a trade is unsafe.
EXECUTION_UNKNOWN = "unknown"
EXECUTION_BLOCKED = "blocked"
EXECUTION_INTENT_CREATED = "intent_created"
EXECUTION_SUBMITTED = "submitted"
EXECUTION_AMBIGUOUS = "ambiguous"
EXECUTION_REJECTED = "rejected"
EXECUTION_FILLED = "filled"




def validate_supabase_url_syntax(name: str = "SUPABASE_URL") -> str:
    """Validate the URL's shape only — no DNS. Never logs the value."""
    raw = os.environ.get(name)
    if raw is None or raw == "":
        raise ConfigValidationError(f"{name} is not set")

    if raw != raw.strip():
        raise ConfigValidationError(f"{name} has surrounding whitespace")
    if any(ch in raw for ch in (' ', '\t', '\n', '\r', '"', "'", '`')):
        raise ConfigValidationError(f"{name} contains quotes or whitespace characters")
    if _PLACEHOLDER_RE.search(raw):
        raise ConfigValidationError(
            f"{name} appears to contain an unresolved variable reference or placeholder"
        )
    if not raw.startswith("https://"):
        raise ConfigValidationError(f"{name} must start with https://")

    parsed = urlparse(raw)
    if parsed.scheme != "https":
        raise ConfigValidationError(f"{name} must use https scheme")
    if not parsed.hostname:
        raise ConfigValidationError(f"{name} has no hostname")
    if parsed.path not in ("", "/"):
        raise ConfigValidationError(f"{name} must not contain a path")
    if not _HOSTNAME_RE.match(parsed.hostname):
        raise ConfigValidationError(f"{name} hostname is not a valid DNS name")

    return raw


def resolve_dns_with_retry(
    hostname: str,
    resolver: Callable[[str, int], Any] = socket.getaddrinfo,
    sleep: Callable[[float], None] = time.sleep,
    delays: Optional[list[int]] = None,
) -> tuple[bool, Optional[str]]:
    """Attempt DNS resolution with bounded exponential backoff.

    Returns (ok, error_category). Logs hostname + attempt number only.
    Never logs env-var values, keys, or secrets.
    """
    schedule = delays if delays is not None else DNS_RETRY_DELAYS
    last_err_cat: Optional[str] = None
    for i, delay in enumerate(schedule, start=1):
        if delay > 0:
            sleep(delay)
        try:
            resolver(hostname, 443)
            if i > 1:
                logging.info("DNS resolved for host=%s on attempt %d/%d", hostname, i, DNS_MAX_ATTEMPTS)
            return True, None
        except socket.gaierror as e:
            last_err_cat = f"DNS_GAIERROR_{e.errno}"
            logging.warning(
                "DNS resolution failed for host=%s attempt=%d/%d category=%s",
                hostname, i, len(schedule), last_err_cat,
            )
        except Exception as e:  # pragma: no cover - defensive
            last_err_cat = f"DNS_{type(e).__name__}"
            logging.warning(
                "DNS resolution errored for host=%s attempt=%d/%d category=%s",
                hostname, i, len(schedule), last_err_cat,
            )
    return False, last_err_cat or "DNS_UNKNOWN"


def classify_supabase_error(exc: BaseException) -> str:
    """Map an exception to a sanitized category label."""
    if isinstance(exc, socket.gaierror):
        return "DNS_FAILURE"
    if isinstance(exc, ssl.SSLError):
        return "TLS_FAILURE"
    if isinstance(exc, (socket.timeout, requests.exceptions.Timeout)):
        return "TIMEOUT"
    if isinstance(exc, requests.exceptions.ConnectionError):
        # ConnectionError may wrap a gaierror
        args = getattr(exc, "args", ()) or ()
        inner = args[0] if args else None
        if isinstance(inner, Exception) and isinstance(getattr(inner, "reason", None), socket.gaierror):
            return "DNS_FAILURE"
        return "CONNECTION_ERROR"
    if isinstance(exc, requests.exceptions.HTTPError):
        status = getattr(getattr(exc, "response", None), "status_code", None)
        if status in (401, 403):
            return "AUTH_FAILURE"
        return f"HTTP_{status or 'UNKNOWN'}"
    return f"OTHER_{type(exc).__name__}"


def is_legacy_jwt_key(key: str) -> bool:
    """Legacy Supabase anon/service JWTs have exactly three dot-separated
    base64url segments. New-format keys (sb_publishable_ / sb_secret_) are
    opaque strings and MUST NOT be sent as an OAuth-style Bearer JWT —
    PostgREST rejects them with 'Expected 3 parts in JWT; got 1'."""
    if not key:
        return False
    if key.startswith(("sb_publishable_", "sb_secret_")):
        return False
    return key.count(".") == 2


def supabase_auth_headers(key: str) -> dict:
    """Build headers PostgREST accepts for either key format.
    - Legacy JWT: apikey + Authorization: Bearer <jwt>
    - New opaque key: apikey only (Authorization Bearer would fail JWT parse)
    """
    headers = {"apikey": key}
    if is_legacy_jwt_key(key):
        headers["Authorization"] = f"Bearer {key}"
    return headers


def check_supabase_reachable(
    url: str,
    api_key: str,
    timeout: tuple = SUPABASE_TIMEOUT,
) -> tuple[bool, Optional[str]]:
    """PURE reachability probe against the Supabase host.

    Returns (ok, advisory) where:
      - ok=True means the host answered ANY HTTP status (including 401/403/5xx).
        Getting a status back is itself positive proof the gateway is up.
        `advisory` is a sanitized `HTTP_<status>` string for logging only —
        it MUST NEVER be used to gate mode transitions.
      - ok=False only when no HTTP response was received: DNS failure, TLS
        failure, timeout, or connection error. `advisory` is the category.

    Body content is NEVER inspected for reachability purposes. Keys, headers,
    and full URLs are NEVER logged.

    IMPORTANT: A 401 "Secret API key required" from `/rest/v1/` is EXPECTED
    when calling with a publishable key — that PostgREST OpenAPI root is
    admin-only by design. Do NOT treat it as an auth failure at this layer.
    Authorization is the exclusive concern of the signed `worker-ingest`
    heartbeat probe in `_activate_live_client()`.
    """
    endpoint = f"{url.rstrip('/')}/rest/v1/"
    try:
        r = requests.get(endpoint, headers=supabase_auth_headers(api_key), timeout=timeout)
    except Exception as e:
        return False, classify_supabase_error(e)
    # ANY HTTP response = reachable. Status is advisory only.
    return True, f"HTTP_{r.status_code}"



# ---------------------------------------------------------------------------
# Observational signal helpers — pure, no I/O, unit-testable.
# ---------------------------------------------------------------------------
def normalize_signal_symbol(symbol: str) -> str:
    """Venue wire form. `active_bot_config.symbol` is dashed ('BTC-USDT');
    market_data.klines_raw strips the dash before sending, and the parser
    compares row `s` against the stripped form. Normalizing here keeps the
    dedup key and the observation_id aligned with what ApeX actually echoed."""
    return symbol.replace("-", "")


def signal_candle_bucket_ms(now_ms: int, interval_min: int = SIGNAL_INTERVAL_MIN) -> int:
    """The open timestamp of the candle currently forming at `now_ms`.

    Used ONLY as the dedup/observation key for `skipped` and `error` outcomes,
    where no completed candle exists to key on. It bounds those paths to one
    event per interval instead of one per 15s loop iteration, and lets them
    share the same eviction rule as evaluated observations. It is never used
    as, or reported as, a completed candle timestamp.
    """
    return bucket_start_ms(now_ms, interval_min)


def build_observation_id(
    user_id: str,
    connection_id: str,
    normalized_symbol: str,
    interval_min: int,
    candle_ts_ms: int,
) -> str:
    """Deterministic id over exactly (user, connection, symbol, interval,
    newest completed candle ts). Stable across restarts, which is what makes
    downstream dedup possible when a restart re-emits the current candle.

    Plain lowercase hex, NO `0x` prefix: the edge function rejects any payload
    matching /0x[a-fA-F0-9]{40,}/ outright as a suspected secret.
    """
    raw = "|".join([
        str(user_id), str(connection_id), str(normalized_symbol),
        str(interval_min), str(candle_ts_ms),
    ])
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()[:32]


def signal_result_hash(directions: dict) -> str:
    """Deterministic hash of the EVALUATOR OUTPUT only.

    Deliberately excludes evaluated_at and age_sec: those move every cycle, so
    including them would make every comparison a mismatch and defeat the
    change-detection this exists for.
    """
    blob = json.dumps(directions, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(blob.encode("utf-8")).hexdigest()[:16]


def _retest_state_counts(result: dict) -> dict:
    counts = {s: 0 for s in SIGNAL_RETEST_STATES}
    for r in result.get("retests", []) or []:
        state = getattr(r, "state", None)
        if state in counts:
            counts[state] += 1
    return counts


# Live-intent freshness bound for the Accumulator bridge. A completed candle
# older than this is stale market data and MUST NOT create an order, even if
# the evaluator still calls it "newest". Two intervals: one for the candle
# itself, one for cycle jitter.
SIGNAL_LIVE_MAX_CANDLE_AGE_MS = 2 * SIGNAL_INTERVAL_MIN * 60_000

# Sane bounds on the structural stop distance derived from the frozen zone.
# Outside these the geometry is nonsense (zero-width zone, or a zone so wide
# the "stop" is not an invalidation) and the intent is refused, never clamped.
ACCUM_MIN_STOP_PCT = 0.0005
ACCUM_MAX_STOP_PCT = 0.05


def accumulator_stop_pct(retest, candles) -> Optional[float]:
    """Structural stop distance (fraction of entry price) for a confirmed
    Accumulator retest, or None when it cannot be proven sane.

    Long : invalidation is a close below the frozen zone's lower edge.
    Short: mirror, above the upper edge.
    Reference price is the newest completed candle's close — the same candle
    the confirmation is anchored to. NEVER clamped: an out-of-bounds or
    non-finite result is a refusal.
    """
    try:
        close = float(candles[-1][accumulator_signal.CLOSE])
        zone = retest.break_event.zone
        direction = retest.break_event.direction
        level = float(zone.lower) if direction == "long" else float(zone.upper)
    except Exception:
        return None
    if not (close > 0) or not (level > 0):
        return None
    dist = (close - level) if direction == "long" else (level - close)
    if not (dist > 0):
        return None
    pct = dist / close
    if not (ACCUM_MIN_STOP_PCT <= pct <= ACCUM_MAX_STOP_PCT):
        return None
    return float(pct)


def summarize_direction(result: dict, max_entries: int = SIGNAL_MAX_ENTRY_SUMMARIES) -> dict:
    """Project one `accumulator_signal.evaluate()` return into bounded JSON.

    The evaluator returns frozen dataclasses (BreakEvent / RetestResult, each
    holding nested Swing and Zone). Those are NOT JSON-serializable and are
    never serialized: only counts, plus at most `max_entries` scalar entry
    summaries, cross the boundary. `zone_assumption` is carried through so a
    reader sees the evaluator's own unratified marker rather than a number
    presented as settled.
    """
    entries = list(result.get("entries", []) or [])
    summaries = []
    for r in entries[-max_entries:]:
        be = r.break_event
        summaries.append({
            "state": r.state,
            "direction": be.direction,
            "break_index": int(be.break_index),
            "break_ts_ms": int(be.break_ts),
            "retest_index": int(r.retest_index) if r.retest_index is not None else None,
            "retest_ts_ms": int(r.retest_ts) if r.retest_ts is not None else None,
            "zone_level": round(float(be.zone.level), 8),
            "zone_tolerance": round(float(be.zone.tolerance), 8),
            "zone_assumption": str(be.zone.assumption)[:48],
        })
    return {
        "candles": int(result.get("candles", 0)),
        "swings_raw": int(result.get("swings_raw", 0)),
        "swings_grouped": int(result.get("swings_grouped", 0)),
        "breaks": len(result.get("breaks", []) or []),
        "retests": len(result.get("retests", []) or []),
        "entries": len(entries),
        "retest_states": _retest_state_counts(result),
        "entry_summaries": summaries,
        "entry_summaries_truncated": len(entries) > max_entries,
    }


def _detail_len(detail: dict) -> int:
    """Match the edge function's own measure: JSON.stringify(detail).length,
    taken BEFORE it enriches with worker_id/source."""
    return len(json.dumps(detail, separators=(",", ":")))


def scout_guardian_bound(detail: dict) -> dict:
    """Keep a Guardian evidence/detail payload safely under the edge function's
    4KB MAX_METADATA_BYTES ceiling. Guardian evidence is a handful of scalars,
    so this is a defensive guard: if a payload somehow overruns, collapse it to
    its identifying fields rather than let the server reject the whole batch."""
    if not isinstance(detail, dict):
        return {}
    if _detail_len(detail) <= SIGNAL_DETAIL_HARD_LIMIT_BYTES:
        return detail
    return {
        "rule": detail.get("rule"),
        "rule_version": detail.get("rule_version"),
        "reason_code": "DETAIL_TRUNCATED",
    }


def bound_signal_detail(detail: dict) -> dict:
    """Enforce the 4KB MAX_METADATA_BYTES ceiling by shedding OPTIONAL content.

    Order of sacrifice: entry summaries first (explicitly optional — "only if
    space safely permits"), then everything but the identity fields. The
    identity fields and `execution_performed` are never dropped; an event that
    cannot state what it is would be worse than no event.
    """
    if _detail_len(detail) <= SIGNAL_DETAIL_SOFT_LIMIT_BYTES:
        return detail

    trimmed = dict(detail)
    dirs = trimmed.get("directions")
    if isinstance(dirs, dict):
        trimmed["directions"] = {
            name: {**d, "entry_summaries": [], "entry_summaries_omitted": True}
            for name, d in dirs.items()
        }
    if _detail_len(trimmed) <= SIGNAL_DETAIL_HARD_LIMIT_BYTES:
        return trimmed

    # Last resort: identity only. Never silently over-run the server limit.
    return {
        "status": detail.get("status"),
        "reason_code": "DETAIL_TRUNCATED",
        "observation_id": detail.get("observation_id"),
        "symbol": detail.get("symbol"),
        "interval_min": detail.get("interval_min"),
        "interval_source": detail.get("interval_source"),
        "newest_completed_candle_ts_ms": detail.get("newest_completed_candle_ts_ms"),
        "evaluated_at": detail.get("evaluated_at"),
        "execution_performed": False,
    }


def feed_error_reason_code(exc: BaseException) -> str:
    """Sanitized reason for an observational failure. Never mislabelled as a
    connectivity event, a config read, or an order result."""
    if isinstance(exc, market_data.FeedTransportError):
        return "FEED_TRANSPORT_ERROR"
    if isinstance(exc, market_data.FeedShapeError):
        return "FEED_SHAPE_ERROR"
    if isinstance(exc, market_data.FeedIntegrityError):
        return "FEED_INTEGRITY_ERROR"
    if isinstance(exc, ValueError):
        return "FEED_REQUEST_INVALID"
    return f"UNEXPECTED_{type(exc).__name__}"[:48]


# ---------------------------------------------------------------------------
# Worker
# ---------------------------------------------------------------------------
class RailwayTurtleBot:
    # Env-var precedence for the Supabase key used by this worker.
    #
    # STAGE 0.5 FORWARD-FIX: the worker MUST NOT hold any server-only
    # credential. `SUPABASE_SERVICE_ROLE_KEY` and `SUPABASE_SECRET_KEY` are
    # explicitly NOT accepted here — reintroducing them would silently
    # re-enable the removed legacy admin path. The publishable key is used
    # only for a non-privileged reachability probe against `/rest/v1/`;
    # authorization for every privileged operation comes exclusively from
    # the HMAC-signed `worker-ingest` edge function.
    _KEY_VAR_CANDIDATES = (
        "SUPABASE_PUBLISHABLE_KEY",    # new-format client key (sb_publishable_...)
        "SUPABASE_ANON_KEY",           # legacy anon JWT
        "VITE_SUPABASE_PUBLISHABLE_KEY",
    )

    # Any env var that would carry a server-only credential is a hard reject
    # here. A misconfigured deployment that stuffs an sb_secret_ / service-
    # role JWT into ANY variable the worker reads MUST be surfaced as an
    # error, never silently accepted. This is the runtime guard behind the
    # Stage 0.5 invariant "worker holds no admin credentials".
    _FORBIDDEN_KEY_VARS = frozenset({
        "SUPABASE_SERVICE_ROLE_KEY",
        "SUPABASE_SECRET_KEY",
    })

    @staticmethod
    def _classify_key(key: str) -> str:
        if not key:
            return "unknown"
        if key.startswith("sb_publishable_"):
            return "sb_publishable"
        if key.startswith("sb_secret_"):
            return "sb_secret"
        if is_legacy_jwt_key(key):
            return "legacy_jwt"
        return "unknown"

    def __init__(self) -> None:
        url_var = "SUPABASE_URL" if os.environ.get("SUPABASE_URL") else (
            "VITE_SUPABASE_URL" if os.environ.get("VITE_SUPABASE_URL") else "SUPABASE_URL"
        )
        self._url_var = url_var
        self.supabase_url: str = ""
        self.api_key: str = ""
        self._key_var: str = ""
        self.key_kind: str = "unknown"  # 'legacy_jwt' | 'sb_publishable' | 'unknown'
        # Inert compatibility attribute — never assigned to a real client.
        # Any code that reads it MUST treat None as "no privileged read path
        # here; use self.ingest.read_execution_guard()".
        self.supabase = None
        self._first_cycle_after_boot = True
        self._post_recovery_pending = False
        self.ingest: Optional[WorkerIngestClient] = None
        self.mode: str = "demo"
        self.credentials_ok: bool = False
        self.status_message: str = "starting"
        self._last_connectivity_check: float = 0.0
        self._failed_ingest_calls: int = 0
        # Observational signal state. In-memory ONLY — no table is authorised
        # (G32) and none is added. Cross-restart dedup is therefore NOT
        # promised; see observe_signal().
        self._signal_feed_client: Optional[market_data.ApexPublicFeed] = None
        self._aster_signal_feed_client: Optional[aster_market_data.AsterPublicFeed] = None
        self._signal_seen: dict[tuple, str] = {}
        # Hunter live-intent dedup keyed by (user, conn, symbol, direction,
        # fvg_confirm_ts). In-memory only; a restart may fire an intent that
        # was already fired against the same FVG. The broker's
        # idempotency_key (same tuple) makes that a no-op at the venue.
        self._hunter_fired: set[tuple] = set()
        # Symbols with a submit whose outcome was AMBIGUOUS. Scoped to
        # (user, connection, symbol) so BTC exposure can never block ETH.
        # Cross-restart duplicate protection does NOT live here — it lives in
        # the decision's durable `execution_state` — because an in-memory set
        # is exactly the guarantee a redeploy breaks.
        self._decision_inflight: set[tuple] = set()
        # decision_ids whose STRATEGY_DECISION activity event has already been
        # written. The 15s loop re-observes one 15m candle many times and the
        # decision is (correctly) recomputed on every pass, so without this the
        # activity feed gets ~20 identical rows per candle per connection.
        #
        # THIS SUPPRESSES A LOG LINE AND NOTHING ELSE. The decision upsert and
        # the whole execution path still run on every pass — that is what lets
        # a candle whose first pass failed still trade on a later one. Bounded
        # by SIGNAL_DEDUP_MAX_CANDLES worth of ids, evicted oldest-first.
        self._decision_logged: dict[str, None] = {}
        # Sweep live-intent dedup keyed by (user, conn, symbol, direction,
        # sweep_entry.dedup_key). Same in-memory scope as hunter.
        self._sweep_fired: set[tuple] = set()
        # Accumulator/Vanguard live-intent dedup keyed by
        # entry_eligibility.entry_key(...) + (user, conn, direction).
        # Timestamp-anchored, so a sliding window cannot re-admit an old
        # confirmation. Same in-memory scope as hunter/sweep; the broker's
        # idempotency_key (same tuple) makes a post-restart repeat a venue
        # no-op.
        self._accum_fired: set[tuple] = set()
        # Per-cycle venue contract cache (symbol -> config dict | None). ApeX
        # /api/v3/symbols is one HTTP call for the whole exchange; caching it
        # keeps the bridge from hitting the venue once per direction. Cleared
        # by _reset_venue_contract_cache() at the top of each signal pass so a
        # contract change is never held for more than a cycle.
        self._venue_contract_cache: dict[tuple[str, str], Optional[dict]] = {}

        # Guardian v2 — per-symbol consecutive no-market-data cycle counter.
        # At >= scout_guardian.STALE_DATA_CYCLES we emit a distinct
        # `data_stale` decision instead of a silent HOLD. Reset on any
        # healthy fetch. Bounded by the open universe size.
        self._guardian_stale_cycles: dict[str, int] = {}
        # One completed health pass per 5m supervision bucket. Failures do not
        # advance this marker, so the 15s worker loop can retry within the
        # same bucket without generating duplicate healthy decisions.
        self._last_guardian_bucket_ms: Optional[int] = None
        # Re-entry lockout set for the CURRENT cycle. Rebuilt once per
        # guardian_pass and consumed by every candidate entry. Empty until
        # the ingest client exposes a closed-trades read; safe default (no
        # lockout blocks a legitimate entry).
        self._current_lockout_set: set = set()

        # Syntax validation. Failures here can't be fixed by DNS retry.
        try:
            self.supabase_url = validate_supabase_url_syntax(url_var)
        except ConfigValidationError as e:
            self.status_message = f"Startup config validation failed: {e}. Running in demo mode."
            logging.error(self.status_message)
            return

        # Stage 0.5 invariant guard: if any forbidden server-only var is
        # present in the environment, refuse to boot into paper mode. The
        # worker MUST never carry admin credentials, even if not actively
        # consumed. Staying in demo mode makes the misconfiguration loud
        # and prevents the legacy transport from being silently reachable.
        forbidden_present = [n for n in self._FORBIDDEN_KEY_VARS if os.environ.get(n)]
        if forbidden_present:
            self.status_message = (
                "Forbidden server-only credential(s) present in worker "
                f"environment: {', '.join(sorted(forbidden_present))}. "
                "Stage 0.5 requires these to be removed from the worker "
                "service. Staying in demo mode (values never logged)."
            )
            logging.error(self.status_message)
            return
        # The worker-to-Railway-broker machine credential is allowed here.
        # WHAT DOES NOT CHANGE:
        # `_FORBIDDEN_KEY_VARS` still hard-rejects SUPABASE_SERVICE_ROLE_KEY
        # and SUPABASE_SECRET_KEY. The Railway broker authenticates the worker
        # with a dedicated replay-protected HMAC and holds no service-role key.
        # The worker therefore needs one order HMAC secret and never a database
        # administrator credential.
        # Pick the first configured, non-placeholder publishable key. Only
        # used for the non-privileged reachability probe below.
        for name in self._KEY_VAR_CANDIDATES:
            val = os.environ.get(name)
            if not val:
                continue
            if val != val.strip() or _PLACEHOLDER_RE.search(val):
                logging.error("Key env var %s looks unresolved or has whitespace; skipping.", name)
                continue
            kind = self._classify_key(val)
            # Extra defence: if somehow an sb_secret_ value ended up in a
            # publishable slot, refuse it. Publishable slots may hold ONLY
            # publishable / anon-JWT material.
            if kind == "sb_secret":
                logging.warning(
                    "Configuration warning: env var %s is a publishable slot "
                    "but contains a server-only key; skipping. "
                    "(value never logged)",
                    name,
                )
                continue
            self.api_key = val
            self._key_var = name
            self.key_kind = kind
            break

        if not self.api_key:
            self.status_message = (
                "No acceptable Supabase publishable key env var set. "
                "Expected one of: "
                + ", ".join(self._KEY_VAR_CANDIDATES)
                + ". Running in demo mode."
            )
            logging.error(self.status_message)
            return

        logging.info(
            "Supabase key source var=%s kind=%s (value never logged)",
            self._key_var, self.key_kind,
        )


        # DNS with bounded backoff. Networking may not be ready at boot.
        hostname = urlparse(self.supabase_url).hostname or ""
        ok, err_cat = resolve_dns_with_retry(hostname)
        if not ok:
            self.status_message = (
                f"DNS resolution failed after {DNS_MAX_ATTEMPTS} attempts "
                f"(category={err_cat}). Entering demo mode; will retry every "
                f"{DEMO_RECHECK_INTERVAL_SEC}s."
            )
            logging.error(self.status_message)
            return
        logging.info("DNS resolution OK host=%s", hostname)

        # Reachability probe — PURE transport check. Any HTTP response back
        # (including 401/403) proves the host is up. Authorization is NOT
        # decided here; that is the exclusive job of the signed worker-ingest
        # heartbeat below.
        ok, advisory = check_supabase_reachable(self.supabase_url, self.api_key)
        if not ok:
            self.status_message = (
                f"Supabase host unreachable (category={advisory}). "
                f"Entering demo mode; will retry every {DEMO_RECHECK_INTERVAL_SEC}s."
            )
            logging.error(self.status_message)
            return
        if advisory == "HTTP_401":
            logging.info(
                "Reachability OK (host answered %s on /rest/v1/ — admin-only "
                "endpoint, expected with publishable key; not a gate)",
                advisory,
            )
        else:
            logging.info("Reachability OK (host answered %s on /rest/v1/; advisory only)", advisory)

        # Signed worker-ingest is the SOLE readiness gate for paper mode.
        self._activate_live_client()

    # ------------------------------------------------------------------
    # Mode transitions
    # ------------------------------------------------------------------
    def _activate_live_client(self) -> None:
        """Enter paper mode via the privileged worker-ingest edge function.

        The Supabase publishable key is only used for the non-privileged
        connectivity check. All heartbeat/config/event traffic goes through
        the HMAC-authenticated worker-ingest edge function. If that secret
        is not provisioned, we stay in demo mode — publishable key is NOT
        authorization for writes.
        """
        try:
            self.ingest = WorkerIngestClient(self.supabase_url)
        except WorkerIngestConfigError as e:
            self.ingest = None
            self.credentials_ok = False
            self.mode = "demo"
            self.status_message = (
                f"worker-ingest not configured ({e}). Staying in demo mode. "
                "Set WORKER_INGEST_SHARED_SECRET on Railway to enable paper mode."
            )
            logging.error(self.status_message)
            return

        # Probe with a signed heartbeat AND a signed config read. Both must
        # succeed to promote to paper mode. An empty config list from the
        # config read IS a valid success (no active configs is fine).
        try:
            self.ingest.heartbeat(status="starting", mode="paper", version=resolve_worker_version())
            logging.info("worker-ingest heartbeat auth OK")
            configs = self.ingest.read_active_config()
            logging.info("worker-ingest ACTIVE_CONFIG_READ OK (count=%d)", len(configs))
        except WorkerIngestAuthError as e:
            self.ingest = None
            self.credentials_ok = False
            self.mode = "demo"
            self.status_message = f"worker-ingest auth rejected (category={e}). Staying in demo mode."
            logging.error(self.status_message)
            return
        except WorkerIngestTransientError as e:
            self.ingest = None
            self.credentials_ok = False
            self.mode = "demo"
            self.status_message = f"worker-ingest transient failure (category={e}). Staying in demo mode."
            logging.error(self.status_message)
            return

        # NOTE: no `self.supabase` client is constructed. The publishable key
        # is authorization for NOTHING. The kill-switch read now goes through
        # the signed EXECUTION_GUARD_READ operation of worker-ingest.

        prev_mode = self.mode
        # Owner-controlled promotion. Ingest activation succeeded; if the
        # owner has flipped LIVE_TRADING_ENABLED=true on this worker, enter
        # live mode. Otherwise stay in paper (previous behavior).
        self.mode = "live" if LIVE_TRADING_ENABLED else "paper"
        self.credentials_ok = True
        self.status_message = f"Worker online ({self.mode})"
        logging.info(
            "Mode transition %s -> %s (LIVE_TRADING_ENABLED=%s, var=%s, host=%s)",
            prev_mode, self.mode, LIVE_TRADING_ENABLED,
            self._url_var, urlparse(self.supabase_url).hostname,
        )


    def try_recover(self) -> bool:
        """Called from the main loop while in demo mode. Re-runs DNS +
        reachability, then delegates authorization to _activate_live_client
        (signed worker-ingest). Returns True on successful recovery.

        Safe if __init__ returned early before selecting a key: `service_role`
        is initialized to "" at the top of __init__, so no AttributeError.
        """
        now = time.monotonic()
        if now - self._last_connectivity_check < DEMO_RECHECK_INTERVAL_SEC:
            return False
        self._last_connectivity_check = now

        if not self.supabase_url or not self.api_key:
            return False  # unrecoverable without config
        hostname = urlparse(self.supabase_url).hostname or ""

        # Single-attempt DNS check on recovery (loop already paces us).
        ok, err_cat = resolve_dns_with_retry(hostname, delays=[0])
        if not ok:
            logging.info("Demo-mode recheck: DNS still failing (category=%s) host=%s", err_cat, hostname)
            return False

        ok, advisory = check_supabase_reachable(self.supabase_url, self.api_key)

        if not ok:
            logging.info("Demo-mode recheck: host still unreachable (category=%s)", advisory)
            return False
        logging.info("Demo-mode recheck: host reachable (advisory=%s). Probing worker-ingest.", advisory)
        self._activate_live_client()
        if self.credentials_ok:
            # CHECKPOINT 5 — post-recovery. Do NOT auto-resume execution.
            # Force the next cycle to re-read config and re-read the guard for
            # every (user, connection) before any strategy work. `halted()`
            # already fetches fresh with no cache; this flag guarantees the
            # main loop cannot skip the check on the recovery cycle.
            self._post_recovery_pending = True
            self._first_cycle_after_boot = True
        return self.credentials_ok

    # ------------------------------------------------------------------
    # Heartbeat + status
    # ------------------------------------------------------------------
    def report_heartbeat(self, message: Optional[str] = None) -> None:
        if not self.ingest:
            return
        health = {
            "note": (message or self.status_message)[:400],
            "credentials_ok": self.credentials_ok,
            "automation_requested": LIVE_TRADING_ENABLED,
            "order_transport_configured": (
                self._broker_secret() is not None and self._broker_base_url() is not None
            ),
        }
        try:
            self.ingest.heartbeat(
                status="healthy" if self.credentials_ok else "degraded",
                mode=self.mode, version=resolve_worker_version(), health=health,
            )
            self._failed_ingest_calls = 0
        except WorkerIngestAuthError as e:
            logging.error("Heartbeat rejected by ingest (category=%s). Demoting.", e)
            self._demote_to_demo(f"INGEST_AUTH_{e}")
        except WorkerIngestTransientError as e:
            logging.warning("Heartbeat transient failure category=%s", e)
            self._failed_ingest_calls += 1
            if self._failed_ingest_calls >= 5:
                self._demote_to_demo(f"INGEST_TRANSIENT_{e}")

    def _demote_to_demo(self, category: str) -> None:
        logging.warning("Demoting to demo mode due to category=%s", category)
        self.supabase = None
        self.ingest = None
        self.credentials_ok = False
        self.mode = "demo"
        self.status_message = f"Runtime connectivity lost (category={category}). In demo mode."
        self._last_connectivity_check = 0.0
        self._failed_ingest_calls = 0

    def log_event(
        self,
        user_id: Optional[str],
        code: str,
        message: str,
        payload: Optional[dict] = None,
    ) -> None:
        if not self.ingest:
            return
        try:
            self.ingest.emit_event(
                code=code, level="info", message=message,
                user_id=user_id, detail=payload or {},
            )
        except WorkerIngestAuthError as e:
            logging.warning("Event rejected category=%s code=%s", e, code)
        except WorkerIngestTransientError as e:
            logging.warning("Event transient failure category=%s", e)
        except Exception as e:
            # FAIL-CLOSED INTEGRITY. `log_event` is called from INSIDE
            # `halted()`'s exception handlers. If an unanticipated error from
            # the ingest client escaped here, it would propagate out of the
            # very handler that guarantees `return True` — and the guard would
            # raise instead of halting, at exactly the moment the transport is
            # already broken.
            #
            # A failed audit write must never defeat a halt. The halt decision
            # cannot depend on our ability to record it. Swallow and continue;
            # the caller still fails closed.
            logging.warning(
                "Event emit raised unexpectedly (category=%s code=%s); "
                "swallowed so the caller's fail-closed path is preserved.",
                type(e).__name__, code,
            )

    # ------------------------------------------------------------------
    # Config + kill switch
    # ------------------------------------------------------------------
    def fetch_active_configs(self) -> list[dict]:
        if not self.ingest:
            return []
        try:
            return self.ingest.read_active_config()
        except WorkerIngestAuthError as e:
            logging.error("active_bot_config read rejected category=%s", e)
            self._demote_to_demo(f"INGEST_AUTH_{e}")
            return []
        except WorkerIngestTransientError as e:
            logging.warning("active_bot_config transient failure category=%s", e)
            self._failed_ingest_calls += 1
            if self._failed_ingest_calls >= 5:
                self._demote_to_demo(f"INGEST_TRANSIENT_{e}")
            return []



    # Guard-response reason codes surface exactly what the edge function
    # returned. Anything not in this set is unknown → fail closed.
    _GUARD_REASON_CODES = frozenset({
        "GLOBAL_HALT", "USER_HALT", "CONNECTION_HALT",
        "DAILY_LOSS_LIMIT", "NO_GUARD_RECORD",
    })

    def halted(self, user_id: str, connection_id: str) -> bool:
        """FAIL-CLOSED kill-switch read via signed EXECUTION_GUARD_READ.

        Any of the following resolves to halted=True immediately, with NO
        retry tolerance and NO promotion to demo mode from this call:
          worker-ingest unavailable, timeout, invalid/malformed response,
          invalid HMAC, auth failure (401/403), worker revoked,
          key-version mismatch, stale response, missing guard record,
          unknown guard state, database error, 429, 5xx.

        A worker that can heartbeat but cannot read the guard is
        "healthy-and-halted", not disconnected. Do NOT bump
        `_failed_ingest_calls` here or demote to demo — the general
        five-failure ingest demotion threshold is intentionally NOT applied
        to guard failures.
        """
        if not self.ingest:
            self.log_event(
                user_id, "KILL_SWITCH_FAIL_CLOSED",
                "No worker-ingest client; treating as halted.",
                {"connection_id": connection_id, "reason": "NO_INGEST_CLIENT"},
            )
            return True
        try:
            resp = self.ingest.read_execution_guard(
                user_id=user_id, connection_id=connection_id,
            )
        except WorkerIngestAuthError as e:
            self.log_event(
                user_id, "KILL_SWITCH_FAIL_CLOSED",
                "Guard auth/schema rejection; halted.",
                {"connection_id": connection_id, "category": str(e)},
            )
            return True
        except WorkerIngestTransientError as e:
            self.log_event(
                user_id, "KILL_SWITCH_FAIL_CLOSED",
                "Guard transport failure; halted.",
                {"connection_id": connection_id, "category": str(e)},
            )
            return True
        except Exception as e:
            self.log_event(
                user_id, "KILL_SWITCH_FAIL_CLOSED",
                "Guard read raised unexpected exception; halted.",
                {"connection_id": connection_id, "error": type(e).__name__},
            )
            return True

        # Response validation. Any missing/bad field fails closed.
        if not isinstance(resp, dict):
            self.log_event(
                user_id, "KILL_SWITCH_FAIL_CLOSED",
                "Guard response not an object; halted.",
                {"connection_id": connection_id, "reason": "MALFORMED_RESPONSE"},
            )
            return True
        gv = resp.get("guard_version")
        halted_val = resp.get("halted")
        evaluated_at = resp.get("evaluated_at")
        reason_code = resp.get("reason_code")
        if gv != "v1":
            self.log_event(
                user_id, "KILL_SWITCH_FAIL_CLOSED",
                "Guard version mismatch; halted.",
                {"connection_id": connection_id, "reason": "GUARD_VERSION_MISMATCH"},
            )
            return True
        if not isinstance(evaluated_at, str):
            self.log_event(
                user_id, "KILL_SWITCH_FAIL_CLOSED",
                "Missing evaluated_at; halted.",
                {"connection_id": connection_id, "reason": "MALFORMED_RESPONSE"},
            )
            return True
        try:
            # ISO8601 UTC (edge sends new Date().toISOString() => trailing 'Z').
            from datetime import datetime, timezone
            ts = evaluated_at.replace("Z", "+00:00")
            evaluated_dt = datetime.fromisoformat(ts)
            if evaluated_dt.tzinfo is None:
                evaluated_dt = evaluated_dt.replace(tzinfo=timezone.utc)
            age = (datetime.now(timezone.utc) - evaluated_dt).total_seconds()
        except Exception:
            self.log_event(
                user_id, "KILL_SWITCH_FAIL_CLOSED",
                "Unparseable evaluated_at; halted.",
                {"connection_id": connection_id, "reason": "MALFORMED_RESPONSE"},
            )
            return True
        if age > EXECUTION_GUARD_MAX_AGE_SEC or age < -EXECUTION_GUARD_MAX_AGE_SEC:
            self.log_event(
                user_id, "KILL_SWITCH_FAIL_CLOSED",
                "Stale guard response; halted.",
                {"connection_id": connection_id, "reason": "STALE_RESPONSE", "age_sec": int(age)},
            )
            return True
        if halted_val is True:
            code = reason_code if reason_code in self._GUARD_REASON_CODES else "NO_GUARD_RECORD"
            self.log_event(
                user_id, "EXECUTION_HALTED",
                f"Guard reports halted (reason_code={code}).",
                {"connection_id": connection_id, "reason_code": code},
            )
            return True
        if halted_val is False:
            return False
        # Unknown state
        self.log_event(
            user_id, "KILL_SWITCH_FAIL_CLOSED",
            "Guard returned unknown halted value; halted.",
            {"connection_id": connection_id, "reason": "UNKNOWN_STATE"},
        )
        return True

    # ------------------------------------------------------------------
    # Order transmission — RESTORED by owner authorization 2026-07-17.
    # ------------------------------------------------------------------
    # This is the single automated order transport. It targets the public
    # Railway broker, never the retired Supabase `execution-broker` function.
    #
    # SECURITY POSTURE, UNCHANGED:
    #   * authenticates by replay-protected HMAC over timestamp, nonce, path,
    #     and canonical body, keyed by BROKER_SIGNING_SECRET on the worker and
    #     WORKER_ORDER_SHARED_SECRET on the broker;
    #   * sends NO Authorization header and NO service-role key — the broker
    #     holds service-role in its own env and never accepts one from a
    #     caller;
    #   * `is_live` is controlled only by LIVE_TRADING_ENABLED, which defaults
    #     false. The broker and signer independently enforce their mainnet
    #     signer, canary, automation, ownership, and kill-switch gates.
    #   * the broker forwards only a strictly validated credential-free intent
    #     to the private signer. The signer repeats kill-switch, ownership,
    #     collateral, exposure, sizing, and idempotency checks.
    def _broker_secret(self) -> Optional[str]:
        v = os.environ.get("BROKER_SIGNING_SECRET")
        return v if v and v.strip() == v else None

    def _broker_base_url(self) -> Optional[str]:
        value = (
            os.environ.get("TURTLE_BROKER_BASE_URL")
            or os.environ.get("EXECUTION_BROKER_BASE_URL")
            or ""
        ).strip().rstrip("/")
        if not value:
            return None
        parsed = urlparse(value)
        if parsed.scheme not in ("https", "http") or not parsed.netloc:
            return None
        return value

    # ------------------------------------------------------------------
    # Proof-of-life trigger (see supabase/functions/worker-ingest handlers
    # WORKER_COMMAND_CLAIM / WORKER_COMMAND_COMPLETE and the
    # `worker_commands` table). Owner inserts a single row from the UI; the
    # server atomically flips it to `consumed` on claim, so this path CANNOT
    # double-fire. The worker then emits ONE minimum-size intent through the
    # normal submit path (`is_live` remains worker-flag controlled), reports
    # the sanitized outcome back to the row, and logs PROOF_OF_LIFE_ORDER.
    # ------------------------------------------------------------------
    def _maybe_fire_proof_of_life(self) -> None:
        try:
            cmd = self.ingest.claim_worker_command(command="test_order")
        except (WorkerIngestAuthError, WorkerIngestTransientError):
            return
        if not cmd or cmd.get("command") != "test_order":
            return

        command_id = str(cmd.get("id") or "")
        user_id = str(cmd.get("user_id") or "")
        params = cmd.get("params") if isinstance(cmd.get("params"), dict) else {}
        connection_id = str((params or {}).get("connection_id") or "")
        symbol = str(cmd.get("symbol") or TEST_ORDER_SYMBOL)
        correlation_id = str(cmd.get("correlation_id") or command_id)

        if not command_id:
            return
        if not user_id or not connection_id:
            self._complete_proof_of_life(
                command_id, status="failed",
                error_message="MISSING_USER_OR_CONNECTION",
            )
            return

        # Minimum-size market buy. The signer's canary clamp + 5% protection
        # scale the venue-side notional; we send a conservative floor here.
        # NOTE: leverage/reduce_only omitted deliberately — the signer chooses
        # safe defaults for the canary path.
        intent = {
            "user_id": user_id,
            "connection_id": connection_id,
            "venue": "apex_omni",
            "symbol": symbol,
            "side": "BUY",
            "order_type": "MARKET",
            "size": 0.001,
            "purpose": "proof_of_life",
            "idempotency_key": correlation_id,
        }

        try:
            outcome = self.submit_order_intent(intent)
        except Exception as e:
            self._complete_proof_of_life(
                command_id, status="failed",
                error_message=f"WORKER_EXCEPTION_{type(e).__name__}",
            )
            return

        sanitized = self._sanitize_proof_outcome(outcome)
        reject = sanitized.get("reject_reason")
        result_status = "completed" if not reject else "failed"
        self._complete_proof_of_life(
            command_id, status=result_status,
            result=sanitized, error_message=reject if reject else None,
        )
        try:
            self.log_event(
                user_id, "PROOF_OF_LIFE_ORDER",
                "Proof-of-life trade dispatched.",
                {
                    "command_id": command_id,
                    "connection_id": connection_id,
                    "symbol": symbol,
                    "outcome": sanitized,
                    "is_live": LIVE_TRADING_ENABLED,
                },
            )
        except Exception:
            pass

    # ------------------------------------------------------------------
    # Strategy-path test trigger (owner-directed). Uses the SAME broker
    # → signer → venue path as a real signal would (purpose=CREATE_ORDER,
    # attached stop, H2 TP ladder). No exemption flags. Size is clamped
    # to the signer's canary baseline.
    # ------------------------------------------------------------------
    def _maybe_fire_strategy_test(self) -> None:
        try:
            cmd = self.ingest.claim_worker_command(command="strategy_test")
        except (WorkerIngestAuthError, WorkerIngestTransientError):
            return
        if not cmd or cmd.get("command") != "strategy_test":
            return

        command_id = str(cmd.get("id") or "")
        user_id = str(cmd.get("user_id") or "")
        params = cmd.get("params") if isinstance(cmd.get("params"), dict) else {}
        connection_id = str((params or {}).get("connection_id") or "")
        side = str((params or {}).get("side") or "BUY").upper()
        if side not in ("BUY", "SELL"):
            side = "BUY"
        symbol = str(cmd.get("symbol") or TEST_ORDER_SYMBOL)
        correlation_id = str(cmd.get("correlation_id") or command_id)

        if not command_id:
            return
        if not user_id or not connection_id:
            self._complete_proof_of_life(
                command_id, status="failed",
                error_message="MISSING_USER_OR_CONNECTION",
            )
            return

        # SIZE IS THE SIGNER'S unless the owner names one.
        #
        # This path used to hardcode 0.001 — a BTC-shaped constant. Two things
        # were wrong with carrying it onto any other symbol:
        #   * 0.001 is below the venue minimum on most non-BTC contracts, so
        #     the test would be refused for a reason that says nothing about
        #     the strategy path it exists to exercise.
        #   * The TP ladder floors each tier onto the step grid, so at a
        #     one-step entry every tier rounds to zero and the ladder silently
        #     comes out empty. The strategy test therefore never actually
        #     tested the TP ladder it sends.
        # Omitting `size` hands sizing to the signer's ratified builder, which
        # reads the real stepSize/minOrderSize for the symbol and applies the
        # pilot clamp. `params.size` still overrides when the owner wants a
        # specific quantity.
        requested_size = (params or {}).get("size")

        # H2 TP ladder (matches sweep_h2 TP_TIERS shape 50/30/20 @ 1.75/2.0/2.5R).
        intent = {
            "user_id": user_id,
            "connection_id": connection_id,
            "venue": "apex_omni",
            "symbol": symbol,
            "side": side,
            "order_type": "MARKET",
            "purpose": "CREATE_ORDER",
            "idempotency_key": correlation_id,
            "tp_tiers": [dict(t) for t in STRATEGY_TP_TIERS],
        }
        try:
            if requested_size is not None and float(requested_size) > 0:
                intent["size"] = float(requested_size)
        except (TypeError, ValueError):
            pass

        try:
            outcome = self.submit_order_intent(intent)
        except Exception as e:
            self._complete_proof_of_life(
                command_id, status="failed",
                error_message=f"WORKER_EXCEPTION_{type(e).__name__}",
            )
            return

        sanitized = self._sanitize_proof_outcome(outcome)
        reject = sanitized.get("reject_reason")
        result_status = "completed" if not reject else "failed"
        self._complete_proof_of_life(
            command_id, status=result_status,
            result=sanitized, error_message=reject if reject else None,
        )
        try:
            self.log_event(
                user_id, "STRATEGY_TEST_ORDER",
                "Strategy-path test order dispatched.",
                {
                    "command_id": command_id,
                    "connection_id": connection_id,
                    "symbol": symbol,
                    "side": side,
                    "outcome": sanitized,
                    "is_live": LIVE_TRADING_ENABLED,
                },
            )
        except Exception:
            pass

    @staticmethod
    def _sanitize_proof_outcome(outcome: dict) -> dict:
        allowed = ("status", "exchange_order_id", "exchange_status",
                   "reject_reason", "ok", "built")
        return {k: outcome.get(k) for k in allowed if k in (outcome or {})}

    def _complete_proof_of_life(self, command_id: str, *, status: str,
                                result: Optional[dict] = None,
                                error_message: Optional[str] = None) -> None:
        try:
            self.ingest.complete_worker_command(
                command_id=command_id, status=status,
                result=result, error_message=error_message,
            )
        except (WorkerIngestAuthError, WorkerIngestTransientError):
            pass

    def _synfutures_protection_pass(self, configs: list[dict]) -> None:
        """Run native supervision even when entries/CEX credentials are paused.

        The private signer verifies account ownership and native venue state.
        Worker requests carry only scope; no size, key, entry or exit flags.
        """
        scopes={(c.get("user_id"),c.get("connection_id")) for c in configs
                if c.get("exchange_type")=="synfutures" and c.get("user_id") and c.get("connection_id")}
        if scopes:self._synfutures_monitor_scopes=scopes
        else:scopes=getattr(self,"_synfutures_monitor_scopes",set())
        secret=self._broker_secret(); base=self._broker_base_url()
        if not secret or not base:return
        path="/v1/automation/synfutures/protect"
        for user_id,connection_id in sorted(scopes):
            raw=json.dumps({"user_id":user_id,"connection_id":connection_id},sort_keys=True,separators=(",",":")).encode()
            timestamp=str(int(time.time())); nonce=uuid.uuid4().hex
            signature=hmac.new(secret.encode(),b"\n".join([timestamp.encode(),nonce.encode(),path.encode(),raw]),hashlib.sha256).hexdigest()
            try:
                response=requests.post(base+path,data=raw,headers={"content-type":"application/json",
                    "x-worker-timestamp":timestamp,"x-worker-nonce":nonce,"x-worker-signature":signature,
                    "x-worker-signature-version":"raw-v1"},timeout=BROKER_ORDER_TIMEOUT)
                result=response.json()
                if response.ok and result.get("status")=="monitored":
                    resolved=result.get("resolved_campaign_keys",[])
                    pending=getattr(self,"_synfutures_pending_campaigns",{})
                    if isinstance(resolved,list) and all(isinstance(k,str) and 8<=len(k)<=64 for k in resolved):
                        for flight_key,campaign_key in list(pending.items()):
                            if flight_key[:2]==(user_id,connection_id) and campaign_key in resolved:
                                self._decision_inflight.discard(flight_key)
                                pending.pop(flight_key,None)
                if not response.ok or result.get("status")!="monitored":
                    logging.warning("SYNFUTURES_MONITOR_UNCONFIRMED connection_id=%s",connection_id)
            except Exception:
                # No retry inside the pass and no provider body/key in logs.
                logging.warning("SYNFUTURES_MONITOR_UNAVAILABLE connection_id=%s",connection_id)

    def submit_order_intent(self, intent: dict) -> dict:
        """POST a signed order intent to the Railway execution broker.

        Returns the broker's sanitized response. Raises nothing that carries
        credential material; failures are categorized, never echoed.
        """
        secret = self._broker_secret()
        if not secret:
            return {"ok": False, "reject_reason": "BROKER_SIGNING_SECRET_NOT_CONFIGURED"}
        base_url = self._broker_base_url()
        if not base_url:
            return {"ok": False, "reject_reason": "TURTLE_BROKER_BASE_URL_NOT_CONFIGURED"}

        # `is_live` is worker-flag controlled (LIVE_TRADING_ENABLED). The
        # signer and broker still independently gate live execution via
        # APEX_MAINNET_SIGNER_ENABLED / APEX_MAINNET_CANARY_ENABLED — this
        # flag alone does not route real orders.
        body = dict(intent)
        body["is_live"] = LIVE_TRADING_ENABLED

        raw = json.dumps(body, sort_keys=True, separators=(",", ":")).encode("utf-8")
        path = "/v1/automation/orders"
        timestamp = str(int(time.time()))
        nonce = uuid.uuid4().hex
        signed = b"\n".join(
            [timestamp.encode("utf-8"), nonce.encode("utf-8"), path.encode("utf-8"), raw]
        )
        sig = hmac.new(secret.encode("utf-8"), signed, hashlib.sha256).hexdigest()
        url = base_url + path
        headers = {
            "content-type": "application/json",
            "x-worker-timestamp": timestamp,
            "x-worker-nonce": nonce,
            "x-worker-signature": sig,
            "x-worker-signature-version": "raw-v1",
            # NO user Authorization header. Machine identity is HMAC only.
        }
        try:
            r = requests.post(url, data=raw, headers=headers, timeout=BROKER_ORDER_TIMEOUT)
        except requests.exceptions.RequestException as e:
            return {"ok": False, "status": "ambiguous", "reject_reason": f"NETWORK_{type(e).__name__}"}
        # Prefer the broker's sanitized JSON body (has reject_reason) over the
        # bare HTTP status. The broker returns 4xx with { ok:false,
        # reject_reason:"..." } for every gate rejection — surfacing the raw
        # status would hide the actual subcode from the UI.
        try:
            parsed = r.json()
        except ValueError:
            parsed = None
        if r.status_code >= 500:
            # Keep uncertainty (never retry an order from this response), but
            # retain a bounded machine reason so a preflight/storage failure
            # is diagnosable instead of becoming an opaque broker failure.
            code = parsed.get("reject_reason") if isinstance(parsed, dict) else None
            if not isinstance(code, str) or not re.fullmatch(r"[A-Z][A-Z0-9_]{0,95}", code):
                code = "BROKER_EXECUTION_UNKNOWN"
            return {"ok": False, "status": "ambiguous", "reject_reason": code}
        if isinstance(parsed, dict) and parsed.get("reject_reason"):
            parsed.setdefault("ok", False if r.status_code != 200 else True)
            return parsed
        if r.status_code != 200:
            # Broker auth/schema failures historically used `error` rather
            # than `reject_reason`. Preserve only bounded machine codes.
            code = parsed.get("error") if isinstance(parsed, dict) else None
            if isinstance(code, str) and re.fullmatch(r"[A-Z][A-Z0-9_]{0,95}", code):
                return {"ok": False, "reject_reason": code}
            return {"ok": False, "reject_reason": f"HTTP_{r.status_code}"}
        if not isinstance(parsed, dict):
            return {"ok": False, "status": "ambiguous", "reject_reason": "BAD_BROKER_RESPONSE"}
        return parsed

    # ------------------------------------------------------------------
    # Signal evaluation and guarded live execution
    # ------------------------------------------------------------------
    def _signal_feed(self) -> market_data.ApexPublicFeed:
        """Lazily built PUBLIC feed client. Holds no credential; the tick
        cache is the only state it carries between cycles."""
        if self._signal_feed_client is None:
            self._signal_feed_client = market_data.ApexPublicFeed()
        return self._signal_feed_client

    def _signal_feed_for(self, exchange_type: str):
        """Never evaluate an Aster row with ApeX prices or contract filters."""
        if exchange_type == "apex_omni":
            return self._signal_feed()
        if exchange_type == "aster":
            if getattr(self, "_aster_signal_feed_client", None) is None:
                self._aster_signal_feed_client = aster_market_data.AsterPublicFeed()
            return self._aster_signal_feed_client
        if exchange_type == "synfutures":
            if getattr(self, "_synfutures_signal_feed_client", None) is None:
                self._synfutures_signal_feed_client = synfutures_market_data.SynFuturesPublicFeed()
            return self._synfutures_signal_feed_client
        raise ValueError("UNSUPPORTED_SIGNAL_EXCHANGE")

    # ------------------------------------------------------------------
    # Live-sizing inputs for the Accumulator bridge
    # ------------------------------------------------------------------
    def _reset_venue_contract_cache(self) -> None:
        """Drop the per-cycle contract cache. Called once per signal pass."""
        with _WORKER_STATE_LOCK:
            self._venue_contract_cache = {}

    def _venue_contract_config(
        self, symbol: str, feed=None, *, exchange_type: str = "apex_omni",
    ) -> Optional[dict]:
        """Live venue contract bounds for `symbol`, or None when the venue call
        fails or the shape is unusable. None is a REFUSAL upstream
        (VENUE_CONTRACT_UNAVAILABLE) — never a substitute default."""
        # The same symbol can have different tick/lot limits on each venue.
        # Cache failures by venue too: an ApeX outage must not hide Aster data.
        key = (exchange_type, str(symbol or "").upper())
        with _WORKER_STATE_LOCK:
            if key in self._venue_contract_cache:
                return self._venue_contract_cache[key]
        cfg: Optional[dict] = None
        try:
            client = feed if feed is not None else self._signal_feed_for(exchange_type)
            cfg = client.contract_config(symbol)
        except Exception:
            cfg = None
        if not isinstance(cfg, dict):
            cfg = None
        self._venue_contract_cache[key] = cfg
        return cfg

    def _accum_available_equity_usd(self, user_id: str, connection_id: str):
        """Account equity backing this cycle, or None.

        Sourced from the signed `ACCOUNT_EQUITY_READ` ingest op, which reads
        ApeX /api/v3/account-balance server-side for an OWNED connection. The
        worker never holds credentials and never assumes a balance: any
        failure, missing field, or non-positive value returns None, which
        makes accumulator_sizing raise BALANCE_UNAVAILABLE and the bridge
        refuse the intent.

        THIS IS THE SINGLE INSERTION POINT. Do NOT add a second sizing path,
        an assumed balance, or a configured constant anywhere else.
        """
        if not self.ingest or not user_id or not connection_id:
            return None
        try:
            resp = self.ingest.read_account_equity(
                user_id=user_id, connection_id=connection_id,
            )
        except (WorkerIngestAuthError, WorkerIngestTransientError) as e:
            logging.warning("ACCOUNT_EQUITY_READ failed category=%s", type(e).__name__)
            return None
        except Exception as e:
            logging.warning("ACCOUNT_EQUITY_READ error category=%s", type(e).__name__)
            return None
        if not isinstance(resp, dict):
            return None
        # Prefer free collateral; fall back to total equity only when the
        # venue omits availableBalance.
        raw = resp.get("available_balance")
        if raw is None:
            raw = resp.get("total_equity")
        try:
            val = float(raw)
        except (TypeError, ValueError):
            return None
        if not (val > 0) or val != val or val in (float("inf"), float("-inf")):
            return None
        return val

    # ------------------------------------------------------------------
    # THE CANONICAL LIVE PATH
    #
    #   COMPLETED 15M CANDLE -> LONG / SHORT / WAIT -> SAFETY CHECKS
    #     -> ORDER INTENT -> SIGNER -> APEX RESULT
    #
    # Everything from the reduction to the ApeX result lives in this section
    # and nowhere else. There is no second place that can create an intent
    # from a strategy signal.
    #
    # NOT PREREQUISITES, BY CONSTRUCTION: a candidate record, a Scout report,
    # an Onyx decision, an AI opinion. None of them is read here, and none of
    # them is importable from this section.
    # ------------------------------------------------------------------

    def _emit_decision(self, *, user_id: str, decision: dict, strategy: str,
                       armed_leg: Optional[str]) -> dict:
        """Persist ONE decision and return the STORED execution state.

        RECORDING IS AN AUDIT TRAIL, NOT AN AUTHORITY. A failure to write here
        must never stop a trade the strategy and the safety checks approved.
        The caller receives `unknown`, which means exactly "no information" and
        is treated as PROCEED — never as a refusal.

        Duplicate submission is prevented where it always was: the broker's
        durable fingerprint + audit reservation and the signer's `_IDEM`, both
        keyed on the unchanged `idempotency_key`. Those survive restarts and
        redeploys without this write succeeding. The stored `execution_state`
        below is an additional, cheaper short-circuit when the server can
        affirmatively say the decision was already acted on — it can only ever
        suppress a genuine duplicate, never a first trade.
        """
        payload = dict(decision)
        payload["strategy"] = strategy
        payload["armed_leg"] = armed_leg
        payload["user_id"] = user_id
        # TWO DIFFERENT SURFACES, TWO DIFFERENT VOLUMES.
        #
        # The LEDGER row below is written for EVERY candle, WAIT included —
        # that is what keeps the flow panel populated and what makes a quiet
        # market distinguishable from a dead one.
        #
        # The ACTIVITY EVENT here is for a human reading a feed, so it fires
        # only when there is something to tell them: a confirmed direction.
        # A WAIT every 15 minutes per connection per symbol is ~96 rows a day
        # each saying nothing happened, which buries the rows that matter.
        #
        # And once per decision, not once per pass: the 15s loop re-observes
        # one 15m candle many times and recomputes the decision each time.
        #
        # BOTH OF THESE GATE THE LOG LINE AND NOTHING ELSE. The upsert and the
        # entire execution path still run on every pass — that is what lets a
        # candle whose first pass failed still trade on a later one.
        seen = getattr(self, "_decision_logged", None)
        first_log = decision["direction"] != "wait"
        if first_log and isinstance(seen, dict):
            first_log = decision["decision_id"] not in seen
            if first_log:
                seen[decision["decision_id"]] = None
                while len(seen) > SIGNAL_DEDUP_MAX_CANDLES * 8:
                    seen.pop(next(iter(seen)))
        try:
            if first_log:
                self.log_event(
                    user_id, "STRATEGY_DECISION",
                    f"{decision['symbol']} {decision['direction'].upper()}: "
                    f"{decision['reason']}",
                    {
                        "decision_id": decision["decision_id"],
                        "connection_id": decision["connection_id"],
                        "symbol": decision["symbol"],
                        "strategy": strategy,
                        "direction": decision["direction"],
                        "reason_code": decision["reason_code"],
                        "reason": decision["reason"],
                        "candle_close_at": decision["candle_close_at"],
                        "evidence_hash": decision["evidence_hash"],
                        "execution_performed": False,
                    },
                )
        except Exception:
            pass

        if not self.ingest:
            return {"execution_state": "unknown"}
        try:
            stored = self.ingest.upsert_decision(payload)
        except (WorkerIngestAuthError, WorkerIngestTransientError) as e:
            logging.warning("DECISION_UPSERT failed category=%s", type(e).__name__)
            return {"execution_state": "unknown"}
        except Exception as e:
            logging.warning("DECISION_UPSERT error category=%s", type(e).__name__)
            return {"execution_state": "unknown"}
        return stored if isinstance(stored, dict) else {"execution_state": "unknown"}

    @staticmethod
    def _market_context(candles: list) -> dict:
        """Bounded, candle-derived price series carried inside the evidence.

        This is what makes the evidence an immutable SNAPSHOT rather than a
        summary: the AI committee later reads exactly these numbers, so its
        `evidence_hash` matches the decision's instead of describing a
        re-fetched, slightly different market.

        Bounded at DECISION_CONTEXT_CANDLES so one decision row can never
        grow without limit. Rounded so the canonical hash is stable across
        float formatting.
        """
        window = list(candles or [])[-DECISION_CONTEXT_CANDLES:]
        def col(index: int) -> list:
            out = []
            for c in window:
                try:
                    out.append(round(float(c[index]), 8))
                except (IndexError, TypeError, ValueError):
                    return []
            return out
        return {
            "candles": len(window),
            "closes": col(accumulator_signal.CLOSE),
            "highs": col(accumulator_signal.HIGH),
            "lows": col(accumulator_signal.LOW),
        }

    def _accum_direction_input(self, *, direction: str, result: dict,
                               candles: list, connection_id: str,
                               normalized: str) -> decision_reducer.DirectionInput:
        """Accumulator / Vanguard. Identity scope and eligibility are unchanged:
        long entry identities are encoded to fit both brokers' 64-character cap.
        `entry_eligibility.newly_confirmed_entry` still admits at most one
        confirmation and only when it confirmed ON the newest completed
        candle. Historical entries remain history."""
        try:
            retest = entry_eligibility.newly_confirmed_entry(result, candles)
        except Exception:
            retest = None
        if retest is None:
            return decision_reducer.DirectionInput(
                direction=direction, confirmed=False,
                reason_detail="no retest confirmed on the newest candle",
            )
        stop_pct = accumulator_stop_pct(retest, candles)
        zone = retest.break_event.zone
        try:
            entry_price = float(candles[-1][accumulator_signal.CLOSE])
        except (IndexError, TypeError, ValueError):
            entry_price = None
        invalidation = float(zone.lower) if direction == "long" else float(zone.upper)
        tps = (
            decision_reducer.take_profit_levels(
                entry_price=entry_price, stop_pct=stop_pct, direction=direction,
                rr_multiples=[t["rr_multiple"] for t in STRATEGY_TP_TIERS],
            )
            if (entry_price and stop_pct) else []
        )
        break_ts = int(retest.break_event.break_ts)
        retest_ts = int(retest.retest_ts)
        return decision_reducer.DirectionInput(
            direction=direction, confirmed=True,
            entry_price=entry_price,
            entry_zone={"low": float(zone.lower), "high": float(zone.upper)},
            invalidation=invalidation,
            take_profits=tps,
            stop_pct=stop_pct,
            confirmation_ref=f"break:{break_ts}|retest:{retest_ts}",
            idempotency_key=entry_order_key(
                f"accum:{connection_id}:{normalized}:{direction}:{break_ts}:{retest_ts}"
            ),
            evidence={
                "break_ts_ms": break_ts,
                "retest_ts_ms": retest_ts,
                "stop_pct": None if stop_pct is None else round(stop_pct, 6),
            },
        )

    def _htf_frames(self, feed_client, symbol: str, now: int) -> dict:
        """Fetch the higher-timeframe candle stack for `symbol`.

        Cached per (feed instance, symbol, timeframe, timeframe bucket) so the 15s loop does
        not re-request a 4h series twenty times per candle. A frame whose fetch
        fails is simply ABSENT — the gate then fails closed on it rather than
        substituting anything.
        """
        with _WORKER_STATE_LOCK:
            cache = getattr(self, "_htf_frame_cache", None)
            if cache is None:
                cache = {}
                self._htf_frame_cache = cache
        out: dict = {}
        # Canonical Zen vote frames. The entry feed is already the completed
        # 15m series; only 1h/4h/1d direction context is fetched here.
        for tf in ("1h", "4h", "1d"):
            interval = sweep_htf_gate.INTERVAL_MIN[tf]
            bucket = int(now) // (interval * 60_000)
            key = (id(feed_client), str(symbol).upper(), tf, bucket)
            with _WORKER_STATE_LOCK:
                cached = cache.get(key)
            if cached:
                out[tf] = cached
                continue
            try:
                frame = feed_client.fetch(symbol, interval, need=60, now_ms=now)
                candles = list(frame.candles)
            except Exception:
                candles = None
            # Failed reads are retried next cycle, never cached for a whole day.
            with _WORKER_STATE_LOCK:
                if candles:
                    cache[key] = candles
                if len(cache) > 64:
                    for stale_key in list(cache.keys())[:32]:
                        cache.pop(stale_key, None)
            out[tf] = candles
        return out

    @staticmethod
    def _plan_direction_input(*, direction: str, plan, kind: str,
                              connection_id: str, normalized: str,
                              htf=None,
                              ) -> decision_reducer.DirectionInput:
        """Hunter / Sweep. Both evaluators return a single-price plan rather
        than a zone, so the entry zone collapses to that price.

        For SWEEP the completed 15m plan becomes actionable only when `htf`
        records two matching direction votes across 1h/4h/1d.
        """
        htf_required = kind == "sweep"
        htf_authorized = bool(getattr(htf, "authorized", False))
        htf_code = getattr(htf, "refusal_code", None)
        htf_evidence = getattr(htf, "evidence", None) or {}

        if plan is None:
            return decision_reducer.DirectionInput(
                direction=direction, confirmed=False,
                reason_detail=f"no {kind} setup on the newest candle",
                htf_gate_required=htf_required,
                htf_authorized=htf_authorized,
                evidence=({"htf": htf_evidence} if htf_required else {}),
            )
        if kind == "hunter":
            ref = f"fvg:{int(plan.fvg_confirm_ts)}"
            idem = f"hunter:{connection_id}:{normalized}:{direction}:{plan.fvg_confirm_ts}"
            evidence = {
                "fvg_confirm_ts": int(plan.fvg_confirm_ts),
                "ratio": float(plan.ratio),
                "stop_pct": round(float(plan.stop_pct), 6),
            }
        else:
            ref = f"sweep:{plan.dedup_key}"
            idem = f"sweep:{connection_id}:{normalized}:{direction}:{plan.dedup_key}"
            evidence = {
                "mode": str(plan.mode),
                "level_source": str(plan.level_source),
                "swept_level": float(plan.swept_level),
                "stop_pct": round(float(plan.stop_pct), 6),
                "htf": htf_evidence,
                "htf_authorized": htf_authorized,
                "htf_refusal_code": htf_code,
            }

        if htf_required and not htf_authorized:
            # A 15m trigger with no higher-timeframe thesis is a deterministic
            # WAIT, recorded with the gate's exact code. Nothing is submitted.
            return decision_reducer.DirectionInput(
                direction=direction, confirmed=False,
                reason_detail=(
                    f"15m sweep trigger present but 2-of-3 HTF authorization missing"
                    f" ({htf_code or sweep_htf_gate.HTF_ALIGNMENT_REQUIRED})"
                ),
                refusal_code=htf_code or sweep_htf_gate.HTF_ALIGNMENT_REQUIRED,
                htf_gate_required=True,
                htf_authorized=False,
                confirmation_ref=ref,
                evidence=evidence,
            )

        fill = float(plan.fill_px)
        return decision_reducer.DirectionInput(
            direction=direction, confirmed=True,
            entry_price=fill,
            entry_zone={"low": fill, "high": fill},
            invalidation=float(plan.stop_level),
            take_profits=[float(plan.tp_level)],
            stop_pct=float(plan.stop_pct),
            confirmation_ref=ref,
            idempotency_key=entry_order_key(idem),
            evidence=evidence,
            htf_gate_required=htf_required,
            htf_authorized=htf_authorized,
        )

    def _decide_and_execute(self, *, cfg: dict, user_id: str, connection_id: str,
                            symbol: str, normalized: str, now: int, feed,
                            newest_ts: int, armed_leg: Optional[str],
                            gate: Optional[dict], accum_results: dict,
                            hunter_plans: dict, sweep_plans: dict,
                            feed_client, sweep_htf: Optional[dict] = None,
                            turtle_route_authorized: bool = True,
                            ) -> Optional[dict]:
        """One completed candle -> one decision -> (maybe) one order.

        Returns the decision dict for tests and callers; the live loop
        ignores the return value.
        """
        # The newest COMPLETED candle's row carries its OPEN timestamp. The
        # decision is keyed on the candle's CLOSE, which is also the open of
        # the candle now forming — so a data-outage decision keyed on the
        # bucket lands on exactly the same candle identity.
        candle_close_ms = int(newest_ts) + SIGNAL_INTERVAL_MIN * 60_000
        gate = gate if isinstance(gate, dict) else {}
        strategy = str(armed_leg or DEFAULT_STRATEGY).lower()
        sweep_htf = sweep_htf if isinstance(sweep_htf, dict) else {}

        inputs: list = []
        if accum_results:
            for direction in SIGNAL_DIRECTIONS:
                result = accum_results.get(direction)
                if isinstance(result, dict):
                    inputs.append(self._accum_direction_input(
                        direction=direction, result=result, candles=feed.candles,
                        connection_id=connection_id, normalized=normalized,
                    ))
        elif hunter_plans:
            for direction in SIGNAL_DIRECTIONS:
                inputs.append(self._plan_direction_input(
                    direction=direction, plan=hunter_plans.get(direction),
                    kind="hunter", connection_id=connection_id, normalized=normalized,
                ))
        elif sweep_plans:
            for direction in SIGNAL_DIRECTIONS:
                inputs.append(self._plan_direction_input(
                    direction=direction, plan=sweep_plans.get(direction),
                    kind="sweep", connection_id=connection_id, normalized=normalized,
                    htf=sweep_htf.get(direction),
                ))


        reduction = decision_reducer.reduce_decision(
            strategy=strategy,
            candle_close_ms=candle_close_ms,
            directions=tuple(inputs),
            market_context=self._market_context(feed.candles),
            regime=gate.get("regime"),
            trend_age_candles=gate.get("trend_age_candles"),
            # A gate that raised leaves `gate` empty -> not authorized. Fail
            # closed, exactly as the pre-refactor bridges did.
            guard_authorized=gate.get("guard_authorized") is True,
            guard_block_code=gate.get("guard_block_code"),
            evaluator_wired=bool(inputs),
            candle_fresh=(now - int(newest_ts)) <= SIGNAL_LIVE_MAX_CANDLE_AGE_MS,
            turtle_route_authorized=turtle_route_authorized and routed_turtle_enabled(cfg, armed_leg),
            executing_turtle=executing_turtle(cfg, armed_leg),
        )
        decision = decision_contract.build_decision(
            connection_id=connection_id, symbol=symbol, strategy=strategy,
            candle_close_ms=candle_close_ms, direction=reduction.direction,
            reason_code=reduction.reason_code, reason=reduction.reason,
            evidence=reduction.evidence, created_at_ms=now,
            entry_zone=reduction.entry_zone, invalidation=reduction.invalidation,
            take_profits=reduction.take_profits,
        )
        stored = self._emit_decision(
            user_id=user_id, decision=decision, strategy=strategy, armed_leg=armed_leg,
        )

        # WAIT is a complete, recorded outcome. Execution is not "not reached
        # because something failed" — there is simply nothing to execute.
        if reduction.direction == "wait" or reduction.chosen is None:
            return decision

        # Cheap duplicate short-circuit. It fires ONLY when the server can
        # affirmatively say this decision was already acted on, so it can
        # suppress a genuine repeat and nothing else.
        #
        # `unknown` means the ledger write failed or the op is not deployed —
        # i.e. NO INFORMATION. That is never a reason to refuse a trade the
        # strategy and the safety checks approved, so it PROCEEDS. Duplicate
        # protection does not depend on this call: the broker's fingerprint +
        # audit reservation and the signer's idempotency store, both keyed on
        # the unchanged `idempotency_key`, are the durable guard and they work
        # whether or not this write succeeded.
        state = str(stored.get("execution_state") or EXECUTION_UNKNOWN)
        if state not in (EXECUTION_NOT_REACHED, EXECUTION_UNKNOWN):
            logging.info(
                "Decision %s already at execution_state=%s; not re-executing.",
                decision["decision_id"], state,
            )
            return decision
        if state == EXECUTION_UNKNOWN:
            logging.warning(
                "Decision %s could not be recorded; proceeding to safety checks. "
                "Duplicate protection falls to the broker and signer idempotency "
                "keys, which is where it lived before this ledger existed.",
                decision["decision_id"],
            )

        self._execute_decision(
            cfg=cfg, user_id=user_id, connection_id=connection_id, symbol=symbol,
            normalized=normalized, decision=decision, strategy=strategy,
            chosen=reduction.chosen, gate=gate, feed=feed, feed_client=feed_client,
            now=now,
        )
        return decision

    def _execute_decision(self, *, cfg: dict, user_id: str, connection_id: str,
                          symbol: str, normalized: str, decision: dict,
                          strategy: str, chosen, gate: dict, feed,
                          feed_client, now: int) -> None:
        """SAFETY CHECKS -> ORDER INTENT -> SIGNER -> APEX RESULT."""
        if cfg.get("exchange_type") == "aster":
            return self._execute_aster_decision(
                cfg=cfg, user_id=user_id, connection_id=connection_id,
                symbol=symbol, decision=decision, strategy=strategy, chosen=chosen, gate=gate,
            )
        if cfg.get("exchange_type") == "synfutures":
            return self._execute_synfutures_decision(
                cfg=cfg, user_id=user_id, connection_id=connection_id, symbol=symbol,
                decision=decision, strategy=strategy, chosen=chosen, gate=gate,
            )
        if cfg.get("exchange_type") != "apex_omni":
            self._update_decision_execution(
                decision_id=decision["decision_id"],
                execution_state=EXECUTION_BLOCKED,
                reason_code="UNSUPPORTED_EXECUTION_EXCHANGE",
            )
            return
        params = cfg.get("params")
        if isinstance(params, dict) and params.get("dynamic_wallet_sizing") is True:
            from shared.execution_configuration import configured_leverage
            if configured_leverage(params.get("leverage"), maximum=100) is None:
                self._update_decision_execution(
                    decision_id=decision["decision_id"],
                    execution_state=EXECUTION_BLOCKED,
                    reason_code="LEVERAGE_CHOICE_REQUIRED" if params.get("leverage") is None else "LEVERAGE_INVALID",
                )
                return
        direction = chosen.direction

        # --- inputs for the four checks ---------------------------------
        # Equity is read HERE and nowhere else on this path, immediately
        # before the gate, so "fresh" is a property of the read, not a hope.
        equity_usd = self._accum_available_equity_usd(user_id, connection_id)

        sizing_error_code: Optional[str] = None
        size: Optional[float] = None
        leverage: Optional[int] = None
        plan = None
        # ONE SIZING AUTHORITY FOR EVERY STRATEGY LEG.
        #
        # Hunter and Sweep used to fall through to the fixed canary size
        # with no leverage at all. On BTC that was merely tiny; on ETH and
        # every other contract it produced a one-step size and a null
        # leverage, which the signer refused as SIZE_TOO_SMALL —
        # a sizing bug wearing a venue rejection's clothes. All legs now
        # derive size and leverage from the ratified plan and REFUSE (with
        # the sizer's own static code) when they cannot. No path returns a
        # default, a floor, or a constant.
        contract = self._venue_contract_config(
            symbol, feed=feed_client, exchange_type=cfg["exchange_type"],
        )
        if strategy == "sweep":
            # Release boundary: paper owns the complete zen_sweep_v1
            # lifecycle (five simultaneously armed rungs and the +100% /
            # +200% campaign exit state machine). The live translator below
            # can currently submit only one MARKET intent with the older TP
            # tiers. Allowing that translation would execute a materially
            # different strategy with real funds. Keep the deterministic
            # decision visible, but fail safety check 4 until the signer and
            # reconciliation path support the complete shared contract.
            sizing_error_code = "ZEN_SWEEP_LIVE_PARITY_PENDING"
        else:
            try:
                plan = accumulator_live_size.plan_entry_size(
                    available_equity_usd=equity_usd,
                    # DASHED form: the parity constants are keyed 'BTC-USDT'.
                    symbol=symbol,
                    direction=direction,
                    entry_price=chosen.entry_price,
                    contract=contract,
                    # THE CUSTOMER'S CHOICE. Omitting this defaulted every
                    # entry to pilot_sizing.MAX_LEVERAGE, so a customer who
                    # deliberately picked 50x got 100x — double the risk they
                    # asked for, silently. Choosing LOWER leverage failing is
                    # the dangerous direction of this bug.
                    #
                    # `plan_entry_size` still clamps: to the live venue
                    # ceiling from the ApeX contract, then to the ratified
                    # pilot ceiling. This can only ever lower the number, so
                    # passing it cannot widen authority.
                    requested_leverage=_requested_leverage(cfg),
                    # Onyx mandate rows use the universal campaign contract:
                    # 5% of the latest wallet equity, represented as five
                    # equal rungs deployed together at the alert. Legacy rows
                    # retain their pre-mandate pilot sizing until migrated.
                    dynamic_wallet_campaign=bool(
                        isinstance(cfg.get("params"), dict)
                        and cfg["params"].get("dynamic_wallet_sizing") is True
                    ),
                )
                size = float(format(plan.size.normalize(), "f"))
                leverage = plan.leverage
            except accumulator_live_size.SizingError as se:
                sizing_error_code = se.code


        gate_dir = (gate.get("directions") or {}).get(direction)
        lockout_active = bool(isinstance(gate_dir, dict) and gate_dir.get("lockout"))

        outcome = safety_checks.evaluate_safety(
            cfg=cfg,
            live_trading_enabled=LIVE_TRADING_ENABLED,
            equity_usd=equity_usd,
            symbol=symbol,
            direction=direction,
            in_flight_symbols=[
                s for (u, c, s) in tuple(self._decision_inflight)
                if u == user_id and c == connection_id
            ],
            lockout_active=lockout_active,
            sizing_error_code=sizing_error_code,
            size=size,
            leverage=leverage,
        )

        if not outcome.passed:
            # ONE explicit reason, then stop. Nothing was sent anywhere.
            self._update_decision_execution(
                decision_id=decision["decision_id"],
                execution_state=EXECUTION_BLOCKED,
                reason_code=outcome.block_code,
                safety=outcome.as_dict(),
            )
            return

        # --- ORDER INTENT ------------------------------------------------
        # Byte-for-byte the shape the broker and signer already accept. The
        # idempotency key formula is unchanged, so the broker's duplicate
        # protection keeps working across this refactor.
        intent = {
            "user_id": user_id,
            "connection_id": connection_id,
            "venue": "apex_omni",
            "symbol": symbol,
            "side": "BUY" if direction == "long" else "SELL",
            "order_type": "MARKET",
            "size": size,
            "campaign_rung_count": plan.rung_count if plan is not None else 1,
            "campaign_margin_usd": (
                float(plan.margin_usd) if plan is not None else None
            ),
            "campaign_margin_per_rung_usd": (
                float(plan.margin_per_rung_usd) if plan is not None else None
            ),
            "purpose": "CREATE_ORDER",
            "idempotency_key": chosen.idempotency_key,
            "stop_pct": round(float(chosen.stop_pct), 6),
            "tp_tiers": [dict(t) for t in STRATEGY_TP_TIERS],
        }
        if leverage is not None:
            # Every leg now carries leverage; the safety gate refuses the
            # intent outright when it is absent, so this can only be None on
            # a path that never reaches here.
            intent["leverage"] = leverage

        self._update_decision_execution(
            decision_id=decision["decision_id"],
            execution_state=EXECUTION_INTENT_CREATED,
            safety=outcome.as_dict(),
            intent={
                "idempotency_key": intent["idempotency_key"],
                "side": intent["side"],
                "size": intent["size"],
                "leverage": leverage,
                "stop_pct": intent["stop_pct"],
            },
        )

        flight_key = (user_id, connection_id, str(symbol).strip().upper())
        self._decision_inflight.add(flight_key)
        try:
            result = self.submit_order_intent(intent)
        except Exception as e:
            result = {"ok": False, "status": "ambiguous", "reject_reason": f"WORKER_EXCEPTION_{type(e).__name__}"}

        state, apex = self._classify_apex_result(result)
        # An ambiguous outcome may have reached the venue. The symbol stays
        # in flight until an operator reconciles it — releasing it here is
        # the one way this path could double-submit.
        if state != EXECUTION_AMBIGUOUS:
            self._decision_inflight.discard(flight_key)

        self._update_decision_execution(
            decision_id=decision["decision_id"],
            execution_state=state,
            reason_code=apex.get("reject_reason"),
            apex_result=apex,
        )
        try:
            self.log_event(
                user_id, "ORDER_INTENT_RESULT",
                f"{symbol} {direction.upper()} intent -> {state}.",
                {
                    "decision_id": decision["decision_id"],
                    "connection_id": connection_id,
                    "symbol": symbol,
                    "direction": direction,
                    "strategy": strategy,
                    "idempotency_key": intent["idempotency_key"],
                    "size": size,
                    "leverage": leverage,
                    "execution_state": state,
                    "outcome": apex,
                    "is_live": LIVE_TRADING_ENABLED,
                },
            )
        except Exception:
            pass

    def _execute_aster_decision(self, *, cfg, user_id, connection_id, symbol,
                                decision, strategy, chosen, gate):
        """Use the shared broker with Aster's own signer contract and account."""
        flight_key = (user_id, connection_id, symbol)
        try:
            intent = aster_worker_execution.build_entry_intent(
                cfg=cfg, live_enabled=LIVE_TRADING_ENABLED, user_id=user_id,
                connection_id=connection_id, symbol=symbol, direction=chosen.direction,
                idempotency_key=chosen.idempotency_key, strategy=strategy,
            )
            if flight_key in self._decision_inflight:
                raise aster_worker_execution.AsterIntentError("SYMBOL_EXECUTION_IN_FLIGHT")
            direction_gate = (gate.get("directions") or {}).get(chosen.direction) or {}
            if direction_gate.get("lockout"):
                raise aster_worker_execution.AsterIntentError("REENTRY_LOCKOUT_ACTIVE")
            if self._accum_available_equity_usd(user_id, connection_id) is None:
                raise aster_worker_execution.AsterIntentError("EQUITY_UNAVAILABLE")
        except aster_worker_execution.AsterIntentError as exc:
            self._update_decision_execution(decision_id=decision["decision_id"],
                execution_state=EXECUTION_BLOCKED, reason_code=str(exc))
            return
        self._update_decision_execution(decision_id=decision["decision_id"],
            execution_state=EXECUTION_INTENT_CREATED,
            intent={"idempotency_key": intent["idempotency_key"], "side": intent["side"],
                    "leverage": intent["leverage"], "venue": "aster", "campaign_rung_count": 5})
        self._decision_inflight.add(flight_key)
        try:
            result = self.submit_order_intent(intent)
        except Exception:
            result = {"status": "ambiguous", "reject_reason": "ASTER_EXECUTION_UNKNOWN"}
        state, evidence = self._classify_apex_result(result)
        if state == EXECUTION_AMBIGUOUS:
            if not hasattr(self,"_synfutures_pending_campaigns"):self._synfutures_pending_campaigns={}
            self._synfutures_pending_campaigns[flight_key]=intent["idempotency_key"]
        else:
            self._decision_inflight.discard(flight_key)
        self._update_decision_execution(decision_id=decision["decision_id"],
            execution_state=state, reason_code=evidence.get("reject_reason"), apex_result=evidence)

    def _execute_synfutures_decision(self, *, cfg, user_id, connection_id, symbol,
                                    decision, strategy, chosen, gate):
        flight_key = (user_id, connection_id, symbol)
        try:
            intent = synfutures_worker_execution.build_entry_intent(
                cfg=cfg, live_enabled=LIVE_TRADING_ENABLED, user_id=user_id,
                connection_id=connection_id, symbol=symbol, direction=chosen.direction,
                idempotency_key=chosen.idempotency_key, strategy=strategy)
            if flight_key in self._decision_inflight:
                raise synfutures_worker_execution.SynFuturesIntentError("SYMBOL_EXECUTION_IN_FLIGHT")
            if ((gate.get("directions") or {}).get(chosen.direction) or {}).get("lockout"):
                raise synfutures_worker_execution.SynFuturesIntentError("REENTRY_LOCKOUT_ACTIVE")
        except synfutures_worker_execution.SynFuturesIntentError as exc:
            self._update_decision_execution(decision_id=decision["decision_id"],
                execution_state=EXECUTION_BLOCKED, reason_code=str(exc))
            return
        self._update_decision_execution(decision_id=decision["decision_id"],
            execution_state=EXECUTION_INTENT_CREATED,
            intent={"idempotency_key": intent["idempotency_key"], "side": intent["side"],
                    "leverage": intent["leverage"], "venue": "synfutures"})
        self._decision_inflight.add(flight_key)
        try:
            result = self.submit_order_intent(intent)
        except Exception:
            result = {"status": "ambiguous", "reject_reason": "SYNFUTURES_EXECUTION_UNKNOWN"}
        state, evidence = self._classify_apex_result(result)
        if state == EXECUTION_AMBIGUOUS:
            if not hasattr(self,"_synfutures_pending_campaigns"):self._synfutures_pending_campaigns={}
            self._synfutures_pending_campaigns[flight_key]=intent["idempotency_key"]
        else:
            self._decision_inflight.discard(flight_key)
        self._update_decision_execution(decision_id=decision["decision_id"],
            execution_state=state, reason_code=evidence.get("reject_reason"), apex_result=evidence)

    @staticmethod
    def _classify_apex_result(result: Optional[dict]) -> tuple:
        """Map the broker's sanitized response onto a durable state.

        `duplicate` is NOT a failure and NOT a second order: it means the
        broker matched a prior identical intent, which is exactly what the
        idempotency key is for.
        """
        r = result if isinstance(result, dict) else {}
        status = str(r.get("status") or "")
        reject = r.get("reject_reason")
        sanitized = {
            "status": status or None,
            "exchange_order_id": r.get("exchange_order_id"),
            "exchange_status": r.get("exchange_status"),
            "reject_reason": reject,
            "campaign_rung_count": r.get("campaign_rung_count"),
            "reconciliation_required": r.get("reconciliation_required"),
            "filled_size": r.get("filled_size"),
            "reduce_only": r.get("reduce_only"),
            "campaign_orders": r.get("campaign_orders")
            if isinstance(r.get("campaign_orders"), list) else [],
        }
        if r.get("reconciliation_required") is True or status == "partial":
            return EXECUTION_AMBIGUOUS, sanitized
        if status in ("submitted", "duplicate"):
            filled = str(r.get("exchange_status") or "").lower()
            if filled in ("filled", "partially_filled"):
                return EXECUTION_FILLED, sanitized
            return EXECUTION_SUBMITTED, sanitized
        if status == "ambiguous":
            return EXECUTION_AMBIGUOUS, sanitized
        if status == "rejected" or reject:
            return EXECUTION_REJECTED, sanitized
        # A shape we do not recognise is ambiguous, never a success.
        sanitized["reject_reason"] = reject or "BROKER_RESPONSE_UNRECOGNISED"
        return EXECUTION_AMBIGUOUS, sanitized

    def _update_decision_execution(self, **kwargs) -> None:
        """Advance the decision's execution record. Best-effort: a failed
        audit write must never change what was or was not submitted."""
        if not self.ingest:
            return
        try:
            self.ingest.update_decision_execution(**kwargs)
        except (WorkerIngestAuthError, WorkerIngestTransientError) as e:
            logging.warning("DECISION_EXECUTION_UPDATE failed category=%s", type(e).__name__)
        except Exception as e:
            logging.warning("DECISION_EXECUTION_UPDATE error category=%s", type(e).__name__)

    def _prune_signal_cache(self, prefix: tuple, newest_ts_ms: int) -> None:
        """Evict entries older than SIGNAL_DEDUP_MAX_CANDLES completed candles
        for this (user, connection, symbol, interval). Fixed bound — the cache
        is never allowed to grow unbounded."""
        step_ms = SIGNAL_INTERVAL_MIN * 60_000
        # Inclusive of the newest candle: the retained window is exactly
        # SIGNAL_DEDUP_MAX_CANDLES entries per prefix, not that many PLUS the
        # newest. An off-by-one here would be a slow leak, not a crash.
        floor = newest_ts_ms - (SIGNAL_DEDUP_MAX_CANDLES - 1) * step_ms
        for k in [k for k in list(self._signal_seen) if k[:4] == prefix and k[4] < floor]:
            del self._signal_seen[k]

    def _emit_signal_event(
        self,
        *,
        user_id: str,
        detail: dict,
        level: str,
        message: str,
    ) -> bool:
        """Send one bounded SIGNAL_EVALUATION event.

        Returns True when the key may be marked observed: either the insert
        succeeded, or the server permanently rejected it (retrying an
        auth/schema rejection every 15s would just burn rate limit). Returns
        False on a transient failure so the next cycle retries.
        """
        if not self.ingest:
            return False
        bounded = bound_signal_detail(detail)
        try:
            self.ingest.emit_event(
                code="SIGNAL_EVALUATION",
                level=level,
                message=message[:200],
                user_id=user_id,
                detail=bounded,
            )
            return True
        except WorkerIngestAuthError as e:
            logging.warning(
                "SIGNAL_EVALUATION permanently rejected (category=%s); not retrying.", e,
            )
            return True
        except WorkerIngestTransientError as e:
            logging.warning(
                "SIGNAL_EVALUATION transient failure (category=%s); will retry next cycle.", e,
            )
            return False
        except ValueError as e:
            logging.warning("SIGNAL_EVALUATION rejected client-side (category=%s).", type(e).__name__)
            return True

    def _base_signal_detail(
        self,
        *,
        status: str,
        observation_id: str,
        symbol: str,
        normalized_symbol: str,
        candle_ts_ms: Optional[int],
        now_ms: int,
    ) -> dict:
        from datetime import datetime, timezone
        return {
            "status": status,
            "observation_id": observation_id,
            "symbol": symbol,
            "normalized_symbol": normalized_symbol,
            "interval_min": SIGNAL_INTERVAL_MIN,
            "interval_source": SIGNAL_INTERVAL_SOURCE,
            "newest_completed_candle_ts_ms": candle_ts_ms,
            "evaluated_at": datetime.fromtimestamp(
                now_ms / 1000.0, tz=timezone.utc
            ).isoformat().replace("+00:00", "Z"),
            # The whole point of this path. Never computed, never conditional.
            "execution_performed": False,
        }

    def observe_market_watch(
        self, cfg: dict, user_id: str, connection_id: str,
        now_ms: Optional[int] = None, feed=None,
    ) -> Optional[str]:
        """Record venue candles without creating a decision or order intent."""
        if cfg.get("scan_only") is not True or cfg.get("enabled") is not True:
            return None
        venue = cfg.get("exchange_type")
        symbol = cfg.get("symbol")
        if venue not in (SIGNAL_EXCHANGE_TYPE, "aster", "synfutures") or not isinstance(symbol, str) or not symbol:
            return None
        now = int(time.time() * 1000) if now_ms is None else int(now_ms)
        normalized = normalize_signal_symbol(symbol)
        bucket = signal_candle_bucket_ms(now) - SIGNAL_INTERVAL_MIN * 60_000
        prefix = (user_id, connection_id, normalized, SIGNAL_INTERVAL_MIN)
        key = prefix + (bucket,)
        if key in self._signal_seen:
            return None
        feed_client = feed if feed is not None else self._signal_feed_for(venue)
        try:
            result = feed_client.fetch(symbol, SIGNAL_INTERVAL_MIN, need=SIGNAL_NEED_CANDLES, now_ms=now)
        except (market_data.FeedError, ValueError) as exc:
            detail = self._base_signal_detail(
                status="error", observation_id=build_observation_id(
                    user_id, connection_id, normalized, SIGNAL_INTERVAL_MIN, bucket,
                ), symbol=symbol, normalized_symbol=normalized,
                candle_ts_ms=None, now_ms=now,
            )
            detail.update(connection_id=connection_id, exchange_type=venue, scan_only=True,
                          strategy_configured=False, reason_code=feed_error_reason_code(exc))
            if self._emit_market_watch_event(user_id, detail, "warn", "Connected venue market watch failed."):
                self._signal_seen[key] = "error"
                self._prune_signal_cache(prefix, bucket)
            return "error"
        candle_ts = int(result.candles[-1][0])
        if candle_ts != bucket:
            return None
        detail = self._base_signal_detail(
            status="market_watch", observation_id=build_observation_id(
                user_id, connection_id, normalized, SIGNAL_INTERVAL_MIN, candle_ts,
            ), symbol=symbol, normalized_symbol=normalized,
            candle_ts_ms=candle_ts, now_ms=now,
        )
        latest = result.candles[-1]
        prior_close = float(result.candles[-2][4]) if len(result.candles) > 1 else None
        detail.update(connection_id=connection_id, exchange_type=venue, scan_only=True,
                      strategy_configured=False, decision_recorded=False,
                      candle_count=len(result.candles), age_sec=round(result.age_sec, 1),
                      open=latest[1], high=latest[2], low=latest[3],
                      close=latest[4], volume=latest[5],
                      change_pct=(round((float(latest[4]) / prior_close - 1) * 100, 4)
                                  if prior_close and prior_close > 0 else None))
        if self._emit_market_watch_event(user_id, detail, "info", "Connected venue market watch completed."):
            self._signal_seen[key] = "market_watch"
            self._prune_signal_cache(prefix, candle_ts)
        return "market_watch"

    def _emit_market_watch_event(self, user_id: str, detail: dict, level: str, message: str) -> bool:
        if not self.ingest:
            return False
        try:
            self.ingest.emit_event(code="MARKET_WATCH", level=level, message=message,
                                   user_id=user_id, detail=bound_signal_detail(detail))
            return True
        except WorkerIngestAuthError:
            # A rejected write is not a persisted observation. Keep this
            # candle eligible for retry after ingest credentials are fixed.
            return False
        except WorkerIngestTransientError:
            return False
        except ValueError:
            return False

    def observe_signal(
        self,
        cfg: dict,
        user_id: str,
        connection_id: str,
        now_ms: Optional[int] = None,
        feed: Optional[market_data.ApexPublicFeed] = None,
    ) -> Optional[str]:
        """Evaluate configured strategies and dispatch eligible live decisions.

        Returns the emitted status ('evaluated' | 'skipped' | 'error') or None
        when the configuration is out of scope or the observation was
        suppressed as a duplicate.

        RESTART LIMITATION — documented, not fixed: `_signal_seen` is in-memory
        only, because G32 authorises no table and none is added. A container
        restart clears it, so the candle in flight at restart may be observed a
        second time. `observation_id` is deterministic over (user, connection,
        symbol, interval, newest completed candle ts), so a downstream reader
        can collapse those duplicates. The worker itself does not promise
        cross-restart deduplication.
        """
        # 1. Enabled gate. Not `truthy` — exactly True. A config that is not
        #    explicitly enabled gets no feed request, no evaluation, no event.
        if cfg.get("enabled") is not True:
            return None

        # 2. Venue scope. Each supported venue uses its own public feed.
        if cfg.get("exchange_type") not in (SIGNAL_EXCHANGE_TYPE, "aster", "synfutures"):
            return None

        now = int(time.time() * 1000) if now_ms is None else int(now_ms)
        symbol = cfg.get("symbol")
        if not isinstance(symbol, str) or not symbol.strip():
            bucket = signal_candle_bucket_ms(now)
            obs = build_observation_id(user_id, connection_id, "", SIGNAL_INTERVAL_MIN, bucket)
            detail = self._base_signal_detail(
                status="skipped", observation_id=obs, symbol="",
                normalized_symbol="", candle_ts_ms=None, now_ms=now,
            )
            detail["reason_code"] = "MISSING_SYMBOL"
            key = (user_id, connection_id, "", SIGNAL_INTERVAL_MIN, bucket)
            if key in self._signal_seen:
                return None
            if self._emit_signal_event(
                user_id=user_id, detail=detail, level="warn",
                message="Observational evaluation skipped: config carries no symbol.",
            ):
                self._signal_seen[key] = "skipped"
            return "skipped"

        normalized = normalize_signal_symbol(symbol)
        prefix = (user_id, connection_id, normalized, SIGNAL_INTERVAL_MIN)

        # 3. Market scope. 'spot' is NOT silently treated as perpetual.
        #    No candles are fetched and no evaluation runs for a config whose
        #    market_type is not the repository's canonical perpetual value.
        market_type = cfg.get("market_type")
        if market_type not in ACCEPTED_PERPETUAL_MARKET_TYPES:
            bucket = signal_candle_bucket_ms(now)
            key = prefix + (bucket,)
            if key in self._signal_seen:
                return None
            obs = build_observation_id(user_id, connection_id, normalized, SIGNAL_INTERVAL_MIN, bucket)
            detail = self._base_signal_detail(
                status="skipped", observation_id=obs, symbol=symbol,
                normalized_symbol=normalized, candle_ts_ms=None, now_ms=now,
            )
            detail["reason_code"] = "UNSUPPORTED_MARKET_TYPE"
            detail["market_type_seen"] = str(market_type)[:32]
            detail["accepted_market_types"] = sorted(ACCEPTED_PERPETUAL_MARKET_TYPES)
            if self._emit_signal_event(
                user_id=user_id, detail=detail, level="info",
                message="Observational evaluation skipped: market_type is not perpetual.",
            ):
                self._signal_seen[key] = "skipped"
                self._prune_signal_cache(prefix, bucket)
            return "skipped"

        # 4. Feed. Fails closed on transport, shape, empty data, gaps,
        #    duplicates, misalignment, invalid OHLC, symbol/interval mismatch
        #    and missing tick size — every one of those raises out of fetch()
        #    and NONE of them is substituted with a default or a partial series.
        feed_client = feed if feed is not None else self._signal_feed_for(cfg["exchange_type"])
        # Per-cycle venue-contract cache is scoped to one observation pass.
        self._reset_venue_contract_cache()
        try:
            f = feed_client.fetch(
                symbol,
                SIGNAL_INTERVAL_MIN,
                need=SIGNAL_NEED_CANDLES,
                now_ms=now,
            )
        except (market_data.FeedError, ValueError) as e:
            bucket = signal_candle_bucket_ms(now)
            # NO DECISION IS RECORDED HERE, deliberately. A decision claims its
            # candle permanently (one row per candle, enforced by a unique
            # index), so recording one for a transient feed failure would burn
            # a candle that the next 15s cycle could still have evaluated and
            # traded. The failure is reported on the SIGNAL_EVALUATION event
            # below, exactly as it always was, and the candle stays open.
            key = prefix + (bucket,)
            if key in self._signal_seen:
                return None
            obs = build_observation_id(user_id, connection_id, normalized, SIGNAL_INTERVAL_MIN, bucket)
            detail = self._base_signal_detail(
                status="error", observation_id=obs, symbol=symbol,
                normalized_symbol=normalized, candle_ts_ms=None, now_ms=now,
            )
            detail["reason_code"] = feed_error_reason_code(e)
            detail["error_text"] = str(e)[:SIGNAL_ERROR_TEXT_MAX_CHARS]
            if self._emit_signal_event(
                user_id=user_id, detail=detail, level="warn",
                message="Observational evaluation failed: market data unusable.",
            ):
                self._signal_seen[key] = "error"
                self._prune_signal_cache(prefix, bucket)
            return "error"

        newest_ts = int(f.candles[-1][0])
        key = prefix + (newest_ts,)

        # 5. Evaluate BOTH directions. Pure; no orders, no I/O, no side effects.
        #
        # Per-leg dispatch (2026-07-27 wired): Accumulator/Vanguard use the
        # canonical `.evaluate()`. Hunter uses `hunter_entry`; Sweep uses
        # `sweep_entry`. Both have live-intent bridges in §5b/§5c below.
        # `routing.leg_for_regime` returns lowercase names ("hunter",
        # "accumulator", "vanguard", "sweep") — match on lowercase.
        _gate = None
        try:
            _gate = _live.entry_gate(f.candles, normalized, self._current_lockout_set)
        except Exception:
            _gate = None
        _armed_leg_raw = (_gate or {}).get("leg") if isinstance(_gate, dict) else None
        _armed_leg = str(_armed_leg_raw).lower() if _armed_leg_raw else None
        _gate_dirs = (_gate or {}).get("directions") if isinstance(_gate, dict) else {}
        _leg_accum = _armed_leg in (None, "accumulator", "vanguard")
        _leg_hunter = _armed_leg == "hunter"
        _leg_sweep = _armed_leg == "sweep"
        _route_enabled = routed_turtle_enabled(cfg, _armed_leg)

        # LIVE PARTICIPATION GATE. `active_bot_config` also returns paper-mode,
        # unverified and disconnected connection rows. A decision is recorded
        # for a VERIFIED LIVE connection only — that is what stopped one
        # completed candle producing three competing identities, one per
        # connection. Observation below is unaffected; the block code is now
        # recorded on the event instead of being applied silently.
        _live_block = live_eligibility.live_execution_block_code(cfg)

        directions: dict = {}
        hunter_plans: dict = {}
        sweep_plans: dict = {}
        sweep_htf: dict = {}

        accum_results: dict = {}
        try:
            if not _route_enabled:
                _stub = {
                    "confirmed": False,
                    "reason_code": "turtle_not_enabled",
                    "reason_detail": f"strategy={_armed_leg or DEFAULT_STRATEGY} has no selected executing Turtle",
                    "armed_leg": _armed_leg or DEFAULT_STRATEGY,
                }
                for direction in SIGNAL_DIRECTIONS:
                    directions[direction] = _stub
            elif _leg_accum:
                for direction in SIGNAL_DIRECTIONS:
                    result = accumulator_signal.evaluate(f.candles, direction, f.tick)
                    accum_results[direction] = result
                    directions[direction] = summarize_direction(result)
            elif _leg_hunter:
                for direction in SIGNAL_DIRECTIONS:
                    plan, code = hunter_entry.evaluate(f.candles, direction)
                    hunter_plans[direction] = plan
                    directions[direction] = {
                        "confirmed": plan is not None,
                        "reason_code": code,
                        "armed_leg": "hunter",
                        **({
                            "fill_px": plan.fill_px,
                            "stop_level": plan.stop_level,
                            "tp_level": plan.tp_level,
                            "stop_pct": plan.stop_pct,
                            "fvg_confirm_ts": plan.fvg_confirm_ts,
                            "ratio": plan.ratio,
                        } if plan else {}),
                    }
            elif _leg_sweep:
                # HIGHER-TIMEFRAME AUTHORIZATION. The 5m sweep is a TIMING
                # trigger only; it may never create a live entry by itself.
                # Frames are fetched once per candle and the gate fails closed
                # on missing/stale/short/conflicting data.
                _htf_frames = self._htf_frames(feed_client, symbol, now)
                for direction in SIGNAL_DIRECTIONS:
                    plan, code = sweep_entry.evaluate(f.candles, direction, f.tick)
                    htf = sweep_htf_gate.evaluate_sweep_htf(
                        _htf_frames, direction=direction, now_ms=now,
                    )
                    sweep_htf[direction] = htf
                    sweep_plans[direction] = plan
                    directions[direction] = {
                        "confirmed": plan is not None and htf.authorized,
                        "reason_code": code if htf.authorized else (htf.refusal_code or code),
                        "armed_leg": "sweep",
                        "htf_authorized": htf.authorized,
                        "htf_refusal_code": htf.refusal_code,
                        "htf_frames": htf.evidence.get("frames"),
                        **({
                            "fill_px": plan.fill_px,
                            "stop_level": plan.stop_level,
                            "tp_level": plan.tp_level,
                            "stop_pct": plan.stop_pct,
                            "mode": plan.mode,
                            "swept_level": plan.swept_level,
                            "level_source": plan.level_source,
                        } if plan else {}),
                    }

            else:
                _stub = {
                    "confirmed": False,
                    "reason_code": "unsupported_leg_evaluator_not_wired",
                    "reason_detail": f"armed_leg={_armed_leg} — evaluator not wired in worker",
                    "armed_leg": _armed_leg,
                }
                for direction in SIGNAL_DIRECTIONS:
                    directions[direction] = _stub


        except Exception as e:  # evaluator bug — must not kill the worker
            # Same rule as the feed-error path: no decision is recorded, so a
            # crashed evaluator does not claim the candle. The next cycle can
            # still evaluate and trade it; the error is named on the event.
            bucket = signal_candle_bucket_ms(now)
            ekey = prefix + (bucket,)
            if ekey in self._signal_seen:
                return None
            obs = build_observation_id(user_id, connection_id, normalized, SIGNAL_INTERVAL_MIN, bucket)
            detail = self._base_signal_detail(
                status="error", observation_id=obs, symbol=symbol,
                normalized_symbol=normalized, candle_ts_ms=newest_ts, now_ms=now,
            )
            detail["reason_code"] = f"EVALUATOR_{type(e).__name__}"[:48]
            detail["error_text"] = str(e)[:SIGNAL_ERROR_TEXT_MAX_CHARS]
            if self._emit_signal_event(
                user_id=user_id, detail=detail, level="error",
                message="Observational evaluation failed: evaluator raised.",
            ):
                self._signal_seen[ekey] = "error"
                self._prune_signal_cache(prefix, bucket)
            return "error"

        # 5d. ONE canonical decision for this completed candle.
        #
        #     This replaces the three near-identical live bridges (§5a
        #     Accumulator, §5b Hunter, §5c Sweep) that used to live here. Each
        #     decided independently whether to fire and each `continue`d
        #     silently on its own private refusal, so a blocked trade left no
        #     record of WHY. There is now exactly one path:
        #
        #       decision -> safety checks -> order intent -> signer -> ApeX
        #
        #     A decision is recorded for EVERY enabled row on EVERY completed
        #     candle, including a row that cannot trade.
        #
        #     `_live_block` is deliberately NOT a gate here. It used to be, and
        #     that is what silenced the strategy: from 2026-07-31 17:35 the
        #     three bridges this replaced each required `_live_exec_ok`, so a
        #     connection that was paper-mode, unverified, or missing trade
        #     permission produced NO candidate, NO reason and NO event — it
        #     looked exactly like a dead strategy, for seven hours, while paper
        #     ran perfectly on the same candles.
        #
        #     The block belongs one layer down and is already there: it is the
        #     input to safety check 1 (`_connection_check`), which fails with
        #     the same code and stops the order intent. Recording the decision
        #     first is what makes the difference visible — "SHORT confirmed,
        #     blocked by CONNECTION_NOT_VERIFIED" instead of silence.
        #
        #     Both defects the original gate fixed stay fixed: no order intent
        #     is submitted for a blocked row, so no CONNECTION_NOT_VERIFIED
        #     rejection stream; and the several rows per candle are now one
        #     honest decision per connection, each carrying its own reason,
        #     rather than several identical-looking trade candidates.
        _decision_recorded = False
        try:
            self._decide_and_execute(
                cfg=cfg, user_id=user_id, connection_id=connection_id,
                symbol=symbol, normalized=normalized, now=now,
                feed=f, newest_ts=newest_ts, armed_leg=_armed_leg, gate=_gate,
                accum_results=accum_results, hunter_plans=hunter_plans,
                sweep_plans=sweep_plans, sweep_htf=sweep_htf,
                turtle_route_authorized=_route_enabled,
                feed_client=feed_client,

            )
            _decision_recorded = True
        except Exception as e:  # a decision bug must not kill the worker
            logging.warning(
                "Decision cycle raised (category=%s); heartbeat and guard "
                "unaffected.", type(e).__name__,
            )

        # 6. Dedup. One event per completed candle per (user, conn, symbol,
        #    interval). The result hash is stored BESIDE the key, never in it.
        rhash = signal_result_hash(directions)
        previous = self._signal_seen.get(key)
        if previous is not None:
            if previous != rhash:
                logging.warning(
                    "Observational signal result changed for an already-observed "
                    "candle (symbol=%s interval=%dm candle_ts=%d): stored=%s new=%s. "
                    "Suppressing a second event; this is not a new observation.",
                    normalized, SIGNAL_INTERVAL_MIN, newest_ts, previous, rhash,
                )
            return None

        obs = build_observation_id(user_id, connection_id, normalized, SIGNAL_INTERVAL_MIN, newest_ts)
        detail = self._base_signal_detail(
            status="evaluated", observation_id=obs, symbol=symbol,
            normalized_symbol=normalized, candle_ts_ms=newest_ts, now_ms=now,
        )
        # age_sec is RECORDED, never thresholded. B-6 defines no staleness
        # bound and none is invented here.
        detail["age_sec"] = round(f.age_sec, 1)
        detail["tick_size"] = f.tick
        detail["candle_count"] = len(f.candles)
        detail["directions"] = directions
        # Entry-gate telemetry — LIVE-READINESS PASS wiring. Pure evaluation
        # (classify_regime → leg_for_regime → evaluate_entry_authorization →
        # re-entry lockout) attached to the observational event. Blocked
        # candidates surface their block_code here; nothing is executed.
        try:
            detail["entry_gate"] = _live.entry_gate(
                f.candles, normalized, self._current_lockout_set,
            )
        except Exception as e:  # pragma: no cover - defensive
            detail["entry_gate"] = {"error": type(e).__name__}
        # Why this connection did or did not produce a decision. Previously the
        # live-participation gate was applied silently, so a connection that
        # could never trade looked identical to one that simply had no setup.
        detail["live_block_code"] = _live_block
        # Reports what ACTUALLY happened, not what the block code implies. A
        # blocked connection now records a decision (the block is safety check
        # 1, not a gate on observation), so the only thing that suppresses the
        # record is the decision cycle raising.
        detail["decision_recorded"] = _decision_recorded
        detail["assumptions"] = {
            # B-12 is accepted for THIS CONTROLLED PILOT ONLY — owner scope
            # ruling 2026-07-17. It is NOT a permanent global ratification of
            # the confirmation-candle ATR for swing grouping. The scope tag
            # travels with every observation so no downstream reader can
            # mistake pilot acceptance for settled specification.
            "B12_scope": "ACCUMULATOR_MAINNET_PILOT_V0",
            "B12_globally_ratified": False,
            "B12_confirmation_candle_atr": True,
            "ATR_IMPLEMENTATIONS_AGREE": bool(
                accumulator_signal.ATR_IMPLEMENTATIONS_AGREE
            ),
        }
        if self._emit_signal_event(
            user_id=user_id, detail=detail, level="info",
            message="Observational signal evaluation; no execution performed.",
        ):
            self._signal_seen[key] = rhash
            self._prune_signal_cache(prefix, newest_ts)
        return "evaluated"

    # ------------------------------------------------------------------
    # Scout Guardian — always-on Position Monitoring Layer.
    # ------------------------------------------------------------------
    def guardian_pass(self, now_ms: Optional[int] = None) -> Optional[dict]:
        """Supervise every open position with deterministic rules. EXECUTES NO
        ORDER and SIGNS NOTHING.

        Reads the open book via the signed OPEN_POSITIONS_READ op, fetches
        completed public candles per open symbol, runs the pure rule engine in
        `scout_guardian`, then (a) enqueues any action directives for the paper
        engine to enforce, and (b) logs a decision per position — including
        "hold, no action" — to the onyx_decisions ledger. All writes flow
        through worker-ingest (service role); the worker never touches a
        position row, a wallet, the signer or a venue.

        Returns a small summary dict (for tests/telemetry) or None when the
        pass could not run. Never raises: the caller's heartbeat must survive a
        broken feed, a rejected read, or an evaluator bug.
        """
        if not self.ingest:
            return None
        now = int(time.time() * 1000) if now_ms is None else int(now_ms)
        health_bucket = signal_candle_bucket_ms(now, GUARDIAN_INTERVAL_MIN)
        if getattr(self, "_last_guardian_bucket_ms", None) == health_bucket:
            return {
                "positions": 0, "decisions": 0, "directives": 0,
                "skipped": "health_bucket_already_checked",
                "health_bucket_ms": health_bucket,
            }

        # 1. Read the open book. Fail-safe: a rejected/absent read simply skips
        #    this cycle. We never fabricate an empty book that could suppress a
        #    real directive — a failed read yields None, not "nothing to do".
        try:
            positions = self.ingest.read_open_positions()
        except WorkerIngestAuthError as e:
            logging.warning("Guardian OPEN_POSITIONS_READ rejected category=%s", e)
            return None
        except WorkerIngestTransientError as e:
            logging.warning("Guardian OPEN_POSITIONS_READ transient failure category=%s", e)
            return None
        except Exception as e:  # pragma: no cover - defensive
            logging.warning("Guardian read raised unexpectedly category=%s", type(e).__name__)
            return None
        # Rebuild the re-entry lockout set once per cycle from the signed
        # `GUARDIAN_RECENT_CLOSES_READ` op — even on an empty book, so a
        # freshly-opened entry on the next cycle sees the lockout. Read
        # failure fails safe (empty set → no legitimate entry blocked).
        try:
            recent_closes = self.ingest.read_recent_guardian_closes() if self.ingest else []
        except (WorkerIngestAuthError, WorkerIngestTransientError) as e:
            logging.info("Recent closes read failed category=%s (lockout empty this cycle)", e)
            recent_closes = []
        except Exception as e:  # pragma: no cover - defensive
            logging.warning("Recent closes read raised category=%s (lockout empty this cycle)", type(e).__name__)
            recent_closes = []
        self._current_lockout_set = _live.build_lockout_set(recent_closes, now)
        if not positions:
            self._last_guardian_bucket_ms = health_bucket
            return {
                "positions": 0, "decisions": 0, "directives": 0,
                "health_bucket_ms": health_bucket,
            }

        # 2. Market data per unique open symbol. Public candles only, one fetch
        #    per symbol per cycle. A symbol whose feed fails is simply absent
        #    from the map; its positions get a recorded HOLD (no_market_data).
        feed = self._signal_feed()
        market_by_symbol: dict[str, dict] = {}
        symbols = {str(p.get("symbol") or "") for p in positions if p.get("symbol")}
        stale_alarms: dict[str, int] = {}
        for sym in symbols:
            if not sym:
                continue
            try:
                f = feed.fetch(sym, GUARDIAN_INTERVAL_MIN, need=GUARDIAN_NEED_CANDLES, now_ms=now)
            except (market_data.FeedError, ValueError) as e:
                logging.info("Guardian feed unusable symbol=%s category=%s", sym, type(e).__name__)
                n = self._guardian_stale_cycles.get(sym, 0) + 1
                self._guardian_stale_cycles[sym] = n
                if n >= scout_guardian.STALE_DATA_CYCLES:
                    stale_alarms[sym] = n
                    logging.warning("Guardian data_stale symbol=%s cycles=%d", sym, n)
                continue
            self._guardian_stale_cycles.pop(sym, None)
            market_by_symbol[sym] = {
                "candles": f.candles,
                "tick": f.tick,
                "mark": float(f.candles[-1][accumulator_signal.CLOSE]),
            }

        # 3. Pure deterministic evaluation. No I/O, no orders, no LLM.
        try:
            result = scout_guardian.evaluate_portfolio(positions, market_by_symbol, now_ms=now)
        except Exception as e:  # evaluator bug must not kill the worker
            logging.warning("Guardian evaluator raised category=%s", type(e).__name__)
            return None

        # 4. Merge per-position verdicts with portfolio cluster directives.
        #    A position flagged only by rules A/B keeps its verdict; a position
        #    swept into a dying cluster is upgraded to a close.
        user_by_pid: dict[str, str] = {}
        for p in positions:
            pid = str(p.get("id") or "")
            uid = p.get("user_id")
            if pid and isinstance(uid, str):
                user_by_pid[pid] = uid

        verdict_by_pid = {v.position_id: v for v in result.verdicts}
        # (position_id, directive_type) -> directive dict, deduped.
        directive_map: dict[tuple, dict] = {}
        # position_id -> (decision, reason_code) override from cluster rule.
        cluster_override: dict[str, str] = {}

        def _register_directive(pid: str, d: "scout_guardian.Directive") -> None:
            uid = user_by_pid.get(pid)
            if not uid:
                return
            key = (pid, d.directive_type)
            if key in directive_map:
                return
            directive_map[key] = {
                "user_id": uid,
                "position_id": pid,
                "symbol": d.symbol,
                "wallet_key": d.wallet_key,
                "directive_type": d.directive_type,
                "reason_code": d.reason_code,
                "evidence": scout_guardian_bound(d.evidence),
                "correlation_id": None,  # filled below with the cycle id
                "guardian_cycle_ts_ms": now,
            }

        for v in result.verdicts:
            for d in v.directives:
                _register_directive(v.position_id, d)
        for d in result.cluster_directives:
            _register_directive(d.position_id, d)
            if d.directive_type == scout_guardian.DIRECTIVE_CLOSE_POSITION:
                cluster_override[d.position_id] = d.reason_code

        cycle_corr = str(uuid.uuid4())
        for entry in directive_map.values():
            entry["correlation_id"] = cycle_corr

        # 4b. LIVE-READINESS wiring — per-position parity checks. Pure logic
        # from worker_live_wiring; every branch is call-site glue over the
        # already-tested modules (max_loss, htf_bos, stop_verification).
        # Nothing here signs, submits, or mutates state. Repair/promotion
        # directives are recorded so they translate the moment live flags
        # open; today (paper_simulate=true) they are telemetry only.
        # (The re-entry lockout set was built above, before the empty-book
        # early return, so every cycle refreshes it.)
        parity_evidence: dict[str, dict] = {}
        for p in positions:
            pid = str(p.get("id") or "")
            uid = user_by_pid.get(pid)
            if not pid or not uid:
                continue
            sym = str(p.get("symbol") or "")
            md = market_by_symbol.get(sym) or {}
            candles = md.get("candles") or []
            tick = float(md.get("tick") or 0.0)
            mark = float(md.get("mark") or 0.0)
            info: dict = {}

            # (a) Max-loss cap → close directive with reason="max_loss_cap".
            if candles:
                ml = _live.evaluate_max_loss(p, candles[-1])
                info["max_loss"] = {
                    "triggered": ml["triggered"],
                    "unrealized_worst": round(ml["unrealized_worst"], 6),
                    "margin": round(ml["margin"], 6),
                }
                if ml["triggered"]:
                    key = (pid, scout_guardian.DIRECTIVE_CLOSE_POSITION)
                    if key not in directive_map:
                        directive_map[key] = {
                            "user_id": uid,
                            "position_id": pid,
                            "symbol": sym,
                            "wallet_key": p.get("wallet_key") if isinstance(p.get("wallet_key"), str) else None,
                            "directive_type": scout_guardian.DIRECTIVE_CLOSE_POSITION,
                            "reason_code": "max_loss_cap",
                            "evidence": {"rule": "max_loss_cap", **info["max_loss"]},
                            "correlation_id": cycle_corr,
                            "guardian_cycle_ts_ms": now,
                        }

            # (b) HTF promotion — profitable + aligned + not-promoted.
            # Emits three directives: promote_runner, cancel_fixed_tp,
            # set_breakeven_stop (bank_fraction=0 — no partial closes).
            if candles and tick > 0 and mark > 0:
                try:
                    htf = _live.evaluate_htf_promotion(p, candles, tick, mark)
                except Exception as e:  # pragma: no cover - defensive
                    htf = {"promote": False, "error": type(e).__name__}
                info["htf"] = {
                    "state": htf.get("state"),
                    "aligned": htf.get("aligned"),
                    "profitable": htf.get("profitable"),
                    "already_promoted": htf.get("already_promoted"),
                    "promote": htf.get("promote"),
                }
                if htf.get("promote"):
                    be = None
                    ep = p.get("entry_price")
                    try:
                        be = float(ep) if ep is not None else None
                    except (TypeError, ValueError):
                        be = None
                    for dtype, ev in (
                        ("promote_runner", {"rule": "htf_promotion", "bank_fraction": 0}),
                        ("cancel_fixed_tp", {"rule": "htf_promotion"}),
                        ("set_breakeven_stop", {"rule": "htf_promotion", "breakeven_stop": be}),
                    ):
                        k = (pid, dtype)
                        if k in directive_map:
                            continue
                        directive_map[k] = {
                            "user_id": uid,
                            "position_id": pid,
                            "symbol": sym,
                            "wallet_key": p.get("wallet_key") if isinstance(p.get("wallet_key"), str) else None,
                            "directive_type": dtype,
                            "reason_code": "htf_promotion",
                            "evidence": ev,
                            "correlation_id": cycle_corr,
                            "guardian_cycle_ts_ms": now,
                        }

            if info:
                parity_evidence[pid] = info

        # (c) Stop verification — every cycle. paper_simulate=true today, so
        # we emit STOP_VERIFY_OK / STOP_VERIFY_WOULD_REPAIR telemetry only;
        # the repair directive path is exercised the moment live flags open.
        try:
            stop_summary = _live.stop_verify_summary(positions, exchange_orders=[])
        except Exception as e:  # pragma: no cover - defensive
            stop_summary = {"error": type(e).__name__, "per_position": {}}
        for pid, entry in stop_summary.get("per_position", {}).items():
            parity_evidence.setdefault(pid, {})["stop_verify"] = entry
            logging.info(
                "stop_verify pid=%s status=%s reason=%s paper_simulate=%s",
                pid, entry.get("status"), entry.get("reason"),
                stop_summary.get("paper_simulate", True),
            )


        # 5. Build a decision row for EVERY position (audit trail incl. hold).
        decisions: list[dict] = []
        for p in positions:
            pid = str(p.get("id") or "")
            uid = user_by_pid.get(pid)
            if not uid:
                continue
            v = verdict_by_pid.get(pid)
            side = v.side if v else scout_guardian.position_side(p)
            symbol = v.symbol if v else str(p.get("symbol") or "")
            decision = v.decision if v else "hold"
            reason = v.reason_code if v else None
            evidence = dict(v.evidence) if v else {}
            if pid in cluster_override:
                decision = "close"
                reason = cluster_override[pid]
                evidence = {**evidence, "cluster_override": True}
            elif symbol in stale_alarms:
                # Guardian v2 data-health alarm: worker escalates silent
                # no_market_data HOLDs to a distinct data_stale decision
                # once the counter passes STALE_DATA_CYCLES. No close.
                reason = scout_guardian.REASON_DATA_STALE
                evidence = {
                    **evidence,
                    "rule": "data_stale",
                    "stale_cycles": stale_alarms[symbol],
                    "stale_threshold": scout_guardian.STALE_DATA_CYCLES,
                }
            # Live-readiness parity evidence (max_loss/htf/stop_verify) attached
            # per decision so /shadow + audit see the full picture.
            pev = parity_evidence.get(pid)
            if pev:
                evidence = {**evidence, "parity": pev}
            supporting = [reason] if reason else []
            decisions.append({
                "user_id": uid,
                "correlation_id": cycle_corr,
                "symbol": symbol or "UNKNOWN",
                "side": side,
                "decision": decision,
                "detail": scout_guardian_bound(evidence),
                "supporting_codes": supporting,
            })

        directives = list(directive_map.values())

        # 6. Emit directives FIRST (risk-reducing enforcement), then decisions
        #    (audit). Each is isolated so one failing never blocks the other.
        self._emit_guardian_directives(directives)
        self._emit_guardian_decisions(decisions)

        # 7. Shadow ledger — best-effort write of every paper decision so the
        #    /shadow surface can compare paper vs live once live activates.
        #    Server op may not yet be enabled; a rejection is swallowed and
        #    never blocks the cycle.
        self._emit_shadow_ledger(decisions, cycle_corr, now)
        self._last_guardian_bucket_ms = health_bucket

        return {
            "positions": len(positions),
            "decisions": len(decisions),
            "directives": len(directives),
            "correlation_id": cycle_corr,
            "health_bucket_ms": health_bucket,
            "stop_verify": {
                "checked": stop_summary.get("checked", 0),
                "would_repair": stop_summary.get("would_repair", 0),
                "paper_simulate": stop_summary.get("paper_simulate", True),
            },
        }

    def _emit_shadow_ledger(self, decisions: list[dict], cycle_corr: str, now_ms: int) -> None:
        if not self.ingest or not decisions:
            return
        rows = []
        for d in decisions:
            uid = d.get("user_id")
            side = d.get("side")
            # Server drops flat rows (table CHECK is long|short); skip client-side
            # to keep batches tight and to avoid burning validation slots.
            if not isinstance(uid, str) or side not in ("long", "short"):
                continue
            rows.append({
                "source": "paper",
                "user_id": uid,
                "leg": "guardian",
                "cycle_ts_ms": now_ms,
                "symbol": d.get("symbol"),
                "side": side,
                "decision": d.get("decision"),
                "reason_code": (d.get("supporting_codes") or [None])[0],
                "correlation_id": cycle_corr,
                "detail": d.get("detail") or {},
            })
        for i in range(0, len(rows), GUARDIAN_BATCH_SIZE):
            batch = rows[i:i + GUARDIAN_BATCH_SIZE]
            if not batch:
                continue
            try:
                self.ingest.insert_shadow_ledger(batch)
            except WorkerIngestAuthError as e:
                # Op not yet enabled server-side is expected pre-live.
                logging.info("Shadow ledger batch rejected category=%s (expected pre-live)", e)
            except WorkerIngestTransientError as e:
                logging.warning("Shadow ledger batch transient failure category=%s", e)
            except Exception as e:  # pragma: no cover - defensive
                logging.warning("Shadow ledger emit raised category=%s", type(e).__name__)



    def _emit_guardian_directives(self, directives: list[dict]) -> None:
        for i in range(0, len(directives), GUARDIAN_BATCH_SIZE):
            batch = directives[i:i + GUARDIAN_BATCH_SIZE]
            if not batch:
                continue
            try:
                self.ingest.upsert_guardian_directives(batch)
            except WorkerIngestAuthError as e:
                logging.warning("Guardian directive batch rejected category=%s", e)
            except WorkerIngestTransientError as e:
                logging.warning("Guardian directive batch transient failure category=%s", e)
            except Exception as e:  # pragma: no cover - defensive
                logging.warning("Guardian directive emit raised category=%s", type(e).__name__)

    def _emit_guardian_decisions(self, decisions: list[dict]) -> None:
        for i in range(0, len(decisions), GUARDIAN_BATCH_SIZE):
            batch = decisions[i:i + GUARDIAN_BATCH_SIZE]
            if not batch:
                continue
            try:
                self.ingest.insert_guardian_decisions(batch)
            except WorkerIngestAuthError as e:
                logging.warning("Guardian decision batch rejected category=%s", e)
            except WorkerIngestTransientError as e:
                logging.warning("Guardian decision batch transient failure category=%s", e)
            except Exception as e:  # pragma: no cover - defensive
                logging.warning("Guardian decision emit raised category=%s", type(e).__name__)

    # ------------------------------------------------------------------
    # Main loop
    # ------------------------------------------------------------------
    def _run_config_group(self, configs) -> None:
        """Serialize one venue's entries while isolating per-route failures."""
        for cfg in configs:
            user_id, connection_id = cfg.get("user_id"), cfg.get("connection_id")
            if not user_id or not connection_id:
                continue
            try:
                if self.halted(user_id, connection_id):
                    continue
                if cfg.get("scan_only") is True:
                    self.observe_market_watch(cfg, user_id, connection_id)
                else:
                    self.observe_signal(cfg, user_id, connection_id)
            except Exception as exc:
                logging.warning("Route evaluation/execution failed (category=%s); other routes continue.", type(exc).__name__)

    def _run_config_cycle(self, configs) -> None:
        """Evaluate independent venues concurrently; same-venue work stays ordered.

        Each venue owns its public-feed Session. Database mandate reservations
        serialize actual admission across replicas and same-plan requests.
        """
        groups = {}
        for cfg in configs:
            if isinstance(cfg, dict):
                groups.setdefault(cfg.get("exchange_type"), []).append(cfg)
        if len(groups) < 2:
            for group in groups.values():
                self._run_config_group(group)
            return
        with ThreadPoolExecutor(max_workers=3, thread_name_prefix="turtle-venue") as pool:
            futures = [pool.submit(self._run_config_group, group) for group in groups.values()]
            for future in futures:
                future.result()

    def run(self) -> None:
        logging.info(
            "TurtleBot worker running (mode=%s, automation_requested=%s, "
            "order_transport_configured=%s).",
            self.mode,
            LIVE_TRADING_ENABLED,
            self._broker_secret() is not None and self._broker_base_url() is not None,
        )
        self.report_heartbeat()

        while True:
            if not self.credentials_ok:

                # Attempt recovery. Does not enable trading — only restores reads.
                self.try_recover()

            if self.credentials_ok:
                # CHECKPOINT 4 — first cycle post-boot (or post-recovery)
                # gets a fresh config read AND a fresh guard read for every
                # (user, connection) before any Stage-3 strategy work runs.
                # halted() already fetches fresh (no cache); this comment
                # documents the invariant so future refactors do not add one.
                if self._first_cycle_after_boot or self._post_recovery_pending:
                    logging.info(
                        "First cycle after %s: forcing fresh config + guard reads.",
                        "recovery" if self._post_recovery_pending else "boot",
                    )
                    self._first_cycle_after_boot = False
                    self._post_recovery_pending = False
                configs = self.fetch_active_configs()
                try:
                    self._synfutures_protection_pass(configs)
                except Exception:
                    logging.warning("SYNFUTURES_MONITOR_UNAVAILABLE")
                self._run_config_cycle(configs)

                # SCOUT GUARDIAN — always-on, portfolio-level (NOT per-config).
                # Runs once per cycle over EVERY open position regardless of
                # which strategy opened it. It only records deterministic
                # decisions and enqueues risk-reducing directives; it signs
                # nothing and submits no order. Deliberately NOT gated by the
                # per-config kill switch: reducing risk on an open position is
                # always safe, and the enforcement lives in the paper engine,
                # not on any live-venue path. Wrapped so a feed/evaluator/ingest
                # failure can never terminate the worker or block the heartbeat.
                try:
                    self.guardian_pass()
                except Exception as e:
                    logging.warning(
                        "Guardian pass raised unexpectedly (category=%s); "
                        "heartbeat and guard unaffected.",
                        type(e).__name__,
                    )

            if not self.credentials_ok:
                try:
                    self._synfutures_protection_pass(self.fetch_active_configs())
                except Exception:
                    logging.warning("SYNFUTURES_MONITOR_UNAVAILABLE")

            # Proof-of-life trade command channel. Owner-triggered one-shot
            # test order. The row is atomically marked `consumed` on the server
            # BEFORE submit_order_intent is called (see WORKER_COMMAND_CLAIM),
            # so a crash mid-flight cannot double-fire. Any failure is caught
            # and reported back via complete_worker_command; the worker never
            # aborts on this path.
            try:
                self._maybe_fire_proof_of_life()
            except Exception as e:
                logging.warning(
                    "Proof-of-life pass raised unexpectedly (category=%s); "
                    "cycle continues.",
                    type(e).__name__,
                )

            self.report_heartbeat()
            time.sleep(15)


if __name__ == "__main__":
    try:
        log_worker_version()
        bot = RailwayTurtleBot()
        bot.run()
    except Exception as e:
        logging.exception("Fatal worker error: %s", e)
        time.sleep(10)
        raise
