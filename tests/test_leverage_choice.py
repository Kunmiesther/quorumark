"""The customer's leverage choice must reach ApeX.

Defect this pins (2026-08-01): `_execute_decision` called
`plan_entry_size(...)` with no `requested_leverage`, so every entry used
`pilot_sizing.MAX_LEVERAGE`. A customer who deliberately picked 50x got 100x
— DOUBLE the risk they asked for. Choosing lower leverage failing silently is
the dangerous direction of that bug, and it is the one nobody would notice.

Meanwhile the picker offered 200/300/400/500x, none of which are reachable:
the pilot ceiling, the signer and the venue all cap at 100.
"""
import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import bot_worker as bw
import pilot_sizing


def test_the_ceiling_is_not_a_second_literal():
    """100 must come from the ratified shared constant, not be retyped here.
    Three services load `pilot.max_leverage`; a fourth copy is the drift these
    constants exist to prevent."""
    assert bw.MAX_SELECTABLE_LEVERAGE is pilot_sizing.MAX_LEVERAGE
    assert bw.MAX_SELECTABLE_LEVERAGE == 100


def test_the_floor_is_one_not_zero():
    """ApeX has no 0x. 0 means "no position", which is expressed by not
    trading — `pilot_leverage` has always applied max(1, ...)."""
    assert bw.MIN_SELECTABLE_LEVERAGE == 1
    assert pilot_sizing.pilot_leverage(0) == 1


@pytest.mark.parametrize("chosen", [1, 2, 5, 10, 25, 37, 50, 63, 75, 99, 100])
def test_every_value_in_range_is_honoured_exactly(chosen):
    """Not just the old presets. 37x and 63x must survive intact — snapping
    them to a preset is how a deliberate choice became a different one."""
    assert bw._requested_leverage({"params": {"leverage": chosen}}) == chosen


def test_above_the_ceiling_is_clamped_down_never_up():
    for over in (101, 200, 500, 10_000):
        assert bw._requested_leverage({"params": {"leverage": over}}) == 100


def test_below_the_floor_takes_the_floor_and_does_not_refuse():
    """A preference we cannot honour literally is not a reason to stop a
    trade. It is not a blocker and must never become one."""
    for under in (0, -1, -100):
        assert bw._requested_leverage({"params": {"leverage": under}}) == 1


def test_missing_or_unreadable_preference_is_none_not_a_refusal():
    """None preserves the previous default (the pilot ceiling) downstream.
    An unreadable preference is missing information, never a refusal."""
    for cfg in (
        None, {}, {"params": None}, {"params": {}},
        {"params": {"leverage": None}},
        {"params": {"leverage": "abc"}},
        {"params": {"leverage": True}},   # bool is not a leverage
        {"params": [1, 2, 3]},
    ):
        assert bw._requested_leverage(cfg) is None


def test_the_choice_is_actually_passed_to_the_sizer():
    """The regression itself. Asserted at the call site: reading the customer
    preference is worthless if `_execute_decision` never forwards it."""
    import ast
    import inspect
    import textwrap

    tree = ast.parse(
        textwrap.dedent(inspect.getsource(bw.RailwayTurtleBot._execute_decision))
    )
    for node in ast.walk(tree):
        if not isinstance(node, ast.Call):
            continue
        func = node.func
        if isinstance(func, ast.Attribute) and func.attr == "plan_entry_size":
            names = {kw.arg for kw in node.keywords}
            assert "requested_leverage" in names, (
                "plan_entry_size is being called without requested_leverage — "
                "every entry silently reverts to the pilot ceiling and a "
                "customer who picked lower leverage gets more risk than they "
                "chose."
            )
            return
    raise AssertionError("plan_entry_size call not found in _execute_decision")


def test_the_sizer_still_clamps_what_it_is_given():
    """Passing a preference must not widen authority. The sizer clamps to the
    venue ceiling and then the pilot ceiling, so this path can only ever lower
    the number."""
    assert pilot_sizing.pilot_leverage(500) == pilot_sizing.MAX_LEVERAGE
    assert pilot_sizing.pilot_leverage(50) == 50


def test_the_worker_reads_where_the_app_writes():
    """The hop that was missing.

    `_requested_leverage` reads `active_bot_config.params.leverage`, and
    `active_bot_config.params` IS `user_strategy.params` (see the view in
    supabase/migrations/20260714150000_*.sql). The app was writing the choice
    only to `profiles.current_leverage_tier`, which the worker never reads —
    so the preference existed, the reader existed, and nothing connected
    them: every entry fell back to the pilot ceiling.

    Asserted against the view definition so a schema change that moves
    `params` cannot silently break the link again."""
    import glob

    # LATEST definition wins — the view has been redefined several times and
    # an earlier one does not describe the deployed schema.
    defs = sorted(
        path for path in glob.glob("supabase/migrations/*.sql")
        if "CREATE OR REPLACE VIEW public.active_bot_config" in open(path).read()
    )
    assert defs, "active_bot_config view definition not found"
    view_sql = open(defs[-1]).read()
    assert "us.params" in view_sql, "the view no longer exposes user_strategy.params"
    assert "user_strategy us" in view_sql

    modal = open("src/components/turtle/StrategyConfigModal.tsx").read()
    # The app must write leverage into user_strategy.params, not only profiles.
    assert 'from("user_strategy")' in modal
    assert "leverage: promisedLeverage" in modal
    # And it must MERGE, because params also carries `symbol`, which the view
    # selects via params->>'symbol'. A wholesale replace orphans the row.
    assert "...existing" in modal
