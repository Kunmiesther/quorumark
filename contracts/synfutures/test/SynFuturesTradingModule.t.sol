// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import "../src/SynFuturesTradingModule.sol";

interface Vm {
    function chainId(uint256) external;
    function warp(uint256) external;
    function etch(address, bytes calldata) external;
    function prank(address) external;
    function expectRevert(bytes4) external;
    function expectRevert(bytes calldata) external;
}

contract SafeHarness {
    address public module;
    address public lastTarget;
    uint256 public lastValue;
    uint8 public lastOperation;
    bytes public lastData;

    function enable(address module_) external {
        module = module_;
    }

    function execTransactionFromModuleReturnData(address to, uint256 value, bytes calldata data, uint8 operation)
        external
        returns (bool, bytes memory)
    {
        require(msg.sender == module, "module disabled");
        lastTarget = to;
        lastValue = value;
        lastOperation = operation;
        lastData = data;
        return to.call(data);
    }
}

contract ObserverHarness is ISynObserver {
    mapping(address => mapping(address => Position)) private positions;
    bool public mismatch;

    function setMismatch(bool value) external {
        mismatch = value;
    }

    function gate() external pure returns (address) {
        return 0x208B443983D8BcC8578e9D86Db23FbA547071270;
    }

    function getSetting(address) external view returns (Setting memory s) {
        s.config = 0xB63902d38738e353f3f52AdD203C418A0bFEa172;
        s.gate = 0x208B443983D8BcC8578e9D86Db23FbA547071270;
        s.quote = mismatch ? address(1) : 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913;
        s.decimals = 6;
    }

    function getPosition(address instrument, uint32, address trader) external view returns (Position memory) {
        return positions[instrument][trader];
    }

    function applyTrade(address trader, int128 size, int128 margin) external {
        Position storage p = positions[msg.sender][trader];
        p.size += size;
        p.balance += margin;
        p.entryNotional = uint128(uint256(p.size < 0 ? -int256(p.size) : int256(p.size)) * 20_000);
    }
}

contract InstrumentHarness {
    bool public fail;
    bool public wrongSize;
    uint256 public priceBps;

    function setFail(bool value) external {
        fail = value;
    }

    function setWrongSize(bool value) external {
        wrongSize = value;
    }

    function setPriceBps(uint256 value) external {
        priceBps = value;
    }

    function inquire(uint32, int256 size) external view returns (ISynInstrument.Quotation memory q) {
        q.mark = 20_000e18;
        q.entryNotional = uint256(size < 0 ? -size : size) * 20_000 * (priceBps == 0 ? 10_000 : priceBps) / 10_000;
    }

    function trade(bytes32[2] calldata args) external {
        require(!fail, "venue revert");
        int128 size = int128(uint128(uint256(args[1]) >> 128));
        int128 margin = int128(uint128(uint256(args[1])));
        ObserverHarness(0xDb166a6E454d2a273Cd50CCD6420703564B2a830)
            .applyTrade(msg.sender, wrongSize ? size + 1 : size, margin);
    }
}

contract SynFuturesTradingModuleTest {
    Vm private constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));
    address private constant OPERATOR = address(0x1234);
    address private constant OBSERVER = 0xDb166a6E454d2a273Cd50CCD6420703564B2a830;
    address private constant GATE = 0x208B443983D8BcC8578e9D86Db23FbA547071270;
    address private constant BTC = 0xEC6c44E704Eb1932eC5Fe1E4Aba58db6fee71460;
    address private constant ETH = 0x04d72Fb4803b4E02F14971e5bD092375Eb330749;
    SafeHarness private account;
    SynFuturesTradingModule private module;

    function setUp() public {
        vm.chainId(8453);
        vm.warp(2_000_000_000);
        vm.etch(GATE, hex"00");
        vm.etch(OBSERVER, address(new ObserverHarness()).code);
        vm.etch(BTC, address(new InstrumentHarness()).code);
        vm.etch(ETH, address(new InstrumentHarness()).code);
        account = new SafeHarness();
        module = new SynFuturesTradingModule(address(account));
        account.enable(address(module));
        _limits(BTC, 1e18, 30_000e18, 1_000e18, 10);
        _limits(ETH, 1e18, 30_000e18, 1_000e18, 10);
        _session(1_000e18);
    }

    function _session(uint128 budget) private {
        vm.prank(address(account));
        module.configureSession(OPERATOR, uint48(block.timestamp + 3600), budget, 100);
    }

    function _limits(address target, uint128 size, uint128 notional, uint128 margin, uint16 leverage) private {
        vm.prank(address(account));
        module.configureMarket(target, SynFuturesTradingModule.MarketLimits(size, notional, margin, leverage));
    }

    function _intent() private view returns (SynFuturesTradingModule.Trade memory t) {
        return SynFuturesTradingModule.Trade(
            module.revision(), module.nextNonce(), BTC, 0.01e18, 100e18, 10, uint32(block.timestamp + 120), false
        );
    }

    function _execute(SynFuturesTradingModule.Trade memory t) private {
        vm.prank(OPERATOR);
        module.executeTrade(t);
    }

    function _reject(SynFuturesTradingModule.Trade memory t, bytes4 reason) private {
        vm.expectRevert(reason);
        vm.prank(OPERATOR);
        module.executeTrade(t);
    }

    function testTradeUsesSafeAsPortfolioOwnerAndOnlyCallsTrade() public {
        _execute(_intent());
        ISynObserver.Position memory p = ISynObserver(OBSERVER).getPosition(BTC, type(uint32).max, address(account));
        require(p.size == 0.01e18 && p.balance == 100e18);
        require(ISynObserver(OBSERVER).getPosition(BTC, type(uint32).max, OPERATOR).size == 0);
        require(account.lastTarget() == BTC && account.lastValue() == 0 && account.lastOperation() == 0);
        bytes memory data = account.lastData();
        require(bytes4(data) == ISynInstrument.trade.selector && data.length == 68);
        require(module.nextNonce() == 1);
    }

    function testShortEntryEncodesSignedSize() public {
        SynFuturesTradingModule.Trade memory t = _intent();
        t.size = -t.size;
        _execute(t);
    }

    function testOwnerOnlyConfiguration() public {
        vm.expectRevert(SynFuturesTradingModule.Unauthorized.selector);
        module.configureSession(OPERATOR, uint48(block.timestamp + 3600), 100e18, 100);
        vm.expectRevert(SynFuturesTradingModule.Unauthorized.selector);
        module.revokeSession();
    }

    function testWrongOperatorCannotExecute() public {
        SynFuturesTradingModule.Trade memory t = _intent();
        vm.expectRevert(SynFuturesTradingModule.Unauthorized.selector);
        module.executeTrade(t);
    }

    function testReplayRejected() public {
        SynFuturesTradingModule.Trade memory t = _intent();
        _execute(t);
        _reject(t, SynFuturesTradingModule.SessionUnavailable.selector);
    }

    function testWrongChainRejected() public {
        SynFuturesTradingModule.Trade memory t = _intent();
        vm.chainId(1);
        _reject(t, SynFuturesTradingModule.SessionUnavailable.selector);
    }

    function testExpiredSessionRejected() public {
        SynFuturesTradingModule.Trade memory t = _intent();
        vm.warp(block.timestamp + 3600);
        _reject(t, SynFuturesTradingModule.SessionUnavailable.selector);
    }

    function testSessionReplacementInvalidatesQueuedIntent() public {
        SynFuturesTradingModule.Trade memory t = _intent();
        _session(1_000e18);
        _reject(t, SynFuturesTradingModule.SessionUnavailable.selector);
    }

    function testMarketChangeInvalidatesQueuedIntent() public {
        SynFuturesTradingModule.Trade memory t = _intent();
        _limits(BTC, 1e18, 30_000e18, 1_000e18, 10);
        _reject(t, SynFuturesTradingModule.SessionUnavailable.selector);
    }

    function testRevocationStopsOperator() public {
        SynFuturesTradingModule.Trade memory t = _intent();
        vm.prank(address(account));
        module.revokeSession();
        _reject(t, SynFuturesTradingModule.Unauthorized.selector);
    }

    function testForeignInstrumentRejected() public {
        SynFuturesTradingModule.Trade memory t = _intent();
        t.instrument = address(99);
        _reject(t, SynFuturesTradingModule.VenueMismatch.selector);
    }

    function testChangedVenueQuoteTokenRejected() public {
        ObserverHarness(OBSERVER).setMismatch(true);
        _reject(_intent(), SynFuturesTradingModule.VenueMismatch.selector);
    }

    function testDeadlineBounds() public {
        SynFuturesTradingModule.Trade memory t = _intent();
        t.deadline = uint32(block.timestamp);
        _reject(t, SynFuturesTradingModule.InvalidTrade.selector);
        t.deadline = uint32(block.timestamp + 301);
        _reject(t, SynFuturesTradingModule.InvalidTrade.selector);
    }

    function testMarginBudgetAcrossMarkets() public {
        _session(150e18);
        _execute(_intent());
        SynFuturesTradingModule.Trade memory t = _intent();
        t.instrument = ETH;
        _reject(t, SynFuturesTradingModule.LimitExceeded.selector);
    }

    function testPositionCapRevertsWholeTradeAndNonce() public {
        _limits(BTC, 0.005e18, 30_000e18, 1_000e18, 10);
        _reject(_intent(), SynFuturesTradingModule.LimitExceeded.selector);
        require(module.nextNonce() == 0);
        require(ISynObserver(OBSERVER).getPosition(BTC, type(uint32).max, address(account)).size == 0);
        (,,, uint128 spent,) = module.session();
        require(spent == 0);
    }

    function testNotionalCap() public {
        _limits(BTC, 1e18, 100e18, 1_000e18, 10);
        _reject(_intent(), SynFuturesTradingModule.LimitExceeded.selector);
    }

    function testLeverageCap() public {
        _limits(BTC, 1e18, 30_000e18, 1_000e18, 1);
        _reject(_intent(), SynFuturesTradingModule.LimitExceeded.selector);
    }

    function testSlippageLong() public {
        InstrumentHarness(BTC).setPriceBps(10_101);
        _reject(_intent(), SynFuturesTradingModule.LimitExceeded.selector);
    }

    function testSlippageShort() public {
        InstrumentHarness(BTC).setPriceBps(9_899);
        SynFuturesTradingModule.Trade memory t = _intent();
        t.size = -t.size;
        _reject(t, SynFuturesTradingModule.LimitExceeded.selector);
    }

    function testCloseDoesNotSpendMarginAndCannotFlip() public {
        _execute(_intent());
        SynFuturesTradingModule.Trade memory t = _intent();
        t.reduceOnly = true;
        t.margin = 0;
        t.size = -0.02e18;
        _reject(t, SynFuturesTradingModule.InvalidTrade.selector);
        t.size = -0.01e18;
        _execute(t);
        require(ISynObserver(OBSERVER).getPosition(BTC, type(uint32).max, address(account)).size == 0);
        (,,, uint128 spent,) = module.session();
        require(spent == 100e18);
    }

    function testReductionAllowedAfterEntryDisabled() public {
        _execute(_intent());
        _limits(BTC, 0, 0, 0, 0);
        SynFuturesTradingModule.Trade memory t = _intent();
        t.reduceOnly = true;
        t.margin = 0;
        t.size = -0.005e18;
        _execute(t);
    }

    function testReductionCannotAddMargin() public {
        _execute(_intent());
        SynFuturesTradingModule.Trade memory t = _intent();
        t.reduceOnly = true;
        t.size = -t.size;
        _reject(t, SynFuturesTradingModule.InvalidTrade.selector);
    }

    function testReductionCannotIncreaseExposure() public {
        _execute(_intent());
        SynFuturesTradingModule.Trade memory t = _intent();
        t.reduceOnly = true;
        t.margin = 0;
        _reject(t, SynFuturesTradingModule.InvalidTrade.selector);
    }

    function testEmptyPositionCannotReduce() public {
        SynFuturesTradingModule.Trade memory t = _intent();
        t.reduceOnly = true;
        t.margin = 0;
        _reject(t, SynFuturesTradingModule.InvalidTrade.selector);
    }

    function testVenueRevertRollsBackBudgetAndNonce() public {
        InstrumentHarness(BTC).setFail(true);
        SynFuturesTradingModule.Trade memory intent = _intent();
        vm.expectRevert(
            abi.encodeWithSelector(
                SynFuturesTradingModule.ExecutionFailed.selector,
                abi.encodeWithSignature("Error(string)", "venue revert")
            )
        );
        _execute(intent);
        require(module.nextNonce() == 0);
        (,,, uint128 spent,) = module.session();
        require(spent == 0);
    }

    function testUnexpectedFillSizeReverts() public {
        InstrumentHarness(BTC).setWrongSize(true);
        _reject(_intent(), SynFuturesTradingModule.PositionMismatch.selector);
    }

    function testCannotCallWithdrawOrGenericExecute() public {
        vm.prank(OPERATOR);
        (bool ok,) = address(module).call(abi.encodeWithSignature("withdraw(address,uint256)", OPERATOR, 1));
        require(!ok);
        vm.prank(OPERATOR);
        (ok,) = address(module).call(abi.encodeWithSignature("execute(address,bytes)", OPERATOR, hex""));
        require(!ok);
    }

    function testFuzzInvalidRevision(uint256 badRevision) public {
        if (badRevision == module.revision()) return;
        SynFuturesTradingModule.Trade memory t = _intent();
        t.revision = badRevision;
        _reject(t, SynFuturesTradingModule.SessionUnavailable.selector);
    }

    function testFuzzMarginCannotEncodeWithdrawal(uint128 margin) public {
        if (margin <= uint128(type(int128).max)) return;
        SynFuturesTradingModule.Trade memory t = _intent();
        t.margin = margin;
        _reject(t, SynFuturesTradingModule.InvalidTrade.selector);
    }
}
