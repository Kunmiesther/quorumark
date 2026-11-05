// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { encodeFunctionResult, keccak256, padHex, type Hex } from "viem";
import artifact from "./module-artifact.json";
import {
  deploymentIdentity,
  factoryDeploymentAbi,
  safeDeploymentAbi,
  SAFE_DEPLOYMENTS,
} from "./deployment";
import { attestSynFuturesAccount } from "./registration.server";

// Official deployment bytecodes are represented by sentinel fixtures. All other
// hashes (including the actual compiled module runtime) use real keccak256.
vi.mock("viem", async (original) => {
  const real = await original<typeof import("viem")>();
  const hashes: Record<string, Hex> = {
    "0x01": "0xb1f926978a0f44a2c0ec8fe822418ae969bd8c3f18d61e5103100339894f81ff",
    "0x02": "0x50c3cdc4074750a7a974204a716c999edd37482f907608d960b2b025ee0b3317",
    "0x03": "0x2b3060c55fcb8275653e99ad511a71f67ba76934ed66a7d74d6e68b52afff889",
  };
  return { ...real, keccak256: (value: Hex) => hashes[value] ?? real.keccak256(value) };
});
const owner = "0x1111111111111111111111111111111111111111";
const wallet = "00000000-0000-4000-8000-000000000001";
const proxyCode = "0x60016000";
const identity = deploymentIdentity(owner, wallet, proxyCode, artifact.creationBytecode as Hex);
const now = 1800000000;
const head = { number: "0x100", hash: `0x${"a".repeat(64)}`, timestamp: `0x${now.toString(16)}` };
function fixture() {
  let runtime = artifact.runtimeBytecode;
  for (const { start, length } of Object.values(artifact.immutableReferences).flat()) {
    const at = 2 + start * 2;
    runtime =
      runtime.slice(0, at) +
      padHex(identity.safe, { size: 32 }).slice(2) +
      runtime.slice(at + length * 2);
  }
  const codes: Record<string, string> = {
    [SAFE_DEPLOYMENTS.singleton.address]: "0x01",
    [SAFE_DEPLOYMENTS.factory.address]: "0x02",
    [SAFE_DEPLOYMENTS.createCall.address]: "0x03",
    [identity.safe]: "0x6001600055",
    [identity.module]: runtime,
  };
  const state = {
    chain: "0x2105",
    head: { ...head },
    canonical: { ...head },
    codes,
    slot: padHex(SAFE_DEPLOYMENTS.singleton.address, { size: 32 }),
    owners: [owner] as Hex[],
    threshold: 1n,
    version: "1.4.1",
  };
  const rpc = {
    request: vi.fn(async (method: string, params: readonly unknown[]): Promise<unknown> => {
      if (method === "eth_chainId") return state.chain;
      if (method === "eth_getBlockByNumber")
        return params[0] === "latest" ? state.head : state.canonical;
      if (method === "eth_getCode") return state.codes[params[0] as string];
      if (method === "eth_getStorageAt") return state.slot;
      if (method === "eth_call") {
        const { to, data } = params[0] as { to: string; data: Hex };
        if (to === SAFE_DEPLOYMENTS.factory.address)
          return encodeFunctionResult({
            abi: factoryDeploymentAbi,
            functionName: "proxyCreationCode",
            result: proxyCode,
          });
        if (data === "0xa0e67e2b")
          return encodeFunctionResult({
            abi: safeDeploymentAbi,
            functionName: "getOwners",
            result: state.owners,
          });
        if (data === "0xe75235b8")
          return encodeFunctionResult({
            abi: safeDeploymentAbi,
            functionName: "getThreshold",
            result: state.threshold,
          });
        if (data === "0xffa1ad74")
          return encodeFunctionResult({
            abi: safeDeploymentAbi,
            functionName: "VERSION",
            result: state.version,
          });
      }
      throw new Error(`Unexpected RPC: ${method}`);
    }),
  };
  return { state, rpc };
}
describe("SynFutures server-owned canonical registration proof", () => {
  it("derives both contracts and pins all contract reads to a canonical block hash", async () => {
    const { rpc, state } = fixture();
    const proof = await attestSynFuturesAccount(owner, wallet, rpc, () => now);
    expect(proof).toMatchObject({
      ownerAddress: owner,
      safeAddress: identity.safe.toLowerCase(),
      moduleAddress: identity.module.toLowerCase(),
      blockHash: head.hash,
      blockNumber: "256",
      safeProxyCodeHash: keccak256(state.codes[identity.safe] as Hex),
    });
    for (const [method, params] of rpc.request.mock.calls) {
      expect([
        "eth_chainId",
        "eth_getBlockByNumber",
        "eth_getCode",
        "eth_getStorageAt",
        "eth_call",
      ]).toContain(method);
      if (["eth_getCode", "eth_getStorageAt", "eth_call"].includes(method))
        expect(params.at(-1)).toEqual({ blockHash: head.hash, requireCanonical: true });
    }
    expect(proof).not.toHaveProperty("operator");
  });
  it.each([
    "chain",
    "safeMissing",
    "moduleMissing",
    "singleton",
    "owner",
    "threshold",
    "version",
    "moduleCode",
    "officialCode",
    "reorg",
    "stale",
    "future",
    "malformed",
  ])("rejects %s without producing a registration proof", async (kind) => {
    const { state, rpc } = fixture();
    if (kind === "chain") state.chain = "0x1";
    if (kind === "safeMissing") state.codes[identity.safe] = "0x";
    if (kind === "moduleMissing") state.codes[identity.module] = "0x";
    if (kind === "singleton") state.slot = padHex(owner, { size: 32 });
    if (kind === "owner") state.owners = [`0x${"2".repeat(40)}`];
    if (kind === "threshold") state.threshold = 2n;
    if (kind === "version") state.version = "1.3.0";
    if (kind === "moduleCode")
      state.codes[identity.module] = state.codes[identity.module].slice(0, -2) + "ff";
    if (kind === "officialCode") state.codes[SAFE_DEPLOYMENTS.factory.address] = "0x00";
    if (kind === "reorg") state.canonical.hash = `0x${"b".repeat(64)}`;
    if (kind === "stale") state.head.timestamp = `0x${(now - 31).toString(16)}`;
    if (kind === "future") state.head.timestamp = `0x${(now + 6).toString(16)}`;
    if (kind === "malformed") state.head.number = "0x00";
    await expect(attestSynFuturesAccount(owner, wallet, rpc, () => now)).rejects.toThrow();
  });
  it("rejects a check that becomes stale while the reads are running", async () => {
    const { rpc } = fixture();
    let count = 0;
    await expect(
      attestSynFuturesAccount(owner, wallet, rpc, () => now + (count++ ? 31 : 0)),
    ).rejects.toThrow("stale");
  });
});
