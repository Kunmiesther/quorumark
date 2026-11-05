"""Durable, sanitized venue-rejection classification.

WHY THIS EXISTS
---------------
Railway containers rotate. Any diagnostic that lives only in stdout is gone
the moment a deployment is marked REMOVED — which is exactly what happened to
the `UPSTREAM_REJECT:3` line the owner needed. Everything a human needs to
understand a venue reject must therefore travel back in the HTTP response and
land in the durable ledger (`order_audit` / `order_intents`).

CONTRACT
--------
`classify_venue_reject(code, message)` returns a SAFE triple:

    code      -> alphanumeric venue code, bounded (e.g. "3")
    category  -> ALLOWLISTED constant, never venue text
    message   -> allowlisted safe phrase, or None

Unknown venue text is NEVER echoed. It collapses to the category
`VENUE_REJECT_UNCLASSIFIED` with `message=None`. This is deliberate: raw venue
bodies may embed account identifiers, order ids, or key fragments, and a
"just truncate it" policy leaks the first 512 bytes of whatever the venue felt
like sending.

The wire token is `UPSTREAM_REJECT:<code>:<CATEGORY>` so existing readers that
prefix-match `UPSTREAM_REJECT:` keep working while gaining the category.
"""
from __future__ import annotations

import os
import re
from typing import Optional, Tuple

MAX_CODE_LEN = 32
MAX_MESSAGE_LEN = 120

UNCLASSIFIED = "VENUE_REJECT_UNCLASSIFIED"

# (category, safe canonical message, matching substrings — lowercase)
# Ordered: first match wins, so specific patterns precede generic ones.
_RULES: tuple[tuple[str, str, tuple[str, ...]], ...] = (
    ("VENUE_REJECT_INSUFFICIENT_MARGIN", "Insufficient available margin at venue",
     ("insufficient margin", "insufficient available", "not enough margin",
      "insufficient balance", "not enough balance", "available balance")),
    ("VENUE_REJECT_POSITION_LIMIT", "Position or notional limit exceeded",
     ("position limit", "max position", "exceed position", "risk limit",
      "notional limit")),
    ("VENUE_REJECT_LEVERAGE", "Leverage not permitted for this symbol",
     ("leverage",)),
    ("VENUE_REJECT_PRICE_BOUNDS", "Price outside permitted band",
     ("price limit", "price band", "price deviat", "out of range price",
      "price is too", "price exceed")),
    ("VENUE_REJECT_SIZE_PRECISION", "Size or price precision violates venue step",
     ("step size", "tick size", "precision", "scale", "lot size",
      "min order", "minimum order", "size too small", "quantity")),
    ("VENUE_REJECT_REDUCE_ONLY", "Reduce-only constraint violated",
     ("reduce only", "reduce-only", "no position to close")),
    ("VENUE_REJECT_DUPLICATE", "Duplicate client order id at venue",
     ("duplicate", "already exist", "repeat order")),
    ("VENUE_REJECT_SIGNATURE", "Venue rejected request signature",
     ("signature", "sign check", "verify fail")),
    ("VENUE_REJECT_AUTH", "Venue rejected credentials or permissions",
     ("unauthorized", "permission", "api key", "forbidden", "not allowed")),
    ("VENUE_REJECT_RATE_LIMITED", "Venue rate limit reached",
     ("rate limit", "too many request", "frequenc")),
    ("VENUE_REJECT_MARKET_STATE", "Symbol not tradable in current market state",
     ("market clos", "suspend", "delist", "halt", "not tradable",
      "maintenance")),
    # ApeX returns machine keys (e.g. "COMMON_PARAMS_ERROR",
    # "ORDER_PARAMS_ERROR") rather than prose on many code=3 rejects. Match
    # the key tokens so the reject stops collapsing to UNCLASSIFIED.
    ("VENUE_REJECT_INVALID_PARAMS", "Venue rejected order parameters",
     ("params_error", "param_error", "params error", "param error",
      "invalid param", "illegal param", "invalid_param", "illegal_argument",
      "parameter")),
    ("VENUE_REJECT_ACCOUNT_STATE", "Venue account not ready for trading",
     ("account_not", "not registered", "no_account", "account not exist",
      "unregistered", "account status")),
)


ALLOWED_CATEGORIES = frozenset([c for c, _m, _s in _RULES] + [UNCLASSIFIED])


def _safe_code(code: object) -> str:
    s = "".join(ch for ch in str(code) if ch.isalnum() or ch in "_-")[:MAX_CODE_LEN]
    return s or "UNKNOWN"


def classify_venue_reject(code: object, message: object = None) -> Tuple[str, str, Optional[str]]:
    """Return `(safe_code, category, safe_message)`. Never raises."""
    safe_code = _safe_code(code)
    try:
        text = "" if message is None else str(message)
    except Exception:
        text = ""
    # Collapse whitespace before matching; bound the scan so a multi-megabyte
    # body cannot turn classification into a CPU sink.
    scan = re.sub(r"\s+", " ", text)[:4096].lower()
    if scan:
        for category, safe_message, needles in _RULES:
            if any(n in scan for n in needles):
                return safe_code, category, safe_message[:MAX_MESSAGE_LEN]
    return safe_code, UNCLASSIFIED, None


def venue_reject_token(code: object, message: object = None) -> str:
    """`UPSTREAM_REJECT:<code>:<CATEGORY>` — the value carried to the broker."""
    safe_code, category, _msg = classify_venue_reject(code, message)
    return f"UPSTREAM_REJECT:{safe_code}:{category}"


_MESSAGE_FIELDS = (
    "msg", "message", "errorMessage", "error_msg", "detail", "detailMsg",
    # ApeX frequently sends only a machine key on code=3 rejects; without
    # these the classifier saw nothing and every reject read UNCLASSIFIED.
    "key", "errorCode", "error_code", "errCode", "reason", "errorKey",
)

_ERROR_LIST_FIELDS = ("errors", "errorList", "failures")


def extract_venue_message(payload: object, _depth: int = 0) -> Optional[str]:
    """Pull the venue's error text or machine key out of a parsed ApeX body.

    Only well-known fields are consulted — we never scrape the whole body —
    and the value is handed straight to the allowlist classifier, so it is
    never persisted verbatim.
    """
    if not isinstance(payload, dict) or _depth > 3:
        return None
    for key in _MESSAGE_FIELDS:
        v = payload.get(key)
        if isinstance(v, str) and v.strip():
            return v
    for key in _ERROR_LIST_FIELDS:
        items = payload.get(key)
        if isinstance(items, (list, tuple)):
            for item in items[:8]:
                if isinstance(item, str) and item.strip():
                    return item
                found = extract_venue_message(item, _depth + 1)
                if found:
                    return found
    for key in ("data", "detail"):
        nested = payload.get(key)
        if isinstance(nested, dict):
            found = extract_venue_message(nested, _depth + 1)
            if found:
                return found
    return None



def signer_revision() -> str:
    """Deployed revision identifier, for correlating a reject to a build."""
    for var in ("RAILWAY_GIT_COMMIT_SHA", "RAILWAY_DEPLOYMENT_ID", "GIT_SHA",
                "SOURCE_VERSION", "SIGNER_REVISION"):
        v = os.environ.get(var)
        if v:
            return _safe_code(v)[:MAX_CODE_LEN]
    return "unknown"


_CATEGORY_MESSAGE = {c: m for c, m, _s in _RULES}


def safe_message_for_category(category: Optional[str]) -> Optional[str]:
    """Allowlisted phrase for a category, or None (incl. unclassified)."""
    if not category:
        return None
    return _CATEGORY_MESSAGE.get(category)


def facts_from_token(token: object) -> dict:
    """Split `...:UPSTREAM_REJECT:<code>:<CATEGORY>` into sanitized fields."""
    raw = str(token or "")
    parts = raw.split(":")
    try:
        i = parts.index("UPSTREAM_REJECT")
    except ValueError:
        return {"signer_mapping": _safe_code(parts[0] or "UNKNOWN"),
                "venue_code": None, "venue_category": None, "venue_message": None}
    code = _safe_code(parts[i + 1]) if len(parts) > i + 1 else None
    category = parts[i + 2] if len(parts) > i + 2 else UNCLASSIFIED
    if category not in ALLOWED_CATEGORIES:
        category = UNCLASSIFIED
    return {
        "signer_mapping": _safe_code(parts[0] or "UNKNOWN"),
        "venue_code": code,
        "venue_category": category,
        "venue_message": safe_message_for_category(category),
    }


# --- Redacted raw-reject recorder (owner diagnostics only) ----------------
#
# WHY: a code=3 reject that collapses to VENUE_REJECT_UNCLASSIFIED tells the
# operator nothing, and Railway stdout is gone the moment the deployment
# rotates. This keeps the last few venue rejects in process memory in a
# REDACTED form so an HMAC-authenticated owner probe can read them back.
#
# It is NOT a bypass of the sanitizer: the normal response path still returns
# only allowlisted categories. Nothing here is ever persisted, returned to the
# broker, or written to the ledger.

import collections
import time as _time

_RAW_REJECTS: "collections.deque[dict]" = collections.deque(maxlen=10)

# Long hex runs (keys, addresses, signatures, order ids) and long digit runs
# (account ids) are the only things in a venue error body that could be
# sensitive. Both are replaced before the text is ever stored.
_REDACT_PATTERNS = (
    (re.compile(r"0x[0-9a-fA-F]{8,}"), "0x<redacted>"),
    (re.compile(r"\b[0-9a-fA-F]{16,}\b"), "<hex>"),
    (re.compile(r"\b\d{8,}\b"), "<num>"),
)


def redact_venue_text(text: object, limit: int = 300) -> Optional[str]:
    """Whitespace-collapsed, identifier-stripped, bounded venue text."""
    if text is None:
        return None
    try:
        s = re.sub(r"\s+", " ", str(text)).strip()
    except Exception:
        return None
    if not s:
        return None
    for pattern, replacement in _REDACT_PATTERNS:
        s = pattern.sub(replacement, s)
    return s[:limit]


def record_raw_reject(*, source: str, code: object, message: object) -> None:
    """Remember one redacted venue reject for the owner diagnostic probe."""
    try:
        _RAW_REJECTS.append({
            "at": int(_time.time()),
            "source": _safe_code(source),
            "code": _safe_code(code),
            "text": redact_venue_text(message),
        })
    except Exception:
        pass


def recent_raw_rejects() -> list[dict]:
    return list(_RAW_REJECTS)
