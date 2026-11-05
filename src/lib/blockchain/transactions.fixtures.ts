// Deterministic test fixtures only; never imported by the application.
import { SPOT_ROUTES, type SpotRequest } from "./spot";
import type { SpotReader } from "./spot.server";
import type { NetworkWallet } from "./catalog";
import type { CommitteeEvaluationDto } from "@/lib/ai/committee/dto";
import { planTransaction, type SwapPlan, type SwapRecord } from "./transactions";

export const TEST_NOW = 1_790_400_000_000;
export const TEST_ID = "22222222-2222-4222-8222-222222222222";
export const TEST_HASH = `0x${"ab".repeat(32)}` as const;
export const testRequest: SpotRequest = {
  network: "base",
  walletId: "11111111-1111-4111-8111-111111111111",
  direction: "native_to_stable",
  amount: "0.01",
  slippageBps: 50,
};
export const testWallet: NetworkWallet = {
  id: testRequest.walletId,
  public_address: "0x1111111111111111111111111111111111111111",
  chain: "ethereum",
  network: "mainnet",
  status: "verified",
  is_active: true,
  provider: "metamask",
  label: null,
};
export const testReview: CommitteeEvaluationDto = {
  id: TEST_ID,
  candidateId: `spot:${TEST_ID}`,
  strategy: "manual_spot",
  symbol: "ETH-USDC",
  timeframe: "block",
  candleCloseAt: new Date(TEST_NOW).toISOString(),
  schemaVersion: null,
  evidenceHash: null,
  verdict: "shadow_no_consensus",
  consensusDirection: null,
  consensusConfidence: null,
  riskFlags: [],
  availableRoles: ["risk"],
  unavailableRoles: ["lead", "structure"],
  riskDissent: false,
  outcomes: [],
  totalLatencyMs: 1,
  promptVersion: "prompt.v2",
  scorerVersion: null,
  shadowScore: null,
  scoreBand: null,
  advisory: true,
};
export function testReader(overrides: Partial<SpotReader> = {}): SpotReader {
  return {
    chainId: async () => 8453,
    block: async () => ({ number: 100n, timestamp: BigInt(TEST_NOW / 1000) }),
    code: async () => "0x6001",
    routerIdentity: async () => [SPOT_ROUTES.base.factory, SPOT_ROUTES.base.wrapped],
    decimals: async () => 6,
    symbol: async () => "USDC",
    pool: async () => "0x2222222222222222222222222222222222222222",
    quote: async (_a, _b, _amount, fee) => (fee === 500 ? 25_000_000n : 24_000_000n),
    nativeBalance: async () => 10n ** 18n,
    tokenBalance: async () => 100_000_000n,
    allowance: async () => 100_000_000n,
    simulate: async () => 100_000n,
    gasPrice: async () => 1_000_000n,
    ...overrides,
  };
}
export function testPlan(overrides: Partial<SwapPlan> = {}): SwapPlan {
  const fields = {
    id: TEST_ID,
    request: testRequest,
    action: "swap" as const,
    owner: testWallet.public_address as `0x${string}`,
    chainId: 8453,
    fee: 500,
    outputRaw: "25000000",
    expiresAt: TEST_NOW + 180_000,
    minimumReceived: "24.875",
    estimatedNetworkFee: "0.0000001",
    review: testReview,
    ...overrides,
  };
  return { ...fields, transaction: planTransaction(fields) };
}
export function testRecord(overrides: Partial<SwapRecord> = {}): SwapRecord {
  return {
    id: TEST_ID,
    plan: testPlan(),
    status: "prepared",
    tx_hash: null,
    transaction_nonce: null,
    hash_verified: false,
    previous_hashes: [],
    receipt: null,
    ...overrides,
  };
}
