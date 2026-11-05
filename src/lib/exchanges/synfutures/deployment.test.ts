import { describe, expect, it, vi } from "vitest";
import { decodeFunctionData, keccak256, padHex, parseAbi, stringToHex, type Hex } from "viem";
import { readFileSync } from "node:fs";
import artifact from "./module-artifact.json";
import {
  deploymentIdentity,
  deploymentPlan,
  assertDeploymentPlan,
  SAFE_DEPLOYMENTS,
  safeDeploymentAbi,
  factoryDeploymentAbi,
} from "./deployment";
import { assertModuleRuntime } from "./deployment.server";
import { submitSynDeployment } from "./deploymentWallet";

const owner = "0x1111111111111111111111111111111111111111";
const wallet = "00000000-0000-4000-8000-000000000001";
const identity = deploymentIdentity(owner, wallet, "0x60016000", artifact.creationBytecode as Hex);

describe("SynFutures owner-only empty deployment", () => {
  it("pins the artifact to the actual source", () => {
    const source = readFileSync("contracts/synfutures/src/SynFuturesTradingModule.sol", "utf8");
    expect(keccak256(stringToHex(source))).toBe(artifact.sourceHash);
    expect(artifact.compiler).toBe("0.8.30+commit.73712a01");
  });
  it("is deterministic and separates wallets", () => {
    expect(
      deploymentIdentity(owner, wallet, "0x60016000", artifact.creationBytecode as Hex),
    ).toEqual(identity);
    expect(
      deploymentIdentity(
        owner,
        wallet.replace(/1$/, "2"),
        "0x60016000",
        artifact.creationBytecode as Hex,
      ).safe,
    ).not.toBe(identity.safe);
  });
  it("sets up one owner with no payment, fallback handler, delegatecall or modules", () => {
    const decoded = decodeFunctionData({ abi: safeDeploymentAbi, data: identity.initializer });
    expect(decoded.functionName).toBe("setup");
    expect(decoded.args).toEqual([
      [owner],
      1n,
      `0x${"0".repeat(40)}`,
      "0x",
      `0x${"0".repeat(40)}`,
      `0x${"0".repeat(40)}`,
      0n,
      `0x${"0".repeat(40)}`,
    ]);
    const tx = deploymentPlan(identity, "deploy_safe").transaction!;
    expect(tx.value).toBe("0x0");
    expect(tx.to).toBe(SAFE_DEPLOYMENTS.factory.address);
    expect(decodeFunctionData({ abi: factoryDeploymentAbi, data: tx.data }).functionName).toBe(
      "createProxyWithNonce",
    );
  });
  it("deploys only the constructor-bound module through pinned CreateCall", () => {
    const decoded = decodeFunctionData({
      abi: safeDeploymentAbi,
      data: deploymentPlan(identity, "deploy_module").transaction!.data,
    });
    expect(decoded.functionName).toBe("execTransaction");
    const args = decoded.args! as readonly unknown[];
    expect(args[0]).toBe(SAFE_DEPLOYMENTS.createCall.address);
    expect(args[1]).toBe(0n);
    expect(args[3]).toBe(1);
    expect(args.slice(4, 7)).toEqual([0n, 0n, 0n]);
    expect(args[9]).toBe(`${padHex(owner, { size: 32 })}${"0".repeat(64)}01`);
    const inner = decodeFunctionData({
      abi: parseAbi([
        "function performCreate2(uint256 value,bytes deploymentData,bytes32 salt) returns (address)",
      ]),
      data: args[2] as Hex,
    });
    expect(inner.args).toEqual([0n, identity.moduleInitCode, identity.moduleSalt]);
    expect(
      identity.moduleInitCode.endsWith(padHex(identity.safe, { size: 32 }).slice(2).toLowerCase()),
    ).toBe(true);
  });
  it("never claims trading readiness or prepares transactions after deployment", () => {
    expect(deploymentPlan(identity, "deployed")).toMatchObject({
      executionReady: false,
      transaction: null,
    });
  });
  it("rejects stale, foreign-chain, nonzero-value, and foreign-owner reviews", () => {
    const plan = deploymentPlan(identity, "deploy_safe", 1000);
    expect(() => assertDeploymentPlan(plan, owner, 122000)).toThrow();
    expect(() => assertDeploymentPlan({ ...plan, chainId: 1 } as never, owner, 1000)).toThrow();
    expect(() =>
      assertDeploymentPlan(
        { ...plan, transaction: { ...plan.transaction!, value: "0x1" } } as never,
        owner,
        1000,
      ),
    ).toThrow();
    expect(() => assertDeploymentPlan(plan, `0x${"2".repeat(40)}`, 1000)).toThrow();
  });
  it("verifies complete runtime and all immutable Safe references", () => {
    let code = artifact.runtimeBytecode;
    for (const { start, length } of Object.values(artifact.immutableReferences).flat()) {
      const i = 2 + start * 2;
      code =
        code.slice(0, i) +
        padHex(identity.safe, { size: 32 }).slice(2) +
        code.slice(i + length * 2);
    }
    expect(() => assertModuleRuntime(code as Hex, identity.safe)).not.toThrow();
    expect(() => assertModuleRuntime(code as Hex, owner)).toThrow();
    expect(() => assertModuleRuntime(`${code.slice(0, -2)}ff` as Hex, identity.safe)).toThrow();
  });
});

function mockProvider(overrides: Record<string, unknown> = {}) {
  return {
    request: vi.fn(async ({ method }: { method: string }) => {
      if (method in overrides) {
        const v = overrides[method];
        if (v instanceof Error) throw v;
        return v;
      }
      return (
        {
          eth_accounts: [owner],
          eth_chainId: "0x2105",
          eth_call: padHex("0x1", { size: 32 }),
          eth_estimateGas: "0x100000",
          eth_sendTransaction: `0x${"a".repeat(64)}`,
        } as Record<string, unknown>
      )[method];
    }),
    on: vi.fn(),
    removeListener: vi.fn(),
  };
}

describe("deployment wallet handoff", () => {
  it("simulates, estimates, rechecks, journals and sends once", async () => {
    const provider = mockProvider();
    const persist = vi.fn();
    await submitSynDeployment(provider, deploymentPlan(identity, "deploy_module"), owner, persist);
    expect(persist).toHaveBeenCalledOnce();
    expect(provider.request.mock.calls.map(([x]) => x.method)).toEqual([
      "eth_accounts",
      "eth_chainId",
      "eth_call",
      "eth_estimateGas",
      "eth_accounts",
      "eth_chainId",
      "eth_sendTransaction",
    ]);
    expect(provider.removeListener).toHaveBeenCalledTimes(3);
  });
  for (const [name, values] of Object.entries({
    wrongChain: { eth_chainId: "0x1" },
    wrongOwner: { eth_accounts: [`0x${"2".repeat(40)}`] },
    safeInnerFailure: { eth_call: padHex("0x0", { size: 32 }) },
    revert: { eth_call: new Error("revert") },
  })) {
    it(`does not send on ${name}`, async () => {
      const provider = mockProvider(values);
      await expect(
        submitSynDeployment(provider, deploymentPlan(identity, "deploy_module"), owner, vi.fn()),
      ).rejects.toMatchObject({ definitelyNotSent: true });
      expect(provider.request.mock.calls.map(([x]) => x.method)).not.toContain(
        "eth_sendTransaction",
      );
    });
  }
  it("does not send if pending storage fails", async () => {
    const provider = mockProvider();
    await expect(
      submitSynDeployment(provider, deploymentPlan(identity, "deploy_module"), owner, () => {
        throw new Error("Storage unavailable");
      }),
    ).rejects.toMatchObject({ definitelyNotSent: true });
    expect(provider.request.mock.calls.map(([x]) => x.method)).not.toContain("eth_sendTransaction");
  });
  it("marks ambiguous sends unknown without retry", async () => {
    const provider = mockProvider({ eth_sendTransaction: new Error("Connection lost") });
    await expect(
      submitSynDeployment(provider, deploymentPlan(identity, "deploy_module"), owner, vi.fn()),
    ).rejects.toMatchObject({ definitelyNotSent: false });
    expect(
      provider.request.mock.calls.filter(([x]) => x.method === "eth_sendTransaction"),
    ).toHaveLength(1);
  });
  it("distinguishes rejection from unknown submission", async () => {
    const provider = mockProvider({
      eth_sendTransaction: Object.assign(new Error("Rejected"), { code: 4001 }),
    });
    await expect(
      submitSynDeployment(provider, deploymentPlan(identity, "deploy_module"), owner, vi.fn()),
    ).rejects.toMatchObject({ definitelyNotSent: true });
  });
});
