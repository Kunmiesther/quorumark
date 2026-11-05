import { createPublicClient, erc20Abi, formatUnits, isAddress, type Address } from "viem";
import { chainRpcTransport } from "@/lib/blockchain/rpc.server";
import { base } from "viem/chains";
import { getPerpInfo } from "@synfutures/perpv3-ts";
import { cachedSynFuturesProbe } from "./probe.server";

type Probe = Pick<
  Awaited<ReturnType<typeof cachedSynFuturesProbe>>,
  "chain_id" | "contracts_deployed" | "observer_read_compatible" | "markets"
>;
export interface WalletPreflightReader {
  chainId(): Promise<number>;
  gas(address: Address): Promise<bigint>;
  token(
    token: Address,
    owner: Address,
    gate: Address,
  ): Promise<{
    symbol: string;
    decimals: number;
    balance: bigint;
    allowance: bigint;
  }>;
}
function reader(): WalletPreflightReader {
  const client = createPublicClient({
    chain: base,
    // Coalesce the registry's token reads instead of bursting four RPC calls per token.
    batch: { multicall: true },
    transport: chainRpcTransport("base"),
  });
  return {
    chainId: () => client.getChainId(),
    gas: (address) => client.getBalance({ address }),
    token: async (address, owner, gate) => {
      const [symbol, decimals, balance, allowance] = await Promise.all([
        client.readContract({ address, abi: erc20Abi, functionName: "symbol" }),
        client.readContract({ address, abi: erc20Abi, functionName: "decimals" }),
        client.readContract({ address, abi: erc20Abi, functionName: "balanceOf", args: [owner] }),
        client.readContract({
          address,
          abi: erc20Abi,
          functionName: "allowance",
          args: [owner, gate],
        }),
      ]);
      return { symbol, decimals, balance, allowance };
    },
  };
}

/** Caller must resolve an owned, verified wallet first. No wallet client/signing or writes. */
export async function synFuturesWalletPreflight(
  address: string,
  probe: Probe,
  rpc: WalletPreflightReader = reader(),
) {
  if (!isAddress(address, { strict: false })) throw new Error("INVALID_WALLET_ADDRESS");
  if ((await rpc.chainId()) !== base.id) throw new Error("RPC_CHAIN_MISMATCH");
  const wallet = address as Address;
  const gate = getPerpInfo(base.id).gate;
  const contractsVerified =
    probe.chain_id === base.id && probe.contracts_deployed && probe.observer_read_compatible;
  // Only quote contracts discovered through the verified official registry. No arbitrary token/RPC input.
  const tokens = contractsVerified
    ? [...new Set(probe.markets.map((market) => market.quote_token.toLowerCase()))]
    : [];
  if (tokens.length > 16) throw new Error("QUOTE_SCAN_LIMIT");
  const [gas, quotes] = await Promise.all([
    rpc
      .gas(wallet)
      .then((value) => ({ balance: formatUnits(value, 18), present: value > 0n }))
      .catch(() => null),
    Promise.all(
      tokens.map(async (token) => {
        try {
          const value = await rpc.token(token as Address, wallet, gate);
          if (
            !Number.isInteger(value.decimals) ||
            value.decimals < 0 ||
            value.decimals > 36 ||
            value.balance < 0n ||
            value.allowance < 0n
          )
            throw new Error("INVALID_TOKEN_READ");
          return {
            token,
            symbol: value.symbol.slice(0, 20),
            balance: formatUnits(value.balance, value.decimals),
            gate_allowance: formatUnits(value.allowance, value.decimals),
            status: "read" as const,
          };
        } catch {
          return {
            token,
            symbol: null,
            balance: null,
            gate_allowance: null,
            status: "unavailable" as const,
          };
        }
      }),
    ),
  ]);
  return {
    wallet_address: wallet.toLowerCase(),
    chain_id: base.id,
    gate_address: gate,
    checked_at: new Date().toISOString(),
    contracts_verified: contractsVerified,
    gas,
    quotes,
    execution_ready: false as const,
    note: "Wallet balances are not exchange collateral. An allowance is not an active strategy or signing authorization.",
  };
}
