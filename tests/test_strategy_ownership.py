import pytest
from shared.turtle_strategy_ownership import resolve_strategy_turtle
from bot_worker import executing_turtle, routed_turtle_enabled

@pytest.mark.parametrize('enabled,owner', [
    (['accumulator'], 'accumulator'), (['sniper'], 'sniper'),
    (['accumulator','sniper'], 'sniper'), (['hunter'], None),
    (['sweep'], None), ([], None), ('accumulator', None),
])
def test_sweep_runs_inside_selected_turtle(enabled, owner):
    cfg = {'params': {'enabled_turtles': enabled}}
    assert resolve_strategy_turtle('sweep', enabled) == owner
    assert executing_turtle(cfg, 'sweep') == owner
    assert routed_turtle_enabled(cfg, 'sweep') == (owner is not None)

def test_other_strategies_keep_their_owner():
    assert resolve_strategy_turtle('vanguard', ['accumulator']) is None
    assert resolve_strategy_turtle('rsi-divergence', ['accumulator']) is None
    assert resolve_strategy_turtle('sweep') == 'sniper'
