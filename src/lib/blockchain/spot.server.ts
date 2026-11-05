import { createPublicClient, parseAbi, erc20Abi, formatUnits, type Address } from "viem";
import { chainRpcTransport as spotTransport } from "./rpc.server";
export { chainRpcTransport as spotTransport } from "./rpc.server";
import { base, bsc } from "viem/chains";
import { BLOCKCHAINS, walletSupportsNetwork, type NetworkWallet } from "./catalog";
import { readTokenSecurity, tokenSecurityBlockers } from "./tokenSecurity.server";
import {
  SPOT_ROUTES,
  FEE_TIERS,
  ROUTER_ABI,
  compileSpotSwap,
  spotAmounts,
  spotRequestSchema,
  spotToken,
  spotTokenSchema,
  validateSpotTokenAddress,
  type SpotNetwork,
  type SpotRequest,
} from "./spot";

const FACTORY_ABI = parseAbi(["function getPool(address,address,uint24) view returns (address)"]);
const QUOTER_ABI = parseAbi([
  "function quoteExactInputSingle((address tokenIn,address tokenOut,uint256 amountIn,uint24 fee,uint160 sqrtPriceLimitX96) params) returns (uint256 amountOut,uint160 sqrtPriceX96After,uint32 initializedTicksCrossed,uint256 gasEstimate)",
]);
type SwapTransaction = ReturnType<typeof compileSpotSwap>["transaction"];
export interface SpotReader {
  chainId(): Promise<number>;
  block(): Promise<{ number: bigint; timestamp: bigint }>;
  code(address: Address): Promise<string | undefined>;
  routerIdentity(): Promise<readonly [Address, Address]>;
  decimals(address: Address): Promise<number>;
  symbol(address: Address): Promise<string>;
  pool(a: Address, b: Address, fee: number, block: bigint): Promise<Address>;
  quote(a: Address, b: Address, amount: bigint, fee: number, block: bigint): Promise<bigint>;
  nativeBalance(owner: Address, block: bigint): Promise<bigint>;
  tokenBalance(token: Address, owner: Address, block: bigint): Promise<bigint>;
  allowance(token: Address, owner: Address, block: bigint): Promise<bigint>;
  simulate(tx: SwapTransaction): Promise<bigint>;
  gasPrice(): Promise<bigint>;
  tokenSecurity?(address: Address): Promise<Record<string, unknown> | null>;
}
export function createSpotReader(network: SpotNetwork): SpotReader {
  const config = SPOT_ROUTES[network];
  const client = createPublicClient({
    chain: network === "base" ? base : bsc,
    transport: spotTransport(network),
  });
  return {
    chainId: () => client.getChainId(),
    block: async () => {
      const b = await client.getBlock();
      return { number: b.number, timestamp: b.timestamp };
    },
    code: (address) => client.getCode({ address }),
    routerIdentity: () =>
      Promise.all([
        client.readContract({ address: config.router, abi: ROUTER_ABI, functionName: "factory" }),
        client.readContract({ address: config.router, abi: ROUTER_ABI, functionName: "WETH9" }),
      ]),
    decimals: (address) =>
      client.readContract({ address, abi: erc20Abi, functionName: "decimals" }),
    symbol: (address) => client.readContract({ address, abi: erc20Abi, functionName: "symbol" }),
    pool: (a, b, fee, blockNumber) =>
      client.readContract({
        address: config.factory,
        abi: FACTORY_ABI,
        functionName: "getPool",
        args: [a, b, fee],
        blockNumber,
      }),
    quote: async (tokenIn, tokenOut, amountIn, fee, blockNumber) => {
      const { result } = await client.simulateContract({
        address: config.quoter,
        abi: QUOTER_ABI,
        functionName: "quoteExactInputSingle",
        args: [{ tokenIn, tokenOut, amountIn, fee, sqrtPriceLimitX96: 0n }],
        blockNumber,
      });
      return result[0];
    },
    nativeBalance: (address, blockNumber) => client.getBalance({ address, blockNumber }),
    tokenBalance: (address, owner, blockNumber) =>
      client.readContract({
        address,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [owner],
        blockNumber,
      }),
    allowance: (address, owner, blockNumber) =>
      client.readContract({
        address,
        abi: erc20Abi,
        functionName: "allowance",
        args: [owner, config.router],
        blockNumber,
      }),
    simulate: async (tx) => {
      await client.call(tx);
      return client.estimateGas(tx);
    },
    gasPrice: () => client.getGasPrice(),
    tokenSecurity: (address) => readTokenSecurity(config.chainId, address),
  };
}

/** Metadata is read from this chain, never taken from a ticker or discovery label. */
export async function inspectSpotToken(
  network: SpotNetwork,
  rawAddress: string,
  rpc = createSpotReader(network),
) {
  const address = validateSpotTokenAddress(network, rawAddress);
  const chainId = SPOT_ROUTES[network].chainId;
  if ((await rpc.chainId()) !== chainId)
    throw new Error("RPC network does not match the selected chain.");
  const [code, decimals, rawSymbol] = await Promise.all([
    rpc.code(address),
    rpc.decimals(address),
    rpc.symbol(address),
  ]);
  if (!code || code === "0x") throw new Error("No token contract found on this chain.");
  // Bound untrusted token text; the full address remains the authoritative identity.
  const symbol = /^[A-Za-z0-9._$-]{1,32}$/.test(rawSymbol) ? rawSymbol : "TOKEN";
  const result = spotTokenSchema.safeParse({ chainId, address, decimals, symbol });
  if (!result.success) throw new Error("Unsupported token metadata or precision.");
  return result.data;
}

/** Public chain reads and eth_call only. No signer, approval, broadcast or exchange credentials. */
export async function previewSpotSwap(
  input: SpotRequest,
  wallet: NetworkWallet,
  reader?: SpotReader,
  now = Date.now(),
) {
  const request = spotRequestSchema.parse(input);
  const config = SPOT_ROUTES[request.network];
  const selectedToken = spotToken(request);
  const network = BLOCKCHAINS.find((n) => n.id === request.network)!;
  if (wallet.id !== request.walletId || !walletSupportsNetwork(wallet, network))
    throw new Error("Choose an owned, verified EVM mainnet wallet.");
  const owner = wallet.public_address as Address;
  const amounts = spotAmounts(request);
  const rpc = reader ?? createSpotReader(request.network);
  if ((await rpc.chainId()) !== config.chainId)
    throw new Error("RPC network does not match the selected chain.");
  if (request.token) {
    const observed = await inspectSpotToken(request.network, selectedToken.address, rpc);
    if (observed.decimals !== selectedToken.decimals || observed.symbol !== selectedToken.symbol)
      throw new Error("Token metadata changed or does not match this chain. Inspect it again.");
  }
  const [block, codes, identity, decimals] = await Promise.all([
    rpc.block(),
    Promise.all(
      [config.router, config.factory, config.quoter, config.wrapped, selectedToken.address].map(
        (address) => rpc.code(address),
      ),
    ),
    rpc.routerIdentity(),
    rpc.decimals(selectedToken.address),
  ]);
  if (codes.some((code) => !code || code === "0x"))
    throw new Error("A required on-chain contract is missing.");
  if (identity[0].toLowerCase() !== config.factory || identity[1].toLowerCase() !== config.wrapped)
    throw new Error("Router identity does not match the selected network.");
  if (decimals !== selectedToken.decimals)
    throw new Error("Token decimals do not match the registry.");
  const blockAge = now - Number(block.timestamp) * 1000;
  if (blockAge > 120_000 || blockAge < -30_000)
    throw new Error("RPC block is stale; retry with a current network read.");
  const routes = await Promise.all(
    FEE_TIERS.map(async (fee) => {
      try {
        const pool = await rpc.pool(amounts.tokenIn, amounts.tokenOut, fee, block.number);
        if (/^0x0{40}$/i.test(pool)) return null;
        const output = await rpc.quote(
          amounts.tokenIn,
          amounts.tokenOut,
          amounts.raw,
          fee,
          block.number,
        );
        return output > 0n ? { fee, pool, output } : null;
      } catch {
        return null;
      }
    }),
  );
  const quotes = routes
    .filter((r) => r !== null)
    .sort((a, b) => (a.output > b.output ? -1 : a.output < b.output ? 1 : 0));
  const best = quotes[0];
  if (!best)
    throw new Error(
      "No quotable direct pool was found. Liquidity or RPC access may be unavailable; no transaction was sent.",
    );
  const [native, token, allowance] = await Promise.all([
    rpc.nativeBalance(owner, block.number),
    rpc.tokenBalance(selectedToken.address, owner, block.number),
    amounts.sellingNative
      ? Promise.resolve(0n)
      : rpc.allowance(selectedToken.address, owner, block.number),
  ]);
  const blockers: string[] = [];
  // Entry-only check: never prevent selling an existing holding because a
  // token fails a new-entry screen. Quote the entire prospective holding,
  // including all pool fees, at the same block as the buy quote.
  let exitQuote: { outputRaw: string; roundTripLossBps: number; block: string } | null = null;
  if (request.token && amounts.sellingNative) {
    try {
      blockers.push(
        ...tokenSecurityBlockers((await rpc.tokenSecurity?.(selectedToken.address)) ?? null),
      );
    } catch {
      blockers.push(...tokenSecurityBlockers(null));
    }
    try {
      const output = await rpc.quote(
        amounts.tokenOut,
        amounts.tokenIn,
        best.output,
        best.fee,
        block.number,
      );
      if (output <= 0n) throw new Error("No positive exit quote");
      const lossBps =
        output >= amounts.raw
          ? 0n
          : ((amounts.raw - output) * 10_000n + amounts.raw - 1n) / amounts.raw;
      exitQuote = {
        outputRaw: output.toString(),
        roundTripLossBps: Number(lossBps),
        block: block.number.toString(),
      };
      // Use the user's selected slippage tolerance for each direction rather
      // than inventing an additional fixed trading-risk allowance.
      if (lossBps > BigInt(request.slippageBps * 2))
        blockers.push(
          "Full-size reverse quote exceeds the selected round-trip slippage budget. Reduce size or choose another pool/token.",
        );
    } catch {
      blockers.push(
        "The full token amount could not be quoted back to the funding asset. No new token purchase can be prepared.",
      );
    }
  }
  if ((amounts.sellingNative ? native : token) < amounts.raw)
    blockers.push(`Insufficient ${amounts.sellSymbol} balance on ${config.name}.`);
  if (native === 0n) blockers.push(`No ${config.gas} available for network fees.`);
  if (!amounts.sellingNative && allowance < amounts.raw)
    blockers.push(
      `Wallet approval for exactly ${request.amount} ${amounts.sellSymbol} is required for this router.`,
    );
  const deadline = block.timestamp + 180n;
  const compiled = compileSpotSwap(request, owner, best.fee, best.output, deadline);
  let simulation: "passed" | "blocked" | "failed" = "blocked";
  let gas: string | null = null;
  let estimatedNetworkFee: string | null = null;
  if (!blockers.length) {
    try {
      const [gasUnits, price] = await Promise.all([
        rpc.simulate(compiled.transaction),
        rpc.gasPrice(),
      ]);
      gas = gasUnits.toString();
      estimatedNetworkFee = formatUnits(gasUnits * price, 18);
      if (native < compiled.transaction.value + gasUnits * price)
        blockers.push(`Insufficient ${config.gas} for the amount plus estimated execution gas.`);
      simulation = blockers.length ? "blocked" : "passed";
    } catch {
      simulation = "failed";
      blockers.push(
        "Wallet-specific simulation failed or the RPC could not complete it. Refresh the quote before proceeding.",
      );
    }
  }
  return {
    network: request.network,
    walletId: wallet.id,
    address: owner,
    provider: "Uniswap v3",
    router: config.router,
    pool: best.pool,
    feeBps: best.fee / 100,
    poolFee: best.fee,
    quotedOutputRaw: best.output.toString(),
    allowanceRaw: allowance.toString(),
    quotedPools: quotes.length,
    sellSymbol: amounts.sellSymbol,
    buySymbol: amounts.buySymbol,
    token: selectedToken,
    sellAmount: request.amount,
    buyAmount: formatUnits(best.output, amounts.buyDecimals),
    minimumReceived: formatUnits(compiled.minimum, amounts.buyDecimals),
    slippageBps: request.slippageBps,
    block: block.number.toString(),
    blockTimestamp: Number(block.timestamp) * 1000,
    checkedAt: new Date(now).toISOString(),
    expiresAt: Number(deadline) * 1000,
    nativeBalance: formatUnits(native, 18),
    stableBalance: formatUnits(token, selectedToken.decimals),
    simulation,
    gas,
    estimatedNetworkFee,
    exitQuote,
    blockers,
    // Simulation is not authorization, an order, or a fill.
    executionReady: false as const,
  };
}
export type SpotPreview = Awaited<ReturnType<typeof previewSpotSwap>>;
