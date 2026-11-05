import {
  createPublicClient,
  erc20Abi,
  formatUnits,
  getAddress,
  parseAbi,
  zeroAddress,
  type Address,
} from "viem";
import { base } from "viem/chains";
import { chainRpcTransport } from "@/lib/blockchain/rpc.server";
import { synFuturesReadiness } from "./readiness";
import { SYNFUTURES_SAFE_MARKETS } from "./smartAccount";
import { inspectSynDeployment } from "./deployment.server";

// Official Base registry, not a browser-selected exchange/token/RPC.
// https://github.com/SynFutures/oyster-sdk/blob/main/src/config/base.json
export const SYN_ACCOUNT_CONTRACTS = {
  gate: "0x208B443983D8BcC8578e9D86Db23FbA547071270",
  config: "0xB63902d38738e353f3f52AdD203C418A0bFEa172",
  usdc: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
} as const;
const gateAbi = parseAbi([
  "function config() view returns (address)",
  "function reserveOf(address quote,address user) view returns (uint256)",
]);
const moduleAbi = parseAbi([
  "function isModuleEnabled(address module) view returns (bool)",
  "function marketLimits(address instrument) view returns (uint128 maxPositionSize,uint128 maxPositionNotional,uint128 maxMarginPerTrade,uint16 maxLeverage)",
  "function session() view returns (address operator,uint48 validUntil,uint128 marginBudget,uint128 marginSpent,uint16 maxSlippageBps)",
]);
const observerAbi = parseAbi([
  "function getPosition(address instrument,uint32 expiry,address trader) view returns ((int128 balance,int128 size,uint128 entryNotional,uint128 entrySocialLossIndex,int128 entryFundingIndex))",
]);
const observer = "0xDb166a6E454d2a273Cd50CCD6420703564B2a830" as const;
type Position = { balance: bigint; size: bigint; entryNotional: bigint; entrySocialLossIndex: bigint; entryFundingIndex: bigint };
type Deployment = Awaited<ReturnType<typeof inspectSynDeployment>>;
type MarketLimits = readonly [bigint, bigint, bigint, number];
type Session = readonly [Address, number, bigint, bigint, number];
export interface SynAccountReader {
  deployment(owner: string, walletId: string): Promise<Deployment>;
  chainId(): Promise<number>;
  balances(safe: Address, block: bigint): Promise<readonly [bigint, bigint, bigint]>;
  permissions(safe: Address, module: Address, block: bigint): Promise<readonly [boolean, Session]>;
  blockTime(block: bigint): Promise<bigint>;
  marketLimits(module: Address, instrument: Address, block: bigint): Promise<MarketLimits>;
  operatorGas(operator: Address, block: bigint): Promise<bigint>;
  position(safe: Address, instrument: Address, block: bigint): Promise<Position>;
}
function reader(): SynAccountReader {
  const client = createPublicClient({ chain: base, transport: chainRpcTransport("base") });
  const { gate, config, usdc } = SYN_ACCOUNT_CONTRACTS;
  return {
    deployment: inspectSynDeployment,
    marketLimits: (module, instrument, blockNumber) => client.readContract({ address: module, abi: moduleAbi, functionName: "marketLimits", args: [instrument], blockNumber }),
    operatorGas: (address, blockNumber) => client.getBalance({ address, blockNumber }),
    position: (safe, instrument, blockNumber) => client.readContract({ address: observer, abi: observerAbi,
      functionName: "getPosition", args: [instrument, 4294967295, safe], blockNumber }),
    chainId: () => client.getChainId(),
    blockTime: async (blockNumber) => (await client.getBlock({ blockNumber })).timestamp,
    balances: async (safe, blockNumber) => {
      const gateConfig = await client.readContract({
        address: gate,
        abi: gateAbi,
        functionName: "config",
        blockNumber,
      });
      if (getAddress(gateConfig) !== getAddress(config)) throw new Error("GATE_CONFIG_MISMATCH");
      return Promise.all([
        client.readContract({
          address: usdc,
          abi: erc20Abi,
          functionName: "balanceOf",
          args: [safe],
          blockNumber,
        }),
        client.readContract({
          address: usdc,
          abi: erc20Abi,
          functionName: "allowance",
          args: [safe, gate],
          blockNumber,
        }),
        client.readContract({
          address: gate,
          abi: gateAbi,
          functionName: "reserveOf",
          args: [usdc, safe],
          blockNumber,
        }),
      ]);
    },
    permissions: (safe, module, blockNumber) =>
      Promise.all([
        client.readContract({
          address: safe,
          abi: moduleAbi,
          functionName: "isModuleEnabled",
          args: [module],
          blockNumber,
        }),
        client.readContract({
          address: module,
          abi: moduleAbi,
          functionName: "session",
          blockNumber,
        }),
      ]),
  };
}

/** Owned wallet resolved by the authenticated server function. Never accepts a caller-supplied Safe. */
export async function inspectSynFuturesAccount(
  owner: string,
  walletId: string,
  rpc: SynAccountReader = reader(),
) {
  if ((await rpc.chainId()) !== base.id) throw new Error("RPC_CHAIN_MISMATCH");
  const plan = await rpc.deployment(owner, walletId);
  if (
    plan.chainId !== base.id ||
    getAddress(plan.owner) !== getAddress(owner) ||
    !/^\d+$/.test(plan.verifiedAtBlock)
  )
    throw new Error("ACCOUNT_BINDING_UNVERIFIED");
  const block = BigInt(plan.verifiedAtBlock);
  const baseResult = {
    address: plan.safe,
    module: plan.module,
    deployment_stage: plan.stage,
    observed_block: plan.verifiedAtBlock,
    execution_ready: false as const,
  };
  const [balances, permissions] = await Promise.all([
    // Balances at a counterfactual address are not spendable through an undeployed Safe.
    plan.stage === "deploy_safe"
      ? null
      : rpc
          .balances(plan.safe, block)
          .then(([balance, allowance, reserve]) => {
            if (
              [balance, allowance, reserve].some(
                (v) => typeof v !== "bigint" || v < 0n || v >= 2n ** 256n,
              )
            )
              throw new Error("INVALID_BALANCE");
            return {
              usdc: formatUnits(balance, 6),
              gate_allowance_usdc: formatUnits(allowance, 6),
              gate_reserve_usdc: formatUnits(reserve, 6),
            };
          })
          .catch(() => null),
    plan.stage !== "deployed"
      ? null
      : Promise.all([rpc.permissions(plan.safe, plan.module, block), rpc.blockTime(block)])
          .then(([[enabled, [operator, validUntil, budget, spent, slippage]], timestamp]) => {
            if (
              typeof enabled !== "boolean" ||
              !Number.isSafeInteger(validUntil) ||
              validUntil < 0 ||
              validUntil >= 2 ** 48 ||
              typeof timestamp !== "bigint" ||
              timestamp < 0n ||
              budget < 0n ||
              budget >= 2n ** 128n ||
              spent < 0n ||
              spent > budget ||
              !Number.isInteger(slippage) ||
              slippage < 0 ||
              slippage > 10_000
            )
              throw new Error("INVALID_SESSION");
            const address = getAddress(operator);
            const exitAuthorized = enabled && address !== zeroAddress && BigInt(validUntil) > timestamp;
            const authorized =
              exitAuthorized &&
              budget > spent;
            return {
              module_enabled: enabled,
              operator: address,
              valid_until: validUntil,
              margin_budget_usdc: formatUnits(budget, 18),
              margin_spent_usdc: formatUnits(spent, 18),
              session_authorized_at_block: authorized,
              exit_session_authorized_at_block: exitAuthorized,
            };
          })
          .catch(() => null),
  ]);
  const markets = plan.stage !== "deployed" ? null : await Promise.all(
    Object.entries(SYNFUTURES_SAFE_MARKETS).map(async ([symbol, instrument]) => {
      const [size, notional, margin, leverage] = await rpc.marketLimits(plan.module, instrument, block);
      if ([size, notional, margin].some(value => typeof value !== "bigint" || value < 0n || value >= 2n ** 128n)
        || !Number.isInteger(leverage) || leverage < 0 || leverage >= 2 ** 16) throw new Error("INVALID_MARKET_LIMITS");
      return { symbol, entries_enabled: size > 0n && notional > 0n && margin > 0n && leverage > 0,
        max_base_size: formatUnits(size, 18), max_notional_usdc: formatUnits(notional, 18),
        max_margin_per_trade_usdc: formatUnits(margin, 18), max_leverage: leverage };
    }),
  ).catch(() => null);
  const operatorGasWei = !permissions || permissions.operator === zeroAddress ? null :
    await rpc.operatorGas(permissions.operator, block).then(value => {
      if (typeof value !== "bigint" || value < 0n || value >= 2n ** 256n) throw new Error("INVALID_GAS_BALANCE");
      return value.toString();
    }).catch(() => null);
  const readiness = synFuturesReadiness({ stage: plan.stage, balances, permissions, markets, operatorGasWei });
  const positions = plan.stage === "deploy_safe" ? null : await Promise.all(
    Object.entries(SYNFUTURES_SAFE_MARKETS).map(async ([symbol, instrument]) => {
      const position = await rpc.position(plan.safe, instrument, block);
      for (const field of ["balance", "size", "entryFundingIndex"] as const) {
        const value = position[field];
        if (typeof value !== "bigint" || value < -(2n ** 127n) || value >= 2n ** 127n) throw new Error("INVALID_POSITION");
      }
      for (const field of ["entryNotional", "entrySocialLossIndex"] as const) {
        const value = position[field];
        if (typeof value !== "bigint" || value < 0n || value >= 2n ** 128n) throw new Error("INVALID_POSITION");
      }
      return { symbol, base_size_signed: formatUnits(position.size, 18), balance_usdc: formatUnits(position.balance, 18),
        entry_notional_usdc: formatUnits(position.entryNotional, 18), has_exposure: position.size !== 0n };
    }),
  ).catch(() => null);
  return { ...baseResult, balances, permissions, markets, positions, operator_gas_wei: operatorGasWei, readiness };
}

export function synAccountNote(
  account: Awaited<ReturnType<typeof inspectSynFuturesAccount>> | null,
) {
  if (!account)
    return "Trading account verification unavailable; wallet funds do not prove trading readiness.";
  const short = `${account.address.slice(0, 6)}…${account.address.slice(-4)}`;
  if (account.deployment_stage === "deploy_safe")
    return `Trading account ${short} is not deployed. Wallet balances and wallet Gate allowances are not this account's collateral or trading permission.`;
  const balances = account.balances
    ? `Safe holds ${account.balances.usdc} USDC; Safe Gate allowance ${account.balances.gate_allowance_usdc} USDC; Gate reserve ${account.balances.gate_reserve_usdc} USDC (excludes margin in positions).`
    : "Trading-account balances unavailable; not assumed zero.";
  const permission =
    account.deployment_stage === "deploy_module"
      ? "Trading module not deployed."
      : !account.permissions
        ? "Trading permission unverified."
        : account.permissions.session_authorized_at_block
          ? "Session authorized on-chain; execution and exits still require verification."
          : "No enabled, unexpired session with remaining entry budget.";
  return `Trading account ${short}: ${balances} ${permission} This check does not activate trading.`;
}
