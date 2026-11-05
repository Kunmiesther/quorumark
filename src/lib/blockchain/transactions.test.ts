// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { decodeFunctionData, erc20Abi } from "viem";
import { prepareWalletSwap } from "./prepare.server";
import { assertPlan, matchesTransaction, sameSwapRequest } from "./transactions";
import { reconcileSwapReceipt, type ReceiptReader } from "./receipts.server";
import { submitReviewedTransaction } from "./walletTransaction";
import type { Eip1193Provider } from "@/lib/wallet/providers";
import type { MarketSnapshot } from "@/lib/ai/committee/schema";
import { SPOT_ROUTES } from "./spot";
import {
  TEST_ID,
  TEST_HASH,
  TEST_NOW,
  testPlan,
  testReader,
  testRequest,
  testReview,
  testWallet,
} from "./transactions.fixtures";

afterEach(() => vi.useRealTimers());
describe("reviewed wallet plans", () => {
  it("uses actual chain evidence without wallets, balances or fabricated candles in Council input", async () => {
    const review = vi.fn(async (_snapshot: MarketSnapshot) => testReview);
    const rpc = testReader({
      block: vi.fn(async () => ({ number: 100n, timestamp: BigInt(TEST_NOW / 1000) })),
    });
    const plan = await prepareWalletSwap(
      TEST_ID,
      testRequest,
      testWallet,
      review,
      rpc,
      () => TEST_NOW,
    );
    expect(plan.action).toBe("swap");
    expect(plan.review).toEqual(testReview);
    expect(rpc.block).toHaveBeenCalledTimes(2);
    const snapshot = review.mock.calls[0][0];
    expect(snapshot.spot_swap?.chain_id).toBe(8453);
    expect(snapshot.deterministic.recent_closes).toEqual([]);
    expect(JSON.stringify(snapshot)).not.toContain(testWallet.public_address);
    expect(JSON.stringify(snapshot)).not.toContain("balance");
    assertPlan(plan, TEST_NOW);
  });
  it.each([null, { ...testReview, availableRoles: [] }])(
    "requires a real Council response",
    async (response) => {
      await expect(
        prepareWalletSwap(
          TEST_ID,
          testRequest,
          testWallet,
          async () => response,
          testReader(),
          () => TEST_NOW,
        ),
      ).rejects.toThrow(/Council did not respond/);
    },
  );
  it("rejects a changed price after model latency", async () => {
    let reviewed = false;
    const rpc = testReader({ quote: async () => (reviewed ? 20_000_000n : 25_000_000n) });
    await expect(
      prepareWalletSwap(
        TEST_ID,
        testRequest,
        testWallet,
        async () => {
          reviewed = true;
          return testReview;
        },
        rpc,
        () => TEST_NOW,
      ),
    ).rejects.toThrow(/price changed/);
  });
  it("rejects a changed pool after review even if output is the same", async () => {
    let reviewed = false;
    const rpc = testReader({
      pool: async () =>
        reviewed
          ? "0x3333333333333333333333333333333333333333"
          : "0x2222222222222222222222222222222222222222",
    });
    await expect(
      prepareWalletSwap(
        TEST_ID,
        testRequest,
        testWallet,
        async () => {
          reviewed = true;
          return testReview;
        },
        rpc,
        () => TEST_NOW,
      ),
    ).rejects.toThrow(/Route or price changed/);
  });
  it.each([0n, 1n])(
    "creates exact approval or zero-reset, not unlimited spending (%s)",
    async (allowance) => {
      const review = vi.fn();
      const request = { ...testRequest, direction: "stable_to_native" as const, amount: "10" };
      const plan = await prepareWalletSwap(
        TEST_ID,
        request,
        testWallet,
        review,
        testReader({ allowance: async () => allowance }),
        () => TEST_NOW,
      );
      expect(plan.action).toBe(allowance ? "reset_approval" : "approve");
      const call = decodeFunctionData({ abi: erc20Abi, data: plan.transaction.data });
      expect(call.functionName).toBe("approve");
      expect(call.args?.[0]?.toString().toLowerCase()).toBe(SPOT_ROUTES.base.router);
      expect(call.args?.[1]).toBe(allowance ? 0n : 10_000_000n);
      expect(plan.transaction.value).toBe("0x0");
      expect(review).not.toHaveBeenCalled();
    },
  );
  it("uses BNB's token precision and router for approval", async () => {
    const request = {
      ...testRequest,
      network: "bnb" as const,
      direction: "stable_to_native" as const,
      amount: "10",
    };
    const rpc = testReader({
      chainId: async () => 56,
      decimals: async () => 18,
      routerIdentity: async () => [SPOT_ROUTES.bnb.factory, SPOT_ROUTES.bnb.wrapped],
      tokenBalance: async () => 100n * 10n ** 18n,
      allowance: async () => 0n,
    });
    const plan = await prepareWalletSwap(
      TEST_ID,
      request,
      testWallet,
      vi.fn(),
      rpc,
      () => TEST_NOW,
    );
    const call = decodeFunctionData({ abi: erc20Abi, data: plan.transaction.data });
    expect(call.args?.[0]?.toString().toLowerCase()).toBe(SPOT_ROUTES.bnb.router);
    expect(call.args?.[1]).toBe(10n * 10n ** 18n);
    expect(plan.transaction.chainId).toBe("0x38");
  });
  it("will not request approval without token funds or gas", async () => {
    const request = { ...testRequest, direction: "stable_to_native" as const, amount: "10" };
    for (const overrides of [{ tokenBalance: async () => 0n }, { nativeBalance: async () => 0n }]) {
      await expect(
        prepareWalletSwap(
          TEST_ID,
          request,
          testWallet,
          vi.fn(),
          testReader({ allowance: async () => 0n, ...overrides }),
          () => TEST_NOW,
        ),
      ).rejects.toThrow(/Insufficient/);
    }
  });
  it("rejects altered calldata, chain and expired plans", () => {
    const plan = testPlan();
    expect(() =>
      assertPlan(
        {
          ...plan,
          transaction: { ...plan.transaction, to: testWallet.public_address as `0x${string}` },
        },
        TEST_NOW,
      ),
    ).toThrow(/does not match/);
    expect(() => assertPlan({ ...plan, chainId: 1 }, TEST_NOW)).toThrow(/chain mismatch/);
    expect(() => assertPlan(plan, TEST_NOW + 170_000)).toThrow(/expired/);
    expect(() => assertPlan({ ...plan, review: null }, TEST_NOW)).toThrow(/Council/);
  });
  it("compares request values independent of property order", () => {
    expect(
      sameSwapRequest(testRequest, {
        amount: "0.01",
        slippageBps: 50,
        walletId: testRequest.walletId,
        network: "base",
        direction: "native_to_stable",
      }),
    ).toBe(true);
    expect(sameSwapRequest(testRequest, { ...testRequest, amount: "0.02" })).toBe(false);
  });
});

function receiptReader(overrides: Partial<ReceiptReader> = {}): ReceiptReader {
  const tx = testPlan().transaction;
  return {
    chainId: async () => 8453,
    transaction: async () => ({
      from: tx.from,
      to: tx.to,
      input: tx.data,
      value: BigInt(tx.value),
      nonce: 7,
    }),
    receipt: async () => ({
      blockNumber: 100n,
      blockHash: "canonical",
      status: "success",
      gasUsed: 100n,
      effectiveGasPrice: 2n,
      l1Fee: 3n,
    }),
    block: async (n) => ({ number: n ?? 101n, hash: "canonical" }),
    ...overrides,
  };
}
describe("chain receipt truth", () => {
  it("does not call a hash or a pending transaction a confirmation", async () => {
    for (const overrides of [{ transaction: async () => null }, { receipt: async () => null }])
      expect(
        await reconcileSwapReceipt(testPlan(), TEST_HASH, receiptReader(overrides)),
      ).toMatchObject({ status: "submitted", receipt: null });
  });
  it("checks chain, owner, target, calldata and value", async () => {
    await expect(
      reconcileSwapReceipt(testPlan(), TEST_HASH, receiptReader({ chainId: async () => 1 })),
    ).rejects.toThrow(/chain mismatch/);
    const tx = await receiptReader().transaction(TEST_HASH);
    for (const patch of [
      { from: SPOT_ROUTES.base.stable },
      { to: null },
      { input: "0x" },
      { value: 0n },
    ]) {
      expect(matchesTransaction(testPlan(), { ...tx!, ...patch })).toBe(false);
      await expect(
        reconcileSwapReceipt(
          testPlan(),
          TEST_HASH,
          receiptReader({ transaction: async () => ({ ...tx!, ...patch }) }),
        ),
      ).rejects.toThrow(/does not match/);
    }
  });
  it("requires two confirmations and checks canonical block hash", async () => {
    expect(
      (
        await reconcileSwapReceipt(
          testPlan(),
          TEST_HASH,
          receiptReader({ block: async () => ({ number: 100n, hash: "canonical" }) }),
        )
      ).status,
    ).toBe("submitted");
    expect(
      await reconcileSwapReceipt(
        testPlan(),
        TEST_HASH,
        receiptReader({ block: async () => ({ number: 101n, hash: "reorg" }) }),
      ),
    ).toMatchObject({ status: "submitted", receipt: null });
    const result = await reconcileSwapReceipt(testPlan(), TEST_HASH, receiptReader());
    expect(result.status).toBe("confirmed");
    expect(result.receipt?.feeNative).toBe("0.000000000000000203");
    expect(result.receipt?.feeComplete).toBe(true);
  });
  it("records reverts and labels missing Base L1 fee honestly", async () => {
    const original = (await receiptReader().receipt(TEST_HASH))!;
    const result = await reconcileSwapReceipt(
      testPlan(),
      TEST_HASH,
      receiptReader({
        receipt: async () => ({ ...original, status: "reverted", l1Fee: undefined }),
      }),
    );
    expect(result.status).toBe("reverted");
    expect(result.receipt?.feeComplete).toBe(false);
  });
  it("accepts a speed-up only for the same reviewed call and nonce", async () => {
    expect((await reconcileSwapReceipt(testPlan(), TEST_HASH, receiptReader(), "7")).status).toBe(
      "confirmed",
    );
    await expect(reconcileSwapReceipt(testPlan(), TEST_HASH, receiptReader(), "8")).rejects.toThrow(
      /different nonce/,
    );
  });
  it("distinguishes wallet cancellation from a swap, using the original verified nonce", async () => {
    const rpc = receiptReader({
      transaction: async () => ({
        from: testWallet.public_address,
        to: testWallet.public_address,
        input: "0x",
        value: 0n,
        nonce: 7,
      }),
    });
    await expect(reconcileSwapReceipt(testPlan(), TEST_HASH, rpc)).rejects.toThrow(
      /does not match/,
    );
    expect((await reconcileSwapReceipt(testPlan(), TEST_HASH, rpc, "7")).status).toBe("cancelled");
  });
});

function walletProvider(override?: (method: string) => unknown): Eip1193Provider {
  return {
    request: vi.fn(async ({ method }) => {
      const changed = override?.(method);
      if (changed !== undefined) return changed;
      if (method === "eth_accounts") return [testWallet.public_address];
      if (method === "eth_chainId") return "0x2105";
      if (method === "eth_sendTransaction") return TEST_HASH;
      return "0x0";
    }),
    on: vi.fn(),
    removeListener: vi.fn(),
  };
}
describe("explicit wallet handoff", () => {
  it("aborts before the wallet prompt if the form changes while preflight is in flight", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(TEST_NOW);
    let current = true;
    const provider = walletProvider((method) => {
      if (method === "eth_estimateGas") current = false;
    });
    await expect(
      submitReviewedTransaction(provider, testPlan(), () => current),
    ).rejects.toMatchObject({ definitelyNotSent: true });
    expect(
      vi.mocked(provider.request).mock.calls.some(([arg]) => arg.method === "eth_sendTransaction"),
    ).toBe(false);
  });
  it("simulates again in the chosen wallet before one send", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(TEST_NOW);
    const provider = walletProvider();
    expect(await submitReviewedTransaction(provider, testPlan())).toBe(TEST_HASH);
    expect(vi.mocked(provider.request).mock.calls.map(([arg]) => arg.method)).toEqual([
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
  it.each(["wrong wallet", "wrong chain", "simulation failure", "expired"])(
    "does not send with %s",
    async (reason) => {
      vi.useFakeTimers();
      vi.setSystemTime(reason === "expired" ? TEST_NOW + 190_000 : TEST_NOW);
      const provider = walletProvider((method) => {
        if (reason === "wrong wallet" && method === "eth_accounts") return [];
        if (reason === "wrong chain" && method === "eth_chainId") return "0x1";
        if (reason === "simulation failure" && method === "eth_call")
          throw new Error("simulation failed");
      });
      await expect(submitReviewedTransaction(provider, testPlan())).rejects.toMatchObject({
        definitelyNotSent: true,
      });
      expect(
        vi
          .mocked(provider.request)
          .mock.calls.some(([arg]) => arg.method === "eth_sendTransaction"),
      ).toBe(false);
    },
  );
  it("distinguishes rejection from unknown submission and never retries", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(TEST_NOW);
    for (const rejected of [true, false]) {
      const provider = walletProvider((method) => {
        if (method === "eth_sendTransaction")
          throw rejected ? { code: 4001 } : new Error("connection lost");
      });
      await expect(submitReviewedTransaction(provider, testPlan())).rejects.toMatchObject({
        definitelyNotSent: rejected,
      });
      expect(
        vi
          .mocked(provider.request)
          .mock.calls.filter(([arg]) => arg.method === "eth_sendTransaction"),
      ).toHaveLength(1);
    }
  });
});
