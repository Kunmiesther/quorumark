import { encodeFunctionData, parseAbi, parseUnits, type Address } from "viem";
import { z } from "zod";

// Chain-specific deployments; never reuse an exchange signer for spot swaps.
// https://developers.uniswap.org/docs/protocols/v3/deployments/v3-base-deployments
// https://developers.uniswap.org/docs/protocols/v3/deployments/v3-bnb-deployments
export const SPOT_ROUTES = {
  base: {
    chainId: 8453,
    name: "Base",
    gas: "ETH",
    // PublicNode public Base endpoint; dedicated production RPC can override server-side.
    rpc: "https://base-rpc.publicnode.com",
    factory: "0x33128a8fc17869897dce68ed026d694621f6fdfd",
    quoter: "0x3d4e44eb1374240ce5f1b871ab261cd16335b76a",
    router: "0x2626664c2603336e57b271c5c0b26f421741e481",
    wrapped: "0x4200000000000000000000000000000000000006",
    stable: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
    stableSymbol: "USDC",
    stableDecimals: 6,
    stableName: "Circle USDC",
    explorer: "https://basescan.org/address/",
  },
  bnb: {
    chainId: 56,
    name: "BNB Smart Chain",
    gas: "BNB",
    rpc: "https://bsc-dataseed.bnbchain.org",
    factory: "0xdb1d10011ad0ff90774d0c6bb92e5c5c8b4461f7",
    quoter: "0x78d78e420da98ad378d7799be8f4af69033eb077",
    router: "0xb971ef87ede563556b2ed4b1c0b0019111dd85d2",
    wrapped: "0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c",
    stable: "0x55d398326f99059ff775485246999027b3197955",
    stableSymbol: "USDT",
    stableDecimals: 18,
    stableName: "Binance-pegged USDT",
    explorer: "https://bscscan.com/address/",
  },
} as const;
export type SpotNetwork = keyof typeof SPOT_ROUTES;
export const tokenAddressSchema = z
  .string()
  .regex(/^0x[0-9a-fA-F]{40}$/)
  .transform((v) => v.toLowerCase() as Address);
export const spotTokenSchema = z
  .object({
    chainId: z.number().int(),
    address: tokenAddressSchema,
    decimals: z.number().int().min(0).max(36),
    symbol: z.string().regex(/^[A-Za-z0-9._$-]{1,32}$/),
  })
  .strict();
export type SpotToken = z.infer<typeof spotTokenSchema>;
export const tokenLookupSchema = z
  .object({ network: z.enum(["base", "bnb"]), address: tokenAddressSchema })
  .strict();
export const spotRequestSchema = z
  .object({
    network: z.enum(["base", "bnb"]),
    walletId: z.string().uuid(),
    direction: z.enum(["native_to_stable", "stable_to_native"]),
    amount: z
      .string()
      .max(48)
      .regex(/^(?:0|[1-9]\d*)(?:\.\d+)?$/),
    slippageBps: z.number().int().min(1).max(500),
    // Omitted on legacy records: preserves their original stablecoin route.
    token: spotTokenSchema.optional(),
  })
  .strict();
export type SpotRequest = z.infer<typeof spotRequestSchema>;
export function validateSpotTokenAddress(network: SpotNetwork, input: string): Address {
  const address = tokenAddressSchema.parse(input);
  const config = SPOT_ROUTES[network];
  if (
    [config.wrapped, config.router, config.factory, config.quoter, `0x${"0".repeat(40)}`].includes(
      address,
    )
  )
    throw new Error(
      "Choose a token contract distinct from the native asset and routing contracts.",
    );
  return address;
}
export function spotToken(input: Pick<SpotRequest, "network" | "token">): SpotToken {
  const config = SPOT_ROUTES[input.network];
  if (!input.token)
    return {
      chainId: config.chainId,
      address: config.stable,
      decimals: config.stableDecimals,
      symbol: config.stableSymbol,
    };
  const token = spotTokenSchema.parse(input.token);
  if (token.chainId !== config.chainId)
    throw new Error("Token belongs to a different chain. Inspect it again.");
  validateSpotTokenAddress(input.network, token.address);
  return token;
}
export const FEE_TIERS = [100, 500, 3000, 10000] as const;
export const ROUTER_ABI = parseAbi([
  "function factory() view returns (address)",
  "function WETH9() view returns (address)",
  "function exactInputSingle((address tokenIn,address tokenOut,uint24 fee,address recipient,uint256 amountIn,uint256 amountOutMinimum,uint160 sqrtPriceLimitX96) params) payable returns (uint256 amountOut)",
  "function unwrapWETH9(uint256 amountMinimum,address recipient) payable",
  "function refundETH() payable",
  "function multicall(uint256 deadline,bytes[] data) payable returns (bytes[] results)",
]);

export function spotAmounts(input: SpotRequest) {
  const config = SPOT_ROUTES[input.network];
  const token = spotToken(input);
  const sellingNative = input.direction === "native_to_stable";
  const decimals = sellingNative ? 18 : token.decimals;
  // viem rounds excessive precision: reject it instead of changing the user's amount.
  if ((input.amount.split(".")[1]?.length ?? 0) > decimals)
    throw new Error(`Use at most ${decimals} decimal places.`);
  const raw = parseUnits(input.amount, decimals);
  if (raw <= 0n || raw >= 2n ** 255n) throw new Error("Enter a positive, valid token amount.");
  return {
    raw,
    sellingNative,
    decimals,
    tokenIn: (sellingNative ? config.wrapped : token.address) as Address,
    tokenOut: (sellingNative ? token.address : config.wrapped) as Address,
    sellSymbol: sellingNative ? config.gas : token.symbol,
    buySymbol: sellingNative ? token.symbol : config.gas,
    buyDecimals: sellingNative ? token.decimals : 18,
  };
}

/** Deterministic compiler: fixed router, exact input, owned recipient, on-chain deadline. */
export function compileSpotSwap(
  input: SpotRequest,
  owner: Address,
  fee: number,
  output: bigint,
  deadline: bigint,
) {
  const config = SPOT_ROUTES[input.network];
  const amounts = spotAmounts(input);
  if (!(FEE_TIERS as readonly number[]).includes(fee) || output <= 0n)
    throw new Error("Invalid pool quote.");
  const minimum = (output * BigInt(10_000 - input.slippageBps)) / 10_000n;
  if (minimum <= 0n) throw new Error("Output is below token precision.");
  const calls = [
    encodeFunctionData({
      abi: ROUTER_ABI,
      functionName: "exactInputSingle",
      args: [
        {
          tokenIn: amounts.tokenIn,
          tokenOut: amounts.tokenOut,
          fee,
          recipient: amounts.sellingNative ? owner : config.router,
          amountIn: amounts.raw,
          amountOutMinimum: minimum,
          sqrtPriceLimitX96: 0n,
        },
      ],
    }),
  ];
  if (!amounts.sellingNative)
    calls.push(
      encodeFunctionData({
        abi: ROUTER_ABI,
        functionName: "unwrapWETH9",
        args: [minimum, owner],
      }),
    );
  calls.push(encodeFunctionData({ abi: ROUTER_ABI, functionName: "refundETH" }));
  return {
    minimum,
    transaction: {
      account: owner,
      to: config.router as Address,
      value: amounts.sellingNative ? amounts.raw : 0n,
      data: encodeFunctionData({
        abi: ROUTER_ABI,
        functionName: "multicall",
        args: [deadline, calls],
      }),
    },
  };
}
