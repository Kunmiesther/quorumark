"""LIVE TEST MODE — owner-authorized, deterministic, isolated.

Owner directive (2026-08-04, supersedes the prior "entry keeps its stop"
ruling FOR THIS PHASE ONLY):

  * entry is submitted with NO take-profit AND NO stop-loss attached,
  * nothing auto-creates protective TP/SL immediately after the fill,
  * the management clock starts only on a confirmed ApeX fill, and the
    council decides TP/exit after three fully CLOSED candles,
  * margin mode is CROSS, never isolated.

This module is the ONLY place the test-mode switch is read, so the standard
(non-test) strategy policy is untouched: with the flag off, entries still
require an atomically-attached STOP and `NO_EXIT_PLAN` still fires. Flip the
env var off and the normal policy is back with no code change.

Account-level protections are explicitly NOT part of this bypass: the kill
switch, owner exposure caps, equity floor, canonical authentication and the
venue's own liquidation engine all keep running.
"""
from __future__ import annotations

import os
from typing import Mapping

#: Environment variable that arms the phase. Any of "1"/"true"/"yes"/"on".
LIVE_TEST_MODE_ENV = "SIGNER_LIVE_TEST_MODE"

_TRUE = {"1", "true", "yes", "on"}

#: Fields that would select isolated margin. Presence of any is a hard error:
#: the owner's rule is CROSS ONLY, and a silent isolated order is the exact
#: failure this guard exists to prevent.
_MARGIN_MODE_KEYS = ("marginMode", "margin_mode", "positionMode", "isIsolated", "isolated")


class MarginModeViolation(RuntimeError):
    """Raised when a submission would violate a test-mode invariant."""


def live_test_mode_enabled(env: Mapping[str, str] | None = None) -> bool:
    src = os.environ if env is None else env
    return str(src.get(LIVE_TEST_MODE_ENV, "")).strip().lower() in _TRUE


def entry_without_protections(
    *,
    reduce_only: bool,
    proof_exempt: bool,
    purpose: str | None = None,
    env: Mapping[str, str] | None = None,
) -> bool:
    """True when THIS entry must go out bare (no attached SL, no TP ladder).

    Reduce-only exits and proof-of-life already have their own dedicated
    branches upstream; they are never re-labelled as test-mode entries.
    """
    # Automated entries always require the atomically attached stop, even
    # during an owner-authorized manual no-stop test phase.
    if reduce_only or proof_exempt or (purpose or "").strip().lower() == "automated_entry":
        return False
    return live_test_mode_enabled(env)


def assert_cross_margin(params: Mapping[str, object]) -> None:
    """CROSS ONLY. Refuse any order payload that names a margin mode.

    ApeX Omni takes margin mode from account/position configuration, not from
    the order payload, so the correct payload carries NO margin-mode field at
    all. Anything that starts setting one has to come back through this guard
    and prove it is cross.
    """
    for key in _MARGIN_MODE_KEYS:
        if key not in params:
            continue
        value = str(params[key]).strip().lower()
        if value in ("cross", "crossed", "false"):
            continue
        raise MarginModeViolation(f"ISOLATED_MARGIN_FORBIDDEN:{key}={value}")
