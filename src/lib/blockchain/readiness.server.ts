import { formatUnits } from "viem";
import { type Blockchain, type NetworkWallet, walletSupportsNetwork } from "./catalog";
import { chainRpcConfig } from "./rpc.server";

type RpcRead = (method: string, params: unknown[]) => Promise<unknown>;
const SOLANA_MAINNET_GENESIS = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";

function rpcReader(network: Blockchain): RpcRead {
  const url =
    network.id === "base" || network.id === "bnb" ? chainRpcConfig(network.id).url : network.rpc;
  return async (method, params) => {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal: AbortSignal.timeout(8_000),
    });
    if (!response.ok) throw new Error("RPC_UNAVAILABLE");
    const body = await response.json();
    if (body.error || body.id !== 1 || body.result === undefined)
      throw new Error("RPC_UNAVAILABLE");
    return body.result;
  };
}

/** Public reads only, catalog/server-configured RPCs and an owned wallet resolved by the caller. */
export async function inspectNetworkWallet(
  network: Blockchain,
  wallet: NetworkWallet,
  rpc: RpcRead = rpcReader(network),
) {
  if (!walletSupportsNetwork(wallet, network))
    throw new Error("VERIFIED_COMPATIBLE_WALLET_REQUIRED");
  let raw: bigint;
  if (network.family === "evm") {
    const chain = await rpc("eth_chainId", []);
    if (
      typeof chain !== "string" ||
      !/^0x[0-9a-f]+$/i.test(chain) ||
      BigInt(chain) !== BigInt(network.chainId)
    )
      throw new Error("NETWORK_MISMATCH");
    const balance = await rpc("eth_getBalance", [wallet.public_address, "latest"]);
    if (typeof balance !== "string" || !/^0x[0-9a-f]+$/i.test(balance))
      throw new Error("INVALID_BALANCE");
    raw = BigInt(balance);
  } else {
    if ((await rpc("getGenesisHash", [])) !== SOLANA_MAINNET_GENESIS)
      throw new Error("NETWORK_MISMATCH");
    const result = (await rpc("getBalance", [
      wallet.public_address,
      { commitment: "confirmed" },
    ])) as { value?: unknown } | null;
    if (
      typeof result?.value !== "number" ||
      !Number.isSafeInteger(result.value) ||
      result.value < 0
    )
      throw new Error("INVALID_BALANCE");
    raw = BigInt(result.value);
  }
  return {
    network: network.id,
    wallet_id: wallet.id,
    address: wallet.public_address,
    gas_symbol: network.gas,
    native_balance: formatUnits(raw, network.decimals),
    gas_present: raw > 0n,
    checked_at: new Date().toISOString(),
    execution_ready: false as const,
  };
}
