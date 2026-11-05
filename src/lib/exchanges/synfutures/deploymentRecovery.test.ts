// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import type { Hex } from "viem";
import artifact from "./module-artifact.json";
import { deploymentIdentity, deploymentPlan } from "./deployment";
import {
  observeDeploymentFailure,
  deploymentPendingResolved,
  readPendingDeployment,
} from "./deploymentRecovery";

const identity = deploymentIdentity(
  "0x1111111111111111111111111111111111111111",
  "00000000-0000-4000-8000-000000000001",
  "0x60016000",
  artifact.creationBytecode as Hex,
);
const plan = deploymentPlan(identity, "deploy_safe");
const hash = `0x${"a".repeat(64)}` as Hex;
const blockHash = `0x${"b".repeat(64)}` as Hex;
function fixture() {
  const tx = {
    ...plan.transaction!,
    input: plan.transaction!.data,
    chainId: 8453,
    value: 0n,
    hash,
    blockHash,
    blockNumber: 10n,
  };
  const receipt = {
    transactionHash: hash,
    from: tx.from,
    to: tx.to,
    blockHash,
    blockNumber: 10n,
    status: "reverted",
  };
  const finalized = { number: 12n, hash: `0x${"c".repeat(64)}` };
  const canonical = { number: 10n, hash: blockHash };
  const client = {
    getChainId: vi.fn(async () => 8453),
    getTransaction: vi.fn(async () => tx),
    getTransactionReceipt: vi.fn(async () => receipt),
    getBlock: vi.fn(async (args: { blockTag?: string }) => (args.blockTag ? finalized : canonical)),
  };
  return { tx, receipt, finalized, canonical, client };
}
const observe = (client: ReturnType<typeof fixture>["client"]) =>
  observeDeploymentFailure(client as never, plan, hash);

describe("exact finalized deployment recovery", () => {
  it("allows manual retry only after an exact canonical finalized revert", async () => {
    const { client } = fixture();
    const pendingObservation = await observe(client);
    expect(pendingObservation).toEqual({ stage: "deploy_safe", hash, status: "reverted" });
    expect(
      deploymentPendingResolved({ ...plan, pendingObservation }, { stage: "deploy_safe", hash }),
    ).toBe(true);
  });
  it.each(["from", "to", "input", "chainId", "value", "hash", "blockHash", "blockNumber"])(
    "rejects mismatched transaction %s",
    async (field) => {
      const f = fixture();
      Object.assign(f.tx, {
        [field]:
          field === "chainId"
            ? 1
            : field === "value" || field === "blockNumber"
              ? 99n
              : `0x${"d".repeat(64)}`,
      });
      expect((await observe(f.client)).status).toBe("unknown");
    },
  );
  it.each(["from", "to", "transactionHash", "blockHash"])(
    "rejects mismatched receipt %s",
    async (field) => {
      const f = fixture();
      Object.assign(f.receipt, { [field]: `0x${"d".repeat(64)}` });
      expect((await observe(f.client)).status).toBe("unknown");
    },
  );
  it("does not release an included transaction before finality", async () => {
    const f = fixture();
    f.finalized.number = 9n;
    expect((await observe(f.client)).status).toBe("unknown");
  });
  it("does not release a reorged receipt", async () => {
    const f = fixture();
    f.canonical.hash = `0x${"d".repeat(64)}`;
    expect((await observe(f.client)).status).toBe("unknown");
  });
  it("does not mistake a successful outer transaction for verified contracts", async () => {
    const f = fixture();
    f.receipt.status = "success";
    const pendingObservation = await observe(f.client);
    expect(pendingObservation.status).toBe("included");
    expect(
      deploymentPendingResolved({ ...plan, pendingObservation }, { stage: "deploy_safe", hash }),
    ).toBe(false);
  });
  it("keeps missing receipts and RPC failures unknown without leaking error details", async () => {
    const f = fixture();
    f.client.getTransactionReceipt.mockRejectedValue(new Error("private RPC credential"));
    expect(await observe(f.client)).toEqual({ stage: "deploy_safe", hash, status: "unknown" });
  });
  it("rejects a different chain before querying receipts", async () => {
    const f = fixture();
    f.client.getChainId.mockResolvedValue(1);
    expect((await observe(f.client)).status).toBe("unknown");
    expect(f.client.getTransactionReceipt).not.toHaveBeenCalled();
  });
  it("rejects Base deposit transactions that have no owner-signed chain id", async () => {
    const f = fixture();
    Reflect.deleteProperty(f.tx, "chainId");
    expect((await observe(f.client)).status).toBe("unknown");
  });
  it("cannot clear a different submission or stage", () => {
    const pendingObservation = { stage: "deploy_safe" as const, hash, status: "reverted" as const };
    expect(
      deploymentPendingResolved({ ...plan, pendingObservation }, { stage: "deploy_safe" }),
    ).toBe(false);
    expect(
      deploymentPendingResolved(
        { ...plan, pendingObservation },
        { stage: "deploy_safe", hash: `0x${"c".repeat(64)}` },
      ),
    ).toBe(false);
    expect(
      deploymentPendingResolved({ ...plan, pendingObservation }, { stage: "deploy_module", hash }),
    ).toBe(false);
  });
  it.each([
    "null",
    "[]",
    "{}",
    '{"stage":"deployed"}',
    '{"stage":"deploy_safe","hash":""}',
    '{"stage":"deploy_safe","hash":123}',
  ])("rejects corrupt pending storage %s", (raw) => {
    expect(() => readPendingDeployment(raw)).toThrow();
  });
  it("keeps legacy hashless submissions pending unless contracts advance", () => {
    expect(readPendingDeployment('{"stage":"deploy_safe"}')).toEqual({ stage: "deploy_safe" });
    expect(deploymentPendingResolved(plan, { stage: "deploy_safe" })).toBe(false);
    expect(
      deploymentPendingResolved({ ...plan, stage: "deploy_module" }, { stage: "deploy_safe" }),
    ).toBe(true);
  });
});
