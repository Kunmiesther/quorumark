import { getPerpInfo } from "@synfutures/perpv3-ts";
import { getABISet } from "@synfutures/perpv3-ts/abis";
import { createPublicClient, type Address } from "viem";
import { chainRpcTransport } from "@/lib/blockchain/rpc.server";
import { base } from "viem/chains";

// Read-only compatibility probe. No wallet client, credentials or signing API.
export const SYNFUTURES_SDK = "@synfutures/perpv3-ts";
export const SYNFUTURES_SDK_VERSION = "0.2.4";
const MAX_INSTRUMENTS = 256;
// SDK 0.2.4's Base observer reverts. Pin the official Base deployment's observer:
// https://github.com/SynFutures/oyster-sdk/blob/main/src/config/base.json
// Confirmed on-chain via gate() and getSetting(); never use this to infer execution readiness.
export const SYNFUTURES_BASE_OBSERVER: Address = "0xDb166a6E454d2a273Cd50CCD6420703564B2a830";
const BASE_INFO = getPerpInfo(base.id);
type Setting = {
  symbol: string;
  gate: Address;
  config: Address;
  quote: Address;
  decimals: number;
  initialMarginRatio: number;
};
type Market = {
  instrument: Address;
  symbol: string;
  quote_token: Address;
  quote_decimals: number;
  initial_margin_bps: number;
  expiries: readonly number[];
};

export interface SynFuturesProbeReader {
  chainId(): Promise<number>;
  code(address: Address): Promise<string | undefined>;
  instruments(): Promise<readonly Address[]>;
  expiries(addresses: readonly Address[]): Promise<(readonly number[] | null)[]>;
  observerGate(): Promise<Address>;
  observerSettings(addresses: readonly Address[]): Promise<(Setting | null)[]>;
}

export function createSynFuturesProbeReader(): SynFuturesProbeReader {
  // Server-configured Base endpoint shared with spot trading; no client URL input.
  const client = createPublicClient({
    chain: base,
    transport: chainRpcTransport("base"),
  });
  const info = getPerpInfo(base.id);
  const abi = getABISet(base.id);
  return {
    chainId: () => client.getChainId(),
    code: (address) => client.getCode({ address }),
    instruments: () =>
      client.readContract({
        address: info.gate,
        abi: abi.Gate,
        functionName: "getAllInstruments",
      }),
    expiries: async (addresses) => {
      const rows = await client.multicall({
        allowFailure: true,
        contracts: addresses.map((address) => ({
          address,
          abi: abi.Instrument,
          functionName: "getExpiries" as const,
        })),
      });
      return rows.map((row) => (row.status === "success" ? row.result : null));
    },
    observerGate: () =>
      client.readContract({
        address: SYNFUTURES_BASE_OBSERVER,
        abi: abi.Observer,
        functionName: "gate",
      }),
    observerSettings: async (addresses) => {
      const rows = await client.multicall({
        allowFailure: true,
        contracts: addresses.map((address) => ({
          address: SYNFUTURES_BASE_OBSERVER,
          abi: abi.Observer,
          functionName: "getSetting" as const,
          args: [address] as const,
        })),
      });
      return rows.map((row) => (row.status === "success" ? row.result : null));
    },
  };
}

export async function probeSynFuturesSdk(
  reader: SynFuturesProbeReader = createSynFuturesProbeReader(),
) {
  const started = Date.now();
  const result = {
    sdk: SYNFUTURES_SDK,
    sdk_version: SYNFUTURES_SDK_VERSION,
    checked_at: new Date().toISOString(),
    chain_id: null as number | null,
    reachable: false,
    contracts_deployed: false,
    instrument_count: null as number | null,
    instruments_with_expiry: null as number | null,
    instrument_read_failures: null as number | null,
    observer_read_compatible: false,
    observer_address: SYNFUTURES_BASE_OBSERVER,
    markets: [] as Market[],
    execution_ready: false as const,
    blockers: [] as string[],
    latency_ms: 0,
  };
  try {
    result.chain_id = await reader.chainId();
    if (result.chain_id !== base.id) {
      result.blockers.push("RPC_CHAIN_MISMATCH");
      return result;
    }
    result.reachable = true;
    const info = getPerpInfo(base.id);
    const codes = await Promise.all(
      [info.gate, SYNFUTURES_BASE_OBSERVER, info.config].map(reader.code),
    );
    result.contracts_deployed = codes.every((code) => Boolean(code && code !== "0x"));
    if (!result.contracts_deployed) {
      result.blockers.push("SDK_CONTRACT_MISSING");
      return result;
    }
    if ((await reader.observerGate()).toLowerCase() !== info.gate.toLowerCase()) {
      result.blockers.push("OBSERVER_GATE_MISMATCH");
      return result;
    }
    const addresses = await reader.instruments();
    result.instrument_count = addresses.length;
    if (addresses.length > MAX_INSTRUMENTS) {
      result.blockers.push("INSTRUMENT_SCAN_LIMIT");
      return result;
    }
    const expiries = await reader.expiries(addresses);
    if (expiries.length !== addresses.length) throw new Error("INCOMPLETE_READ");
    result.instrument_read_failures = expiries.filter((row) => row === null).length;
    result.instruments_with_expiry = expiries.filter((row) => row && row.length > 0).length;
    if (result.instrument_read_failures) result.blockers.push("INSTRUMENT_READ_INCOMPLETE");
    const candidates = addresses.filter((_, index) => (expiries[index]?.length ?? 0) > 0);
    if (!candidates.length) {
      result.blockers.push("NO_LISTED_EXPIRIES");
    } else {
      try {
        const settings = await reader.observerSettings(candidates);
        result.observer_read_compatible =
          settings.length === candidates.length &&
          settings.every(
            (setting) =>
              setting &&
              setting.gate.toLowerCase() === BASE_INFO.gate.toLowerCase() &&
              setting.config.toLowerCase() === BASE_INFO.config.toLowerCase(),
          );
        result.markets = candidates.flatMap((instrument, index) => {
          const setting = settings[index];
          if (
            !setting ||
            setting.gate.toLowerCase() !== BASE_INFO.gate.toLowerCase() ||
            setting.config.toLowerCase() !== BASE_INFO.config.toLowerCase()
          )
            return [];
          return [
            {
              instrument,
              symbol: setting.symbol,
              quote_token: setting.quote,
              quote_decimals: setting.decimals,
              initial_margin_bps: setting.initialMarginRatio,
              expiries: expiries[addresses.indexOf(instrument)] ?? [],
            },
          ];
        });
      } catch {
        // Do not expose provider errors, URLs, request headers or calldata.
      }
      if (!result.observer_read_compatible) result.blockers.push("OBSERVER_READ_INCOMPATIBLE");
    }
  } catch {
    result.blockers.push("PUBLIC_READ_FAILED");
  } finally {
    result.latency_ms = Date.now() - started;
    result.blockers.push("EXECUTION_ADAPTER_NOT_CONFIGURED");
  }
  return result;
}

// Cache public chain facts only; never cache wallet data or authorization.
let inflight: ReturnType<typeof probeSynFuturesSdk> | undefined;
let expiresAt = 0;
export function cachedSynFuturesProbe() {
  if (!inflight || Date.now() >= expiresAt) {
    expiresAt = Date.now() + 60_000;
    inflight = probeSynFuturesSdk();
  }
  return inflight;
}
