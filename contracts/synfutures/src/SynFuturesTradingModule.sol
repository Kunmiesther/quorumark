// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

interface ISafeAccount {
    function execTransactionFromModuleReturnData(address to, uint256 value, bytes calldata data, uint8 operation)
        external
        returns (bool success, bytes memory returnData);
}

interface ISynObserver {
    struct Position {
        int128 balance;
        int128 size;
        uint128 entryNotional;
        uint128 entrySocialLossIndex;
        int128 entryFundingIndex;
    }

    struct QuoteParam {
        uint128 minMarginAmount;
        uint16 tradingFeeRatio;
        uint16 protocolFeeRatio;
        uint64 stabilityFeeRatioParam;
        uint8 qtype;
        uint128 tip;
    }

    struct Setting {
        string symbol;
        address config;
        address gate;
        address market;
        address quote;
        uint8 decimals;
        uint16 initialMarginRatio;
        uint16 maintenanceMarginRatio;
        QuoteParam param;
    }
    function getPosition(address instrument, uint32 expiry, address trader) external view returns (Position memory);
    function getSetting(address instrument) external view returns (Setting memory);
    function gate() external view returns (address);
}

interface ISynInstrument {
    struct Quotation {
        uint256 benchmark;
        uint160 sqrtFairPX96;
        int24 tick;
        uint256 mark;
        uint256 entryNotional;
        uint256 fee;
        uint256 minAmount;
        uint160 sqrtPostFairPX96;
        int24 postTick;
    }
    function inquire(uint32 expiry, int256 size) external view returns (Quotation memory);
    function trade(bytes32[2] calldata args) external;
}

/// @notice UNDEPLOYED integration candidate. Independent security review and a
/// real-Safe Base-fork lifecycle are required before enabling or funding it.
/// @dev One module per Safe; the Safe is the portfolio owner. This is deliberately
/// not a general executor: no transfer, approval, Gate withdrawal, delegatecall,
/// arbitrary calldata, limit order, multicall, or owner-management entrypoint.
contract SynFuturesTradingModule {
    address public constant GATE = 0x208B443983D8BcC8578e9D86Db23FbA547071270;
    address public constant OBSERVER = 0xDb166a6E454d2a273Cd50CCD6420703564B2a830;
    address public constant CONFIG = 0xB63902d38738e353f3f52AdD203C418A0bFEa172;
    address public constant USDC = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913;
    address public constant BTC = 0xEC6c44E704Eb1932eC5Fe1E4Aba58db6fee71460;
    address public constant ETH = 0x04d72Fb4803b4E02F14971e5bD092375Eb330749;
    uint32 public constant PERPETUAL = type(uint32).max;
    uint256 public constant CHAIN_ID = 8453;
    address public immutable safe;

    struct Session {
        address operator;
        uint48 validUntil;
        // Quote amounts are Instrument WAD (18 decimals), NOT ERC20 USDC units.
        uint128 marginBudget;
        uint128 marginSpent;
        uint16 maxSlippageBps;
    }

    struct MarketLimits {
        uint128 maxPositionSize;
        uint128 maxPositionNotional;
        uint128 maxMarginPerTrade;
        uint16 maxLeverage;
    }

    struct Trade {
        uint256 revision;
        uint256 nonce;
        address instrument;
        int128 size;
        uint128 margin;
        int24 limitTick;
        uint32 deadline;
        bool reduceOnly;
    }
    Session public session;
    mapping(address => MarketLimits) public marketLimits;
    uint256 public revision;
    uint256 public nextNonce;
    bool private entered;

    error Unauthorized();
    error InvalidConfiguration();
    error SessionUnavailable();
    error InvalidTrade();
    error LimitExceeded();
    error VenueMismatch();
    error ExecutionFailed(bytes venueReason);
    error PositionMismatch();
    event SessionConfigured(
        uint256 indexed revision, address indexed operator, uint48 validUntil, uint128 marginBudget
    );
    event SessionRevoked(uint256 indexed revision);
    event MarketConfigured(address indexed instrument, MarketLimits limits);
    event TradeExecuted(
        uint256 indexed revision,
        uint256 indexed nonce,
        address indexed instrument,
        int128 size,
        uint128 margin,
        bool reduceOnly
    );

    modifier onlySafe() {
        if (msg.sender != safe) revert Unauthorized();
        _;
    }
    modifier nonReentrant() {
        if (entered) revert Unauthorized();
        entered = true;
        _;
        entered = false;
    }

    constructor(address safe_) {
        if (
            block.chainid != CHAIN_ID || safe_.code.length == 0 || GATE.code.length == 0 || OBSERVER.code.length == 0
                || ISynObserver(OBSERVER).gate() != GATE
        ) revert InvalidConfiguration();
        safe = safe_;
    }

    // Must be an owner-approved Safe transaction. Worker is never an owner.
    function configureSession(address operator, uint48 validUntil, uint128 marginBudget, uint16 maxSlippageBps)
        external
        onlySafe
        nonReentrant
    {
        if (
            operator == address(0) || operator == safe || validUntil <= block.timestamp || marginBudget == 0
                || maxSlippageBps == 0 || maxSlippageBps > 10_000
        ) revert InvalidConfiguration();
        revision++;
        nextNonce = 0;
        session = Session(operator, validUntil, marginBudget, 0, maxSlippageBps);
        emit SessionConfigured(revision, operator, validUntil, marginBudget);
    }

    function revokeSession() external onlySafe nonReentrant {
        revision++;
        delete session;
        emit SessionRevoked(revision);
    }

    function configureMarket(address instrument, MarketLimits calldata limits) external onlySafe nonReentrant {
        _verifyMarket(instrument);
        // Zero limits disable new entries without obstructing reductions.
        if (limits.maxPositionSize > uint128(type(int128).max) || limits.maxMarginPerTrade > uint128(type(int128).max)) revert InvalidConfiguration();
        marketLimits[instrument] = limits;
        // Invalidate queued transactions after any permission change.
        revision++;
        emit MarketConfigured(instrument, limits);
    }

    function executeTrade(Trade calldata intent) external nonReentrant {
        Session memory authority = session;
        if (msg.sender != authority.operator) revert Unauthorized();
        if (
            block.chainid != CHAIN_ID || block.timestamp >= authority.validUntil || intent.revision != revision
                || intent.nonce != nextNonce
        ) revert SessionUnavailable();
        if (
            intent.size == 0 || intent.size == type(int128).min || intent.margin > uint128(type(int128).max)
                || intent.deadline <= block.timestamp || intent.deadline > authority.validUntil
                || intent.deadline > block.timestamp + 300
        ) revert InvalidTrade();
        _verifyMarket(intent.instrument);
        ISynObserver.Position memory beforePosition =
            ISynObserver(OBSERVER).getPosition(intent.instrument, PERPETUAL, safe);
        MarketLimits memory limits = marketLimits[intent.instrument];
        if (intent.reduceOnly) {
            // No added margin, increasing exposure, or reversing through zero.
            if (
                intent.margin != 0 || beforePosition.size == 0 || (intent.size > 0) == (beforePosition.size > 0)
                    || _abs(intent.size) > _abs(beforePosition.size)
            ) revert InvalidTrade();
        } else {
            if (
                limits.maxPositionSize == 0 || limits.maxPositionNotional == 0 || limits.maxLeverage == 0
                    || intent.margin > limits.maxMarginPerTrade
                    || uint256(authority.marginSpent) + intent.margin > authority.marginBudget
            ) revert LimitExceeded();
            session.marginSpent += intent.margin;
        }
        ISynInstrument.Quotation memory quote = ISynInstrument(intent.instrument).inquire(PERPETUAL, intent.size);
        if (quote.mark == 0 || quote.entryNotional == 0) revert InvalidTrade();
        // Fees are separate. Enforce adverse execution-price deviation from the
        // current venue mark; this is not an oracle freshness or P&L guarantee.
        uint256 referenceNotional = _abs(intent.size) * quote.mark / 1e18;
        if (referenceNotional == 0) revert InvalidTrade();
        if (intent.size > 0) {
            if (quote.entryNotional > referenceNotional * (10_000 + authority.maxSlippageBps) / 10_000) {
                revert LimitExceeded();
            }
        } else if (quote.entryNotional < referenceNotional * (10_000 - authority.maxSlippageBps) / 10_000) {
            revert LimitExceeded();
        }
        nextNonce++;
        // SDK legacy encodeTradeParam layout. Negative margin is never accepted.
        bytes32[2] memory args;
        args[0] =
            bytes32(uint256(PERPETUAL) | (uint256(uint24(intent.limitTick)) << 32) | (uint256(intent.deadline) << 56));
        args[1] = bytes32((uint256(uint128(intent.size)) << 128) | uint256(intent.margin));
        (bool success, bytes memory venueReason) = ISafeAccount(safe)
            .execTransactionFromModuleReturnData(intent.instrument, 0, abi.encodeCall(ISynInstrument.trade, (args)), 0);
        if (!success) revert ExecutionFailed(venueReason);
        ISynObserver.Position memory afterPosition =
            ISynObserver(OBSERVER).getPosition(intent.instrument, PERPETUAL, safe);
        if (int256(afterPosition.size) != int256(beforePosition.size) + intent.size) revert PositionMismatch();
        if (intent.reduceOnly) {
            if (_abs(afterPosition.size) >= _abs(beforePosition.size)) revert PositionMismatch();
        } else if (
            _abs(afterPosition.size) > limits.maxPositionSize
                || afterPosition.entryNotional > limits.maxPositionNotional || afterPosition.balance <= 0
                || uint256(afterPosition.entryNotional) > uint256(uint128(afterPosition.balance)) * limits.maxLeverage
        ) {
            revert LimitExceeded();
        }
        emit TradeExecuted(revision, intent.nonce, intent.instrument, intent.size, intent.margin, intent.reduceOnly);
    }

    function _verifyMarket(address instrument) private view {
        // v1 supports only these independently documented Base USDC markets.
        if ((instrument != BTC && instrument != ETH) || instrument.code.length == 0) revert VenueMismatch();
        ISynObserver.Setting memory setting = ISynObserver(OBSERVER).getSetting(instrument);
        if (setting.gate != GATE || setting.config != CONFIG || setting.quote != USDC || setting.decimals != 6) {
            revert VenueMismatch();
        }
    }

    function _abs(int128 value) private pure returns (uint256) {
        return uint256(value < 0 ? -int256(value) : int256(value));
    }
}
