import type { Hex, PublicClient, Transport } from "viem";
import type { base } from "viem/chains";
import type { SynDeploymentPlan } from "./deployment";

export type PendingDeployment = {
  stage: "deploy_safe" | "deploy_module";
  hash?: Hex;
};

export function readPendingDeployment(raw: string | null): PendingDeployment | null {
  if (raw === null) return null;
  const value = JSON.parse(raw);
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    !["deploy_safe", "deploy_module"].includes(value.stage) ||
    (value.hash !== undefined && !/^0x[0-9a-f]{64}$/i.test(value.hash))
  )
    throw new Error("Invalid pending deployment.");
  return { stage: value.stage, ...(value.hash ? { hash: value.hash } : {}) };
}

export function deploymentPendingResolved(plan: SynDeploymentPlan, pending: PendingDeployment) {
  if (
    plan.stage === "deployed" ||
    (pending.stage === "deploy_safe" && plan.stage === "deploy_module")
  )
    return true;
  const observation = plan.pendingObservation;
  return Boolean(
    pending.hash &&
    observation?.status === "reverted" &&
    observation.stage === pending.stage &&
    observation.hash.toLowerCase() === pending.hash.toLowerCase(),
  );
}

type RecoveryClient = Pick<
  PublicClient<Transport, typeof base>,
  "getChainId" | "getTransaction" | "getTransactionReceipt" | "getBlock"
>;

/** Only a finalized, canonical revert of the exact reviewed transaction permits
 * retry. Missing receipts, successful outer Safe calls, RPC failures and reorgs
 * are NOT evidence that a deployment can safely be sent again. No broadcast. */
export async function observeDeploymentFailure(
  client: RecoveryClient,
  expected: SynDeploymentPlan,
  hash: Hex,
): Promise<NonNullable<SynDeploymentPlan["pendingObservation"]>> {
  if (expected.stage === "deployed" || !expected.transaction)
    throw new Error("Deployment required.");
  const result = { stage: expected.stage, hash, status: "unknown" as const };
  try {
    if (!/^0x[0-9a-f]{64}$/i.test(hash) || (await client.getChainId()) !== 8453) return result;
    const [receipt, tx, finalized] = await Promise.all([
      client.getTransactionReceipt({ hash }),
      client.getTransaction({ hash }),
      client.getBlock({ blockTag: "finalized" }),
    ]);
    const expectedTx = expected.transaction;
    const same = (a: string | null, b: string) => a?.toLowerCase() === b.toLowerCase();
    if (
      !same(receipt.transactionHash, hash) ||
      !same(tx.hash, hash) ||
      !same(tx.from, expectedTx.from) ||
      !same(tx.to, expectedTx.to) ||
      !same(receipt.from, expectedTx.from) ||
      !same(receipt.to, expectedTx.to) ||
      !("chainId" in tx) ||
      tx.chainId !== 8453 ||
      tx.value !== 0n ||
      !same(tx.input, expectedTx.data) ||
      !receipt.blockHash ||
      !same(tx.blockHash, receipt.blockHash) ||
      tx.blockNumber !== receipt.blockNumber ||
      receipt.blockNumber === null ||
      finalized.number === null ||
      finalized.number < receipt.blockNumber
    )
      return result;
    const canonical = await client.getBlock({ blockNumber: receipt.blockNumber });
    if (canonical.number !== receipt.blockNumber || !same(canonical.hash, receipt.blockHash))
      return result;
    if (receipt.status === "reverted") return { ...result, status: "reverted" };
    if (receipt.status === "success") return { ...result, status: "included" };
    return result;
  } catch {
    // Provider URLs/errors can contain credentials. Unknown must never unlock a retry.
    return result;
  }
}
