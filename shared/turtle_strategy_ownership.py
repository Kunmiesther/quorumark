"""Approved execution agents for strategy detectors, shared with paper routing."""
import json
from pathlib import Path
from typing import Optional

STRATEGY_TURTLES = json.loads(Path(__file__).with_suffix(".json").read_text())


def resolve_strategy_turtle(strategy: str, enabled: Optional[list] = None) -> Optional[str]:
    candidates = STRATEGY_TURTLES.get(strategy, [])
    if enabled is None:
        return candidates[0] if candidates else None
    if not isinstance(enabled, list) or not all(isinstance(turtle, str) for turtle in enabled):
        return None
    return next((turtle for turtle in candidates if turtle in enabled), None)
