// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import "./SynFuturesTradingModule.t.sol";

interface VmSafe {
    function getCode(string calldata) external returns (bytes memory);
    function prank(address) external;
    function chainId(uint256) external;
    function warp(uint256) external;
    function etch(address, bytes calldata) external;
    function expectRevert() external;
    function envOr(string calldata, bool) external returns (bool);
    function envString(string calldata) external returns (string memory);
    function createSelectFork(string calldata) external returns (uint256);
    function skip(bool) external;
}

interface IRealSafe {
    function setup(address[] calldata, uint256, address, bytes calldata, address, address, uint256, address payable)
        external;
    function enableModule(address) external;
    function disableModule(address, address) external;
    function isModuleEnabled(address) external view returns (bool);
    function getOwners() external view returns (address[] memory);
    function execTransaction(
        address,
        uint256,
        bytes calldata,
        uint8,
        uint256,
        uint256,
        uint256,
        address,
        address payable,
        bytes calldata
    ) external payable returns (bool);
}

interface IUSDC {
    function masterMinter() external view returns (address);
    function configureMinter(address, uint256) external returns (bool);
    function mint(address, uint256) external returns (bool);
    function approve(address, uint256) external returns (bool);
}

/// Uses the actual pinned Safe 1.4.1 singleton/proxy bytecode, not SafeHarness.
contract SynFuturesSafeTest {
    event log_named_uint(string key, uint256 value);
    VmSafe internal constant vm = VmSafe(address(uint160(uint256(keccak256("hevm cheat code")))));
    address internal constant OWNER = address(0xA11CE);
    address internal constant WORKER = address(0xB07);
    address internal constant BTC = 0xEC6c44E704Eb1932eC5Fe1E4Aba58db6fee71460;
    address internal constant ETH = 0x04d72Fb4803b4E02F14971e5bD092375Eb330749;
    address internal constant OBSERVER = 0xDb166a6E454d2a273Cd50CCD6420703564B2a830;
    address internal constant GATE = 0x208B443983D8BcC8578e9D86Db23FbA547071270;
    address internal constant USDC = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913;
    IRealSafe internal account;
    SynFuturesTradingModule internal module;

    function _deploy(bytes memory code) private returns (address deployed) {
        assembly { deployed := create(0, add(code, 32), mload(code)) }
        require(deployed != address(0), "deployment failed");
    }

    function _createSafe() internal {
        address singleton = _deploy(
            vm.getCode("node_modules/@safe-global/safe-contracts/build/artifacts/contracts/Safe.sol/Safe.json")
        );
        account = IRealSafe(
            _deploy(
                bytes.concat(
                    vm.getCode(
                        "node_modules/@safe-global/safe-contracts/build/artifacts/contracts/proxies/SafeProxy.sol/SafeProxy.json"
                    ),
                    abi.encode(singleton)
                )
            )
        );
        address[] memory owners = new address[](1);
        owners[0] = OWNER;
        account.setup(owners, 1, address(0), "", address(0), address(0), 0, payable(address(0)));
    }

    function _ownerCall(address to, bytes memory data) internal {
        // Safe's prevalidated-owner signature is valid only because msg.sender is
        // OWNER. vm.prank is local-test-only, never used in production tooling.
        bytes memory sig = abi.encodePacked(bytes32(uint256(uint160(OWNER))), bytes32(0), uint8(1));
        vm.prank(OWNER);
        require(account.execTransaction(to, 0, data, 0, 0, 0, 0, address(0), payable(address(0)), sig));
    }

    function _configure() internal {
        module = new SynFuturesTradingModule(address(account));
        _ownerCall(address(account), abi.encodeCall(IRealSafe.enableModule, (address(module))));
        _ownerCall(
            address(module),
            abi.encodeCall(
                SynFuturesTradingModule.configureMarket,
                (BTC, SynFuturesTradingModule.MarketLimits(1e18, 100_000e18, 100e18, 10))
            )
        );
        _ownerCall(
            address(module),
            abi.encodeCall(
                SynFuturesTradingModule.configureSession,
                (WORKER, uint48(block.timestamp + 3600), uint128(1000e18), uint16(100))
            )
        );
    }

    function _trade(int128 size, uint128 margin, bool reduceOnly) internal {
        _tradeMarket(BTC, size, margin, reduceOnly);
    }

    function _tradeMarket(address instrument, int128 size, uint128 margin, bool reduceOnly) internal {
        // Limit derived from the venue inquiry; the module additionally checks
        // adverse price deviation and the post-execution position atomically.
        ISynInstrument.Quotation memory q = ISynInstrument(instrument).inquire(type(uint32).max, size);
        SynFuturesTradingModule.Trade memory t = SynFuturesTradingModule.Trade(
            module.revision(),
            module.nextNonce(),
            instrument,
            size,
            margin,
            q.postTick + (size > 0 ? int24(10) : int24(-10)),
            uint32(block.timestamp + 120),
            reduceOnly
        );
        vm.prank(WORKER);
        module.executeTrade(t);
    }

    function testRealSafeOwnerCanEnableTradeRevokeAndDisable() public {
        vm.chainId(8453);
        vm.warp(2_000_000_000);
        vm.etch(GATE, hex"00");
        vm.etch(OBSERVER, address(new ObserverHarness()).code);
        vm.etch(BTC, address(new InstrumentHarness()).code);
        _createSafe();
        _configure();
        require(account.getOwners()[0] == OWNER && account.isModuleEnabled(address(module)));
        _trade(0.001e18, 25e18, false);
        _trade(-0.001e18, 0, true);
        _ownerCall(address(module), abi.encodeCall(SynFuturesTradingModule.revokeSession, ()));
        SynFuturesTradingModule.Trade memory t = SynFuturesTradingModule.Trade(
            module.revision(), module.nextNonce(), BTC, 0.001e18, 25e18, 10, uint32(block.timestamp + 120), false
        );
        vm.expectRevert();
        vm.prank(WORKER);
        module.executeTrade(t);
        _ownerCall(address(account), abi.encodeCall(IRealSafe.disableModule, (address(1), address(module))));
        require(!account.isModuleEnabled(address(module)));
    }

    function testWorkerIsNotASafeOwner() public {
        vm.chainId(8453);
        _createSafe();
        bytes memory fakeSig = abi.encodePacked(bytes32(uint256(uint160(WORKER))), bytes32(0), uint8(1));
        vm.expectRevert();
        vm.prank(WORKER);
        account.execTransaction(WORKER, 0, "", 0, 0, 0, 0, address(0), payable(address(0)), fakeSig);
    }

    function testWorkerCannotUseAnotherSafesModule() public {
        vm.chainId(8453);
        vm.warp(2_000_000_000);
        vm.etch(GATE, hex"00");
        vm.etch(OBSERVER, address(new ObserverHarness()).code);
        vm.etch(BTC, address(new InstrumentHarness()).code);
        _createSafe();
        _configure();
        IRealSafe firstAccount = account;
        SynFuturesTradingModule firstModule = module;
        _createSafe();
        _configure();
        _ownerCall(
            address(module),
            abi.encodeCall(
                SynFuturesTradingModule.configureSession,
                (address(0xB08), uint48(block.timestamp + 3600), uint128(1000e18), uint16(100))
            )
        );
        SynFuturesTradingModule.Trade memory t = SynFuturesTradingModule.Trade(
            module.revision(), module.nextNonce(), BTC, 0.001e18, 25e18, 10, uint32(block.timestamp + 120), false
        );
        vm.expectRevert();
        vm.prank(WORKER);
        module.executeTrade(t);
        require(firstModule.safe() == address(firstAccount));
        require(module.safe() == address(account) && address(firstAccount) != address(account));
        require(module.nextNonce() == 0 && firstModule.nextNonce() == 0);
    }

    function _ownerRecovery(int128 size) internal {
        _ownerRecovery(size, false);
    }

    function _ownerRecovery(int128 size, bool rejected) internal {
        ISynInstrument.Quotation memory q = ISynInstrument(BTC).inquire(type(uint32).max, size);
        SynFuturesTradingModule.Trade memory t = SynFuturesTradingModule.Trade(
            module.revision(),
            module.nextNonce(),
            BTC,
            size,
            0,
            q.postTick + (size > 0 ? int24(10) : int24(-10)),
            uint32(block.timestamp + 120),
            true
        );
        if (rejected) vm.expectRevert();
        vm.prank(OWNER);
        module.executeTrade(t);
    }

    function _recoveryFixture() internal {
        vm.chainId(8453);
        vm.warp(2_000_000_000);
        vm.etch(GATE, hex"00");
        vm.etch(OBSERVER, address(new ObserverHarness()).code);
        vm.etch(BTC, address(new InstrumentHarness()).code);
        _createSafe();
        _configure();
        _trade(0.001e18, 25e18, false);
    }

    function testRealSafeOwnerRecoversExpiredAndDisabledSessionWithoutDeposit() public {
        _recoveryFixture();
        uint256 previousRevision = module.revision();
        vm.warp(block.timestamp + 3601);
        _ownerCall(address(account), abi.encodeCall(IRealSafe.disableModule, (address(1), address(module))));
        _ownerCall(address(account), abi.encodeCall(IRealSafe.enableModule, (address(module))));
        _ownerCall(
            address(module),
            abi.encodeCall(
                SynFuturesTradingModule.configureSession,
                (OWNER, uint48(block.timestamp + 300), uint128(1), uint16(100))
            )
        );
        require(module.revision() > previousRevision);
        _ownerRecovery(-0.001e18);
        require(ISynObserver(OBSERVER).getPosition(BTC, type(uint32).max, address(account)).size == 0);
        (,, uint128 budget, uint128 spent,) = module.session();
        require(budget == 1 && spent == 0);
        SynFuturesTradingModule.Trade memory stale = SynFuturesTradingModule.Trade(
            previousRevision, module.nextNonce(), BTC, 0.001e18, 25e18, 10, uint32(block.timestamp + 120), false
        );
        vm.expectRevert();
        vm.prank(WORKER);
        module.executeTrade(stale);
    }

    function testReviewedOwnerReductionCannotFlipAfterExposureChanges() public {
        _recoveryFixture();
        _ownerCall(
            address(module),
            abi.encodeCall(
                SynFuturesTradingModule.configureSession,
                (OWNER, uint48(block.timestamp + 300), uint128(1), uint16(100))
            )
        );
        _ownerRecovery(-0.0005e18);
        uint256 nonce = module.nextNonce();
        _ownerRecovery(-0.001e18, true);
        require(module.nextNonce() == nonce);
        require(ISynObserver(OBSERVER).getPosition(BTC, type(uint32).max, address(account)).size == 0.0005e18);
        _ownerRecovery(-0.0005e18);
        require(ISynObserver(OBSERVER).getPosition(BTC, type(uint32).max, address(account)).size == 0);
    }

    /// Opt-in integration test: eth_call-only Base fork. No broadcaster/wallet
    /// key is present. Mint/approval/deposit/trades occur only in the local EVM.
    function testBaseForkRealSafeDepositOpenReduceClose() public {
        vm.skip(!vm.envOr("RUN_SYNFUTURES_FORK", false));
        vm.createSelectFork(vm.envString("BASE_FORK_RPC_URL"));
        require(block.chainid == 8453);
        emit log_named_uint("Base fork block (local EVM only)", block.number);
        _createSafe();
        _configure();
        vm.prank(IUSDC(USDC).masterMinter());
        IUSDC(USDC).configureMinter(OWNER, 1000e6);
        vm.prank(OWNER);
        IUSDC(USDC).mint(address(account), 1000e6);
        _ownerCall(USDC, abi.encodeCall(IUSDC.approve, (GATE, 1000e6)));
        _ownerCall(GATE, abi.encodeWithSignature("deposit(bytes32)", bytes32((uint256(1000e6) << 160) | uint160(USDC))));
        _trade(0.001e18, 25e18, false);
        require(ISynObserver(OBSERVER).getPosition(BTC, type(uint32).max, address(account)).size == 0.001e18);
        _ownerCall(
            address(module),
            abi.encodeCall(
                SynFuturesTradingModule.configureMarket,
                (ETH, SynFuturesTradingModule.MarketLimits(1e18, 100_000e18, 100e18, 10))
            )
        );
        // 0.01 ETH was below the venue minimum notional (TradeTrivial).
        _tradeMarket(ETH, -0.1e18, 50e18, false);
        require(ISynObserver(OBSERVER).getPosition(ETH, type(uint32).max, address(account)).size == -0.1e18);
        require(ISynObserver(OBSERVER).getPosition(BTC, type(uint32).max, address(account)).size == 0.001e18);
        _trade(-0.0005e18, 0, true);
        require(ISynObserver(OBSERVER).getPosition(BTC, type(uint32).max, address(account)).size == 0.0005e18);
        _tradeMarket(ETH, 0.05e18, 0, true);
        require(ISynObserver(OBSERVER).getPosition(ETH, type(uint32).max, address(account)).size == -0.05e18);
        _trade(-0.0005e18, 0, true);
        require(ISynObserver(OBSERVER).getPosition(BTC, type(uint32).max, address(account)).size == 0);
        _tradeMarket(ETH, 0.05e18, 0, true);
        require(ISynObserver(OBSERVER).getPosition(ETH, type(uint32).max, address(account)).size == 0);
        require(module.nextNonce() == 6);
        (,,, uint128 spent,) = module.session();
        require(spent == 75e18);
    }
}
