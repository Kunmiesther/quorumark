import pytest
from app.synfutures_entry import plan_entry, SynFuturesEntryError
from shared.synfutures_math import WAD, price_at_tick


def inputs(long=True):
    return dict(margin_usdc="100", leverage=33, long=long,
        quote=dict(size=(1 if long else -1)*WAD, mark=3200*WAD, entry_notional=3200*WAD, fee=WAD, min_amount=98*WAD),
        account=dict(available_margin=100*WAD, budget_remaining=100*WAD, max_margin=100*WAD,
          max_size=2*WAD, max_notional=4000*WAD, max_leverage=33, initial_margin_ratio=300,
          minimum_margin=10*WAD, portfolio_notional=0, portfolio_limit=3300*WAD, slippage_bps=50,
          position_size=0, position_balance=0, position_notional=0))


@pytest.mark.parametrize("long", [True,False])
def test_exact_signed_quote_and_conservative_tick(long):
    args=inputs(long); plan=plan_entry(**args)
    assert plan["signed_size"] == str(args["quote"]["size"])
    assert plan["margin"] == str(100*WAD)
    bound=3200*WAD*(10050 if long else 9950)//10000
    if long: assert price_at_tick(plan["limit_tick"]) <= bound
    else: assert price_at_tick(plan["limit_tick"]) >= bound


@pytest.mark.parametrize("field,value,reason", [
    ("available_margin",99*WAD,"MARGIN_ABOVE"), ("budget_remaining",99*WAD,"MARGIN_ABOVE"),
    ("max_margin",99*WAD,"MARGIN_ABOVE"), ("max_size",WAD-1,"MARKET_EXPOSURE"),
    ("max_notional",3199*WAD,"MARKET_EXPOSURE"), ("max_leverage",32,"LEVERAGE_ABOVE"),
    ("portfolio_notional",101*WAD,"PORTFOLIO_EXPOSURE"), ("position_size",-1,"EXISTING_EXPOSURE"),
    ("minimum_margin",101*WAD,"MARGIN_BELOW"), ("available_margin",None,"UNCONFIRMED"),
])
def test_account_limits_fail_closed(field,value,reason):
    args=inputs(); args["account"][field]=value
    with pytest.raises(SynFuturesEntryError,match=reason): plan_entry(**args)


def test_fee_is_not_ignored_at_leverage_boundary():
    args=inputs(); args["quote"]["entry_notional"]=3300*WAD
    with pytest.raises(SynFuturesEntryError,match="FEE_ADJUSTED"): plan_entry(**args)


def test_venue_minimum_notional_comes_from_margin_ratio():
    args=inputs(); args["account"]["minimum_margin"]=100*WAD
    with pytest.raises(SynFuturesEntryError,match="NOTIONAL_BELOW"): plan_entry(**args)


def test_quote_direction_and_float_refused():
    args=inputs(); args["quote"]["size"]=-WAD
    with pytest.raises(SynFuturesEntryError,match="QUOTE_INVALID"): plan_entry(**args)
    args=inputs(); args["quote"]["fee"]=1.0
    with pytest.raises(SynFuturesEntryError,match="QUOTE_UNCONFIRMED"): plan_entry(**args)

@pytest.mark.parametrize('long',[True,False])
def test_managed_rung_uses_total_existing_exposure(long):
    args=inputs(long);sign=1 if long else -1
    args['account'].update(position_size=sign*WAD,position_balance=100*WAD,position_notional=3200*WAD,
       max_notional=7000*WAD,portfolio_notional=3200*WAD,portfolio_limit=7000*WAD)
    assert plan_entry(**args,managed_size=sign*WAD)['signed_size']==str(sign*WAD)
    args['account']['max_size']=WAD
    with pytest.raises(SynFuturesEntryError,match='MARKET_EXPOSURE'):plan_entry(**args,managed_size=sign*WAD)
    args['account']['max_size']=2*WAD;args['account']['max_notional']=4000*WAD
    with pytest.raises(SynFuturesEntryError,match='MARKET_EXPOSURE'):plan_entry(**args,managed_size=sign*WAD)

def test_managed_history_does_not_permit_foreign_or_opposite_position():
    args=inputs();args['account']['position_size']=WAD
    with pytest.raises(SynFuturesEntryError):plan_entry(**args,managed_size=0)
    args['account']['position_size']=-WAD
    with pytest.raises(SynFuturesEntryError):plan_entry(**args,managed_size=-WAD)
