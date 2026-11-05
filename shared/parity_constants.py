"""Shared parity constants loader (Python side).

Reads shared/mainnet_parity_constants.json and exposes typed accessors.
Companion to src/lib/paper/parityConstants.ts. Both sides load the SAME
file — that is the mechanism enforcing paper<->live parity for the fields
listed in docs/MAINNET_PARITY.md §2.

NEVER hard-code a value here that already exists in the JSON. NEVER add a
default that could mask a missing JSON key: if the JSON is broken, we want
a crash, not silent divergence.
"""
from __future__ import annotations

import json
import os
from decimal import Decimal
from functools import lru_cache
from typing import Any

_HERE = os.path.dirname(os.path.abspath(__file__))
_JSON_PATH = os.path.join(_HERE, "mainnet_parity_constants.json")


@lru_cache(maxsize=1)
def _load() -> dict:
    with open(_JSON_PATH, "r", encoding="utf-8") as f:
        return json.load(f)


def group(name: str) -> dict:
    """Return the raw JSON sub-object for a group (e.g. 'accumulator')."""
    data = _load()
    if name not in data:
        raise KeyError(f"parity constants: missing group '{name}' in {_JSON_PATH}")
    return data[name]


def get(group_name: str, key: str) -> Any:
    g = group(group_name)
    # Ignore documentation keys (start with $).
    if key.startswith("$") or key not in g:
        raise KeyError(f"parity constants: {group_name}.{key} missing")
    return g[key]


def get_decimal(group_name: str, key: str) -> Decimal:
    """Convert to Decimal via str() to avoid float→Decimal drift."""
    return Decimal(str(get(group_name, key)))


def enums(name: str) -> list:
    e = group("enums")
    if name not in e:
        raise KeyError(f"parity constants: enum '{name}' missing")
    return list(e[name])


def json_path() -> str:
    return _JSON_PATH
