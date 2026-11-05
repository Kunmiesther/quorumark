import { createPublicClient, formatUnits, parseUnits, type Address } from "viem";
import { chainRpcTransport } from "@/lib/blockchain/rpc.server";
import { base } from "viem/chains";
import { getABISet } from "@synfutures/perpv3-ts/abis";
import { SYNFUTURES_BASE_OBSERVER, type probeSynFuturesSdk } from "./probe.server";

type Probe = Pick<
  Awaited<ReturnType<typeof probeSynFuturesSdk>>,
  "contracts_deployed" | "observer_read_compatible" | "chain_id" | "markets"
>;
type Quote = { mark: bigint; entryNotional: bigint; fee: bigint };
export type QuoteReader = {
  chainId(): Promise<number>;
  quote(
    instrument: Address,
    expiry: number,
    notional: bigint,
    long: boolean,
  ): Promise<readonly [bigint, Quote]>;
};
function reader(): QuoteReader {
  const client = createPublicClient({
    chain: base,
    transport: chainRpcTransport("base"),
  });
  return {
    chainId: () => client.getChainId(),
    quote: (instrument, expiry, notional, long) =>
      client.readContract({
        address: SYNFUTURES_BASE_OBSERVER,
        abi: getABISet(base.id).Observer,
        functionName: "inquireByNotional",
        args: [instrument, expiry, notional, long],
      }),
  };
}

export async function quoteSynFuturesMarket(
  input: { instrument: string; expiry: number; notional: string; side: "long" | "short" },
  probe: Probe,
  rpc: QuoteReader = reader(),
  now = Date.now(),
) {
  if (!probe.contracts_deployed || !probe.observer_read_compatible || probe.chain_id !== base.id)
    throw new Error("REGISTRY_NOT_VERIFIED");
  const market = probe.markets.find(
    (item) => item.instrument.toLowerCase() === input.instrument.toLowerCase(),
  );
  if (!market || !market.expiries.includes(input.expiry)) throw new Error("MARKET_NOT_LISTED");
  if (input.expiry !== 4294967295 && input.expiry * 1000 <= now) throw new Error("MARKET_EXPIRED");
  if (!/^(?:0|[1-9]\d{0,11})(?:\.\d{1,18})?$/.test(input.notional))
    throw new Error("INVALID_NOTIONAL");
  const notional = parseUnits(input.notional, 18);
  if (notional <= 0n || !["long", "short"].includes(input.side))
    throw new Error("INVALID_QUOTE_INPUT");
  if ((await rpc.chainId()) !== base.id) throw new Error("RPC_CHAIN_MISMATCH");
  // The deployed Base observer exposes the legacy inquireByNotional method.
  // SDK inquireByBaseSize uses a newer ABI and must not be substituted here.
  const [size, quote] = await rpc.quote(
    market.instrument,
    input.expiry,
    notional,
    input.side === "long",
  );
  if (
    size === 0n ||
    (input.side === "long" ? size < 0n : size > 0n) ||
    quote.mark <= 0n ||
    quote.entryNotional <= 0n ||
    quote.fee < 0n
  )
    throw new Error("INVALID_QUOTE_RESULT");
  const absoluteSize = size < 0n ? -size : size;
  return {
    instrument: market.instrument,
    symbol: market.symbol,
    expiry: input.expiry,
    side: input.side,
    requested_notional: input.notional,
    quote_token: market.quote_token,
    base_size: formatUnits(absoluteSize, 18),
    mark_price: formatUnits(quote.mark, 18),
    entry_notional: formatUnits(quote.entryNotional, 18),
    fee: formatUnits(quote.fee, 18),
    average_entry: formatUnits((quote.entryNotional * 10n ** 18n) / absoluteSize, 18),
    checked_at: new Date(now).toISOString(),
    execution_ready: false as const,
    note: "Indicative on-chain quote only. No transaction simulated, signed or submitted; gas, slippage protection and collateral are not included.",
  };
}
