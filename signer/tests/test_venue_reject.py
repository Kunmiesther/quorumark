"""Sanitized venue-rejection observability (durable, container-rotation proof)."""
from __future__ import annotations

from app.venue_reject import (
    ALLOWED_CATEGORIES, UNCLASSIFIED, classify_venue_reject, extract_venue_message,
    facts_from_token, venue_reject_token,
)


# --- code 3: the reject the owner lost to container rotation ---------------
def test_code_3_insufficient_margin_keeps_category():
    code, category, msg = classify_venue_reject(3, "Insufficient margin for this order")
    assert code == "3"
    assert category == "VENUE_REJECT_INSUFFICIENT_MARGIN"
    assert msg == "Insufficient available margin at venue"


def test_code_3_token_shape_is_backward_compatible():
    tok = venue_reject_token(3, "insufficient balance")
    assert tok.startswith("UPSTREAM_REJECT:3:")
    assert tok.endswith("VENUE_REJECT_INSUFFICIENT_MARGIN")


def test_facts_round_trip_through_wrapped_token():
    f = facts_from_token("ENTRY_SUBMIT_FAILED:UPSTREAM_REJECT:3:VENUE_REJECT_INSUFFICIENT_MARGIN")
    assert f["signer_mapping"] == "ENTRY_SUBMIT_FAILED"
    assert f["venue_code"] == "3"
    assert f["venue_category"] == "VENUE_REJECT_INSUFFICIENT_MARGIN"
    assert f["venue_message"] == "Insufficient available margin at venue"


# --- unknown / hostile venue text never becomes raw output -----------------
def test_unknown_message_is_unclassified_and_dropped():
    code, category, msg = classify_venue_reject(9999, "totally novel venue prose")
    assert category == UNCLASSIFIED
    assert msg is None


def test_oversized_message_does_not_leak_and_is_bounded():
    hostile = "A" * 500_000 + " secret 0x" + "de" * 40
    code, category, msg = classify_venue_reject(7, hostile)
    assert category == UNCLASSIFIED and msg is None
    assert len(code) <= 32


def test_secret_and_header_material_never_survives_classification():
    leaky = ("Authorization: Bearer abc.def.ghi APEX-SIGNATURE=zzz "
             "l2_key=0x" + "ab" * 40 + " insufficient margin")
    _code, category, msg = classify_venue_reject(3, leaky)
    assert category == "VENUE_REJECT_INSUFFICIENT_MARGIN"
    # Only the canonical allowlisted phrase — never the venue's own bytes.
    assert msg == "Insufficient available margin at venue"
    for needle in ("Bearer", "APEX-SIGNATURE", "l2_key", "0x"):
        assert needle not in (msg or "")


def test_control_characters_and_injection_are_not_echoed():
    _c, category, msg = classify_venue_reject("3\n\r<script>", "<script>alert(1)</script>")
    assert category == UNCLASSIFIED and msg is None


def test_code_is_alphanumeric_bounded():
    code, _cat, _m = classify_venue_reject("../../etc/passwd" + "x" * 100)
    assert code.isalnum() or all(ch.isalnum() or ch in "_-" for ch in code)
    assert len(code) <= 32


# --- category allowlist ----------------------------------------------------
def test_every_emitted_category_is_allowlisted():
    samples = ["leverage too high", "price band exceeded", "step size invalid",
               "reduce only rejected", "duplicate order", "signature invalid",
               "unauthorized api key", "rate limit", "market closed",
               "position limit", "insufficient margin", "nothing familiar"]
    for s in samples:
        _c, category, _m = classify_venue_reject(1, s)
        assert category in ALLOWED_CATEGORIES


def test_unknown_category_in_token_collapses_to_unclassified():
    f = facts_from_token("ENTRY_SUBMIT_FAILED:UPSTREAM_REJECT:3:MADE_UP_CATEGORY")
    assert f["venue_category"] == UNCLASSIFIED
    assert f["venue_message"] is None


# --- ambiguity / timeouts are NOT venue rejects ----------------------------
def test_timeout_token_carries_no_venue_code():
    f = facts_from_token("SIGNER_TIMEOUT")
    assert f["signer_mapping"] == "SIGNER_TIMEOUT"
    assert f["venue_code"] is None
    assert f["venue_category"] is None


def test_missing_or_empty_token_is_safe():
    for tok in (None, "", ":::"):
        f = facts_from_token(tok)
        assert f["venue_message"] is None


# --- message extraction ----------------------------------------------------
def test_extract_message_only_reads_known_fields():
    assert extract_venue_message({"msg": "Insufficient margin"}) == "Insufficient margin"
    assert extract_venue_message({"data": {"message": "leverage"}}) == "leverage"
    assert extract_venue_message({"apiKey": "leaky"}) is None
    assert extract_venue_message("not a dict") is None


# --- idempotent duplicate responses ----------------------------------------
def test_repeated_classification_is_deterministic():
    a = classify_venue_reject(3, "Insufficient margin")
    b = classify_venue_reject(3, "Insufficient margin")
    assert a == b


# --- diagnostics mutate nothing --------------------------------------------
def test_module_exposes_no_mutating_entry_points():
    import app.venue_reject as m
    for name in dir(m):
        assert not name.startswith(("create_", "cancel_", "submit_", "close_", "update_"))
