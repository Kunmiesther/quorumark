import {
  createPublicClient,
  decodeFunctionResult,
  encodeFunctionData,
  getAddress,
  keccak256,
  padHex,
  type Hex,
} from "viem";
import { base } from "viem/chains";
import { chainRpcTransport } from "@/lib/blockchain/rpc.server";
import artifact from "./module-artifact.json";
import { assertModuleRuntime } from "./deployment.server";
import {
  deploymentIdentity,
  factoryDeploymentAbi,
  SAFE_DEPLOYMENTS,
  safeDeploymentAbi,
} from "./deployment";

type ReadRpc = { request(method: string, params: readonly unknown[]): Promise<unknown> };
const hex = /^0x(?:[a-f0-9]{2})*$/i;
const hash = /^0x[a-f0-9]{64}$/i;
const quantity = /^0x(?:0|[1-9a-f][a-f0-9]*)$/i;
function bytes(value: unknown): Hex {
  if (typeof value !== "string" || !hex.test(value)) throw new Error("Invalid RPC bytes.");
  return value as Hex;
}
function block(value: unknown, now: number) {
  const b = value as { number?: unknown; hash?: unknown; timestamp?: unknown } | null;
  if (
    !b ||
    typeof b.number !== "string" ||
    !quantity.test(b.number) ||
    typeof b.timestamp !== "string" ||
    !quantity.test(b.timestamp) ||
    typeof b.hash !== "string" ||
    !hash.test(b.hash)
  )
    throw new Error("Invalid Base block.");
  const time = BigInt(b.timestamp);
  if (BigInt(b.number) <= 0n || time < BigInt(now - 30) || time > BigInt(now + 5))
    throw new Error("Base observation is stale.");
  return { number: b.number, hash: b.hash.toLowerCase(), timestamp: time };
}

/** Contract-identity proof only. No key, approval, transaction or live flag is created. */
export async function attestSynFuturesAccount(
  owner: string,
  walletId: string,
  rpc?: ReadRpc,
  now: () => number = () => Math.floor(Date.now() / 1000),
) {
  if (!rpc) {
    const client = createPublicClient({ chain: base, transport: chainRpcTransport("base") });
    rpc = { request: (method, params) => client.request({ method, params } as never) };
  }
  if ((await rpc.request("eth_chainId", [])) !== "0x2105") throw new Error("Base chain required.");
  const observed = block(await rpc.request("eth_getBlockByNumber", ["latest", false]), now());
  // EIP-1898 pins EVERY contract observation to this canonical block, not a moving head.
  const at = { blockHash: observed.hash, requireCanonical: true };
  const code = async (address: string) => bytes(await rpc.request("eth_getCode", [address, at]));
  const call = async (to: string, data: Hex) =>
    bytes(await rpc.request("eth_call", [{ to, data }, at]));
  for (const contract of Object.values(SAFE_DEPLOYMENTS)) {
    if (keccak256(await code(contract.address)) !== contract.hash)
      throw new Error("Official Safe contract mismatch.");
  }
  const proxyCode = decodeFunctionResult({
    abi: factoryDeploymentAbi,
    functionName: "proxyCreationCode",
    data: await call(
      SAFE_DEPLOYMENTS.factory.address,
      encodeFunctionData({ abi: factoryDeploymentAbi, functionName: "proxyCreationCode" }),
    ),
  });
  if (proxyCode === "0x") throw new Error("Safe factory returned empty creation code.");
  const identity = deploymentIdentity(owner, walletId, proxyCode, artifact.creationBytecode as Hex);
  const safeCode = await code(identity.safe);
  if (safeCode === "0x") throw new Error("Trading Safe is not deployed.");
  const slot = bytes(
    await rpc.request("eth_getStorageAt", [identity.safe, padHex("0x0", { size: 32 }), at]),
  );
  if (slot.toLowerCase() !== padHex(SAFE_DEPLOYMENTS.singleton.address, { size: 32 }).toLowerCase())
    throw new Error("Safe singleton changed.");
  const owners = decodeFunctionResult({
    abi: safeDeploymentAbi,
    functionName: "getOwners",
    data: await call(
      identity.safe,
      encodeFunctionData({ abi: safeDeploymentAbi, functionName: "getOwners" }),
    ),
  });
  const threshold = decodeFunctionResult({
    abi: safeDeploymentAbi,
    functionName: "getThreshold",
    data: await call(
      identity.safe,
      encodeFunctionData({ abi: safeDeploymentAbi, functionName: "getThreshold" }),
    ),
  });
  const version = decodeFunctionResult({
    abi: safeDeploymentAbi,
    functionName: "VERSION",
    data: await call(
      identity.safe,
      encodeFunctionData({ abi: safeDeploymentAbi, functionName: "VERSION" }),
    ),
  });
  if (
    owners.length !== 1 ||
    getAddress(owners[0]) !== identity.owner ||
    threshold !== 1n ||
    version !== "1.4.1"
  )
    throw new Error("Safe owner, threshold or version changed.");
  const moduleCode = await code(identity.module);
  if (moduleCode === "0x") throw new Error("Trading module is not deployed.");
  assertModuleRuntime(moduleCode, identity.safe);
  const canonical = block(
    await rpc.request("eth_getBlockByNumber", [observed.number, false]),
    now(),
  );
  if (
    canonical.number !== observed.number ||
    canonical.hash !== observed.hash ||
    canonical.timestamp !== observed.timestamp
  )
    throw new Error("Base block changed during verification.");
  return {
    ownerAddress: identity.owner.toLowerCase(),
    safeAddress: identity.safe.toLowerCase(),
    moduleAddress: identity.module.toLowerCase(),
    safeProxyCodeHash: keccak256(safeCode),
    moduleCodeHash: keccak256(moduleCode),
    blockNumber: BigInt(observed.number).toString(),
    blockHash: observed.hash,
    blockTime: new Date(Number(observed.timestamp) * 1000).toISOString(),
  };
}
