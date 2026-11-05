import {
  encodeFunctionData,
  isAddress,
  parseAbi,
  parseUnits,
  zeroAddress,
  type Address,
  type Hex,
} from "viem";

/** Unsigned owner-call builder. No signer, transport, deployment or live route. */
export const SYNFUTURES_SAFE_CHAIN_ID = 8453;
export const SYNFUTURES_SAFE_MARKETS = {
  "BTC-USDC": "0xEC6c44E704Eb1932eC5Fe1E4Aba58db6fee71460",
  "ETH-USDC": "0x04d72Fb4803b4E02F14971e5bD092375Eb330749",
} as const;

export const synFuturesModuleAbi = parseAbi([
  "function configureMarket(address instrument, (uint128 maxPositionSize, uint128 maxPositionNotional, uint128 maxMarginPerTrade, uint16 maxLeverage) limits)",
  "function configureSession(address operator, uint48 validUntil, uint128 marginBudget, uint16 maxSlippageBps)",
  "function revokeSession()",
  "function executeTrade((uint256 revision, uint256 nonce, address instrument, int128 size, uint128 margin, int24 limitTick, uint32 deadline, bool reduceOnly) intent)",
]);
const safeModuleAbi = parseAbi([
  "function enableModule(address module)",
  "function disableModule(address prevModule, address module)",
]);
export type SynFuturesOwnerCall = {
  to: Address;
  value: "0";
  data: Hex;
  operation: 0;
  description: string;
};
export type SynFuturesSessionDraft = {
  chainId: number;
  safe: string;
  module: string;
  /** Read from this Safe's isModuleEnabled(module), never assumed on renewal. */
  moduleEnabled: boolean;
  operator: string;
  validUntil: number;
  marginBudgetUsdc: string;
  maxSlippageBps: number;
  markets: Array<{
    symbol: keyof typeof SYNFUTURES_SAFE_MARKETS;
    maxBaseSize: string;
    maxNotionalUsdc: string;
    maxMarginPerTradeUsdc: string;
    maxLeverage: number;
  }>;
};

function address(value: string): Address {
  if (!isAddress(value, { strict: false }) || value.toLowerCase() === zeroAddress)
    throw new Error("INVALID_ADDRESS");
  return value as Address;
}
function amount(value: string): bigint {
  // Never round excess decimal places or accept exponent notation.
  if (!/^(?:0|[1-9]\d{0,19})(?:\.\d{1,18})?$/.test(value)) throw new Error("INVALID_AMOUNT");
  const units = parseUnits(value, 18);
  if (units <= 0n || units > (1n << 127n) - 1n) throw new Error("INVALID_AMOUNT");
  return units;
}
function integer(value: number, min: number, max: number) {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error("INVALID_LIMIT");
  return value;
}
function call(to: Address, data: Hex, description: string): SynFuturesOwnerCall {
  return { to, data, description, value: "0", operation: 0 };
}

/**
 * For a FUTURE verified deployment. The caller must verify deployed bytecode,
 * Safe ownership, module.safe(), network and current session before proposing
 * these owner-signed Safe transactions. Encoding does not grant permission.
 */
export function buildSynFuturesOwnerSetup(
  draft: SynFuturesSessionDraft,
  nowSeconds = Math.floor(Date.now() / 1000),
) {
  if (draft.chainId !== SYNFUTURES_SAFE_CHAIN_ID) throw new Error("BASE_REQUIRED");
  const safe = address(draft.safe);
  const module = address(draft.module);
  const operator = address(draft.operator);
  if (typeof draft.moduleEnabled !== "boolean") throw new Error("MODULE_STATE_REQUIRED");
  if (new Set([safe, module, operator].map((value) => value.toLowerCase())).size !== 3)
    throw new Error("DISTINCT_ROLES_REQUIRED");
  integer(draft.validUntil, nowSeconds + 1, 2 ** 48 - 1);
  integer(draft.maxSlippageBps, 1, 10_000);
  const budget = amount(draft.marginBudgetUsdc);
  if (!draft.markets.length || draft.markets.length > 2) throw new Error("MARKET_REQUIRED");
  if (new Set(draft.markets.map((market) => market.symbol)).size !== draft.markets.length)
    throw new Error("DUPLICATE_MARKET");
  const calls: SynFuturesOwnerCall[] = [buildSynFuturesSessionRevocation(module)];
  if (!draft.moduleEnabled)
    calls.push(
      call(
        safe,
        encodeFunctionData({ abi: safeModuleAbi, functionName: "enableModule", args: [module] }),
        "Enable the reviewed SynFutures module on this Safe",
      ),
    );
  for (const market of draft.markets) {
    const instrument = SYNFUTURES_SAFE_MARKETS[market.symbol];
    if (!instrument) throw new Error("UNSUPPORTED_MARKET");
    const margin = amount(market.maxMarginPerTradeUsdc);
    if (margin > budget) throw new Error("MARGIN_EXCEEDS_SESSION_BUDGET");
    calls.push(
      call(
        module,
        encodeFunctionData({
          abi: synFuturesModuleAbi,
          functionName: "configureMarket",
          args: [
            instrument,
            {
              maxPositionSize: amount(market.maxBaseSize),
              maxPositionNotional: amount(market.maxNotionalUsdc),
              maxMarginPerTrade: margin,
              maxLeverage: integer(market.maxLeverage, 1, 65_535),
            },
          ],
        }),
        `Set ${market.symbol} limits; quote amounts use 18-decimal Instrument units`,
      ),
    );
  }
  // Never carry an unselected market's permissions into a replacement session.
  for (const [symbol, instrument] of Object.entries(SYNFUTURES_SAFE_MARKETS)) {
    if (draft.markets.some((market) => market.symbol === symbol)) continue;
    calls.push(
      call(
        module,
        encodeFunctionData({
          abi: synFuturesModuleAbi,
          functionName: "configureMarket",
          args: [
            instrument,
            { maxPositionSize: 0n, maxPositionNotional: 0n, maxMarginPerTrade: 0n, maxLeverage: 0 },
          ],
        }),
        `Disable new ${symbol} entries; reductions remain available`,
      ),
    );
  }
  // Session authorization must be LAST, after every market limit is installed.
  calls.push(
    call(
      module,
      encodeFunctionData({
        abi: synFuturesModuleAbi,
        functionName: "configureSession",
        args: [operator, draft.validUntil, budget, draft.maxSlippageBps],
      }),
      "Authorize the worker until the chosen expiry; no ownership or withdrawal rights",
    ),
  );
  return {
    chainId: SYNFUTURES_SAFE_CHAIN_ID,
    safe,
    calls,
    requiresOwnerSignature: true as const,
    requiresDeploymentVerification: true as const,
    executionReady: false as const,
  };
}

export function buildSynFuturesSessionRevocation(module: string): SynFuturesOwnerCall {
  return call(
    address(module),
    encodeFunctionData({ abi: synFuturesModuleAbi, functionName: "revokeSession" }),
    "Revoke the worker session; positions remain open and owner-controlled",
  );
}
