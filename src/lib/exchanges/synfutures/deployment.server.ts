import { createPublicClient, getAddress, keccak256, padHex, type Hex } from "viem";
import { base } from "viem/chains";
import { chainRpcTransport } from "@/lib/blockchain/rpc.server";
import artifact from "./module-artifact.json";
import { observeDeploymentFailure, type PendingDeployment } from "./deploymentRecovery";
import {
  SAFE_DEPLOYMENTS,
  deploymentIdentity,
  deploymentPlan,
  factoryDeploymentAbi,
  safeDeploymentAbi,
} from "./deployment";

export function assertModuleRuntime(code: Hex, safe: string) {
  let normalized = code.toLowerCase();
  if (normalized.length !== artifact.runtimeBytecode.length)
    throw new Error("Module bytecode mismatch.");
  for (const { start, length } of Object.values(artifact.immutableReferences).flat()) {
    const begin = 2 + start * 2;
    if (
      length !== 32 ||
      normalized.slice(begin, begin + length * 2) !==
        padHex(getAddress(safe), { size: 32 }).slice(2).toLowerCase()
    )
      throw new Error("Module owner mismatch.");
    normalized =
      normalized.slice(0, begin) + "0".repeat(length * 2) + normalized.slice(begin + length * 2);
  }
  if (normalized !== artifact.runtimeBytecode.toLowerCase())
    throw new Error("Module bytecode mismatch.");
}

/** Read-only. Nothing is signed, broadcast, enabled, funded or written here. */
export async function inspectSynDeployment(
  owner: string,
  walletId: string,
  pending?: PendingDeployment,
) {
  const client = createPublicClient({ chain: base, transport: chainRpcTransport("base") });
  if ((await client.getChainId()) !== 8453) throw new Error("Base RPC chain mismatch.");
  const blockNumber = await client.getBlockNumber();
  for (const contract of Object.values(SAFE_DEPLOYMENTS)) {
    const code = await client.getCode({ address: contract.address, blockNumber });
    if (!code || keccak256(code) !== contract.hash)
      throw new Error("Official Safe deployment verification failed.");
  }
  const proxyCode = await client.readContract({
    address: SAFE_DEPLOYMENTS.factory.address,
    abi: factoryDeploymentAbi,
    functionName: "proxyCreationCode",
    blockNumber,
  });
  const identity = deploymentIdentity(owner, walletId, proxyCode, artifact.creationBytecode as Hex);
  const finish = async (stage: "deploy_safe" | "deploy_module" | "deployed") => {
    const plan = deploymentPlan(identity, stage);
    if (
      pending?.hash &&
      stage !== "deployed" &&
      !(pending.stage === "deploy_safe" && stage === "deploy_module")
    ) {
      plan.pendingObservation = await observeDeploymentFailure(
        client,
        deploymentPlan(identity, pending.stage),
        pending.hash,
      );
    }
    return { ...plan, verifiedAtBlock: blockNumber.toString() };
  };
  const safeCode = await client.getCode({ address: identity.safe, blockNumber });
  if (!safeCode || safeCode === "0x") return finish("deploy_safe");
  // The factory's deterministic address binds the exact setup, but ownership
  // can change later: recheck it every time before offering another operation.
  const slot = await client.getStorageAt({
    address: identity.safe,
    slot: padHex("0x0", { size: 32 }),
    blockNumber,
  });
  if (
    slot?.toLowerCase() !== padHex(SAFE_DEPLOYMENTS.singleton.address, { size: 32 }).toLowerCase()
  )
    throw new Error("Safe singleton changed.");
  const [owners, threshold, version] = await Promise.all([
    client.readContract({
      address: identity.safe,
      abi: safeDeploymentAbi,
      functionName: "getOwners",
      blockNumber,
    }),
    client.readContract({
      address: identity.safe,
      abi: safeDeploymentAbi,
      functionName: "getThreshold",
      blockNumber,
    }),
    client.readContract({
      address: identity.safe,
      abi: safeDeploymentAbi,
      functionName: "VERSION",
      blockNumber,
    }),
  ]);
  if (
    owners.length !== 1 ||
    getAddress(owners[0]) !== identity.owner ||
    threshold !== 1n ||
    version !== "1.4.1"
  )
    throw new Error("Safe ownership or version changed.");
  const moduleCode = await client.getCode({ address: identity.module, blockNumber });
  if (!moduleCode || moduleCode === "0x") return finish("deploy_module");
  assertModuleRuntime(moduleCode, identity.safe);
  return finish("deployed");
}
