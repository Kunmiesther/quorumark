import { describe, it, expect } from "vitest";
import {
  evaluateGate,
  extractMinOrderSize,
  isProofIntent,
  PROOF_TEST_SYMBOL,
  PROOF_VENUE,
  PROOF_PURPOSE,
  type BrokerConfigInput,
  type GateDecision,
  type ProofIntentInput,
} from "../../../supabase/functions/_shared/proof-gate";

const MIN_SIZE = 0.001;

const okCfg: BrokerConfigInput = {
  enabled: false,
  exchange_type: PROOF_VENUE,
  environment: "testnet",
  permission_trade: true,
  permissions_verified: true,
};

const okIntent: ProofIntentInput = {
  purpose: PROOF_PURPOSE,
  venue: PROOF_VENUE,
  symbol: PROOF_TEST_SYMBOL,
  reduce_only: false,
  is_live: false,
  size: MIN_SIZE,
  proof_token: "tok_fresh",
};

const call = (
  intent: Partial<ProofIntentInput> = {},
  cfg: Partial<BrokerConfigInput> = {},
  extras: { signatureValid?: boolean; minOrderSize?: number | null } = {},
) =>
  evaluateGate({
    intent: { ...okIntent, ...intent },
    cfg: { ...okCfg, ...cfg },
    signatureValid: extras.signatureValid ?? true,
    minOrderSize: extras.minOrderSize === undefined ? MIN_SIZE : extras.minOrderSize,
  });

describe("proof-gate evaluateGate — happy path & basic rejects", () => {
  it("accepts a fully valid proof intent (enabled=false, testnet_proof)", () => {
    const r = call();
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.path).toBe("proof");
      expect(r.requiresTokenConsume).toBe(true);
    }
  });

  it("rejects when signature invalid", () => {
    const r = call({}, {}, { signatureValid: false });
    expect(r).toEqual({ ok: false, reason: "INVALID_SIGNATURE" });
  });

  it("rejects wrong symbol", () => {
    const r = call({ symbol: "ETH-USDT" });
    expect(r).toEqual({ ok: false, reason: "REJECT_SYMBOL_NOT_ALLOWED" });
  });

  it("rejects reduce_only=true for proof", () => {
    const r = call({ reduce_only: true });
    expect(r).toEqual({ ok: false, reason: "REJECT_REDUCE_ONLY_FORBIDDEN" });
  });

  it("rejects missing/blank proof token", () => {
    expect(call({ proof_token: "" })).toEqual({ ok: false, reason: "REJECT_TOKEN_INVALID" });
    expect(call({ proof_token: "   " })).toEqual({ ok: false, reason: "REJECT_TOKEN_INVALID" });
    expect(call({ proof_token: null })).toEqual({ ok: false, reason: "REJECT_TOKEN_INVALID" });
  });

  it("rejects when min order size is unknown", () => {
    const r = call({}, {}, { minOrderSize: null });
    expect(r).toEqual({ ok: false, reason: "REJECT_MIN_SIZE_UNKNOWN" });
  });

  it("rejects when size != exchange minimum", () => {
    const r = call({ size: MIN_SIZE * 2 });
    expect(r).toEqual({ ok: false, reason: "REJECT_SIZE_NOT_EXCHANGE_MIN" });
  });

  it("blocks non-testnet_proof purpose against testnet cfg when enabled=false", () => {
    const r = call({ purpose: "unspecified" });
    expect(r).toEqual({ ok: false, reason: "CONFIG_DISABLED" });
  });

  it("permits is_live=false non-proof testnet intent only when enabled=true", () => {
    const r = call({ purpose: undefined }, { enabled: true });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.path).toBe("enabled");
  });

  it("isProofIntent matches only the exact purpose", () => {
    expect(isProofIntent(PROOF_PURPOSE)).toBe(true);
    expect(isProofIntent("prove_testnet")).toBe(false);
    expect(isProofIntent(undefined)).toBe(false);
  });
});

describe("proof-gate — P0 mainnet lockdown", () => {
  it("is_live=true + purpose=live_proof + apex_omni + verified mainnet cfg → MAINNET_DISABLED", () => {
    const r = call(
      { is_live: true, purpose: "live_proof", venue: "apex_omni" },
      { exchange_type: "apex_omni", environment: "mainnet" },
    );
    expect(r).toEqual({ ok: false, reason: "MAINNET_DISABLED" });
  });

  it("is_live=true + purpose=testnet_proof → MAINNET_DISABLED", () => {
    const r = call({ is_live: true, purpose: PROOF_PURPOSE });
    expect(r).toEqual({ ok: false, reason: "MAINNET_DISABLED" });
  });

  it("purpose=live_proof with is_live=false → MAINNET_DISABLED", () => {
    const r = call({ purpose: "live_proof", is_live: false });
    expect(r).toEqual({ ok: false, reason: "MAINNET_DISABLED" });
  });

  it("venue=apex_omni (mainnet) with purpose=testnet_proof, is_live=false → MAINNET_DISABLED", () => {
    const r = call({ venue: "apex_omni" });
    expect(r).toEqual({ ok: false, reason: "MAINNET_DISABLED" });
  });

  it("cfg.exchange_type=apex_omni → MAINNET_DISABLED", () => {
    const r = call({}, { exchange_type: "apex_omni" });
    expect(r).toEqual({ ok: false, reason: "MAINNET_DISABLED" });
  });

  it("cfg.environment=mainnet → MAINNET_DISABLED", () => {
    const r = call({}, { environment: "mainnet" });
    expect(r).toEqual({ ok: false, reason: "MAINNET_DISABLED" });
  });

  it("cfg.enabled=true cannot re-enable live: is_live=true → MAINNET_DISABLED", () => {
    const r = call({ is_live: true }, { enabled: true });
    expect(r).toEqual({ ok: false, reason: "MAINNET_DISABLED" });
  });

  it("purpose=anything_else against mainnet venue → MAINNET_DISABLED", () => {
    const r = call({ purpose: "anything_else", venue: "apex_omni" });
    expect(r).toEqual({ ok: false, reason: "MAINNET_DISABLED" });
  });

  it("adversarial matrix: evaluateGate NEVER returns path 'live' or 'live_proof'", () => {
    const purposes = [
      PROOF_PURPOSE,
      "live_proof",
      "live",
      "anything",
      undefined,
      null,
      "",
    ];
    const venues = ["apex_omni", "apex_omni_testnet", "btcc", "hyperliquid"];
    const isLives = [true, false];
    const envs = ["mainnet", "testnet", null, "MAINNET", "TESTNET"];
    const exchTypes = ["apex_omni", "apex_omni_testnet", "btcc"];
    const enableds = [true, false];

    for (const purpose of purposes)
      for (const venue of venues)
        for (const is_live of isLives)
          for (const environment of envs)
            for (const exchange_type of exchTypes)
              for (const enabled of enableds) {
                const decision = evaluateGate({
                  intent: {
                    purpose: purpose as string | null | undefined,
                    venue,
                    symbol: PROOF_TEST_SYMBOL,
                    reduce_only: false,
                    is_live,
                    size: MIN_SIZE,
                    proof_token: "tok",
                    confirmation_token: "confirmed_abcdef1234567890",
                  },
                  cfg: {
                    enabled,
                    exchange_type,
                    environment,
                    permission_trade: true,
                    permissions_verified: true,
                  },
                  signatureValid: true,
                  minOrderSize: MIN_SIZE,
                });
                if (decision.ok) {
                  // Type-narrowed decision path — must never be a live variant.
                  const d: GateDecision = decision;
                  if (d.ok) {
                    expect(d.path === "proof" || d.path === "enabled").toBe(true);
                    expect((d.path as string) === "live").toBe(false);
                    expect((d.path as string) === "live_proof").toBe(false);
                  }
                }
                // Any live/mainnet-ish shape must be rejected as MAINNET_DISABLED.
                if (
                  is_live ||
                  purpose === "live_proof" ||
                  venue !== PROOF_VENUE ||
                  exchange_type !== PROOF_VENUE ||
                  (environment && environment.toLowerCase() !== "testnet")
                ) {
                  expect(decision.ok).toBe(false);
                  if (!decision.ok) {
                    expect(decision.reason).toBe("MAINNET_DISABLED");
                  }
                }
              }
  });

  it("happy path unchanged: strict testnet_proof still returns path:'proof'", () => {
    const r = call();
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.path).toBe("proof");
  });
});

describe("proof-gate — owner-enabled mainnet posture (mainnetEnabled=true)", () => {
  const liveCfg: BrokerConfigInput = {
    enabled: true,
    exchange_type: "apex_omni",
    environment: "mainnet",
    permission_trade: true,
    permissions_verified: true,
  };
  const liveIntent: ProofIntentInput = {
    purpose: "open_position",
    venue: "apex_omni",
    symbol: "BTC-USDT",
    reduce_only: false,
    is_live: true,
    size: MIN_SIZE,
    proof_token: null,
  };

  it("is_live=true + mainnet cfg + mainnetEnabled=true → path:'live'", () => {
    const r = evaluateGate({
      intent: liveIntent,
      cfg: liveCfg,
      signatureValid: true,
      minOrderSize: MIN_SIZE,
      mainnetEnabled: true,
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.path).toBe("live");
  });

  it("mainnetEnabled=true but cfg.enabled=false → CONFIG_DISABLED", () => {
    const r = evaluateGate({
      intent: liveIntent,
      cfg: { ...liveCfg, enabled: false },
      signatureValid: true,
      minOrderSize: MIN_SIZE,
      mainnetEnabled: true,
    });
    expect(r).toEqual({ ok: false, reason: "CONFIG_DISABLED" });
  });

  it("mainnetEnabled defaults to false: same live intent still MAINNET_DISABLED", () => {
    const r = evaluateGate({
      intent: liveIntent,
      cfg: liveCfg,
      signatureValid: true,
      minOrderSize: MIN_SIZE,
    });
    expect(r).toEqual({ ok: false, reason: "MAINNET_DISABLED" });
  });

  it("testnet_proof path unaffected when mainnetEnabled=true", () => {
    const r = evaluateGate({
      intent: okIntent,
      cfg: okCfg,
      signatureValid: true,
      minOrderSize: MIN_SIZE,
      mainnetEnabled: true,
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.path).toBe("proof");
  });
});

describe("proof-gate extractMinOrderSize", () => {
  it("parses minOrderSize from a perpetualContract list", () => {
    const body = {
      data: {
        perpetualContract: [
          { symbol: "BTC-USDT", minOrderSize: "0.001", stepSize: "0.001" },
          { symbol: "ETH-USDT", minOrderSize: "0.01" },
        ],
      },
    };
    expect(extractMinOrderSize(body, "BTC-USDT")).toBe(0.001);
  });

  it("parses minOrderSize under contractConfig.perpetualContract", () => {
    const body = {
      data: {
        contractConfig: {
          perpetualContract: [{ symbol: "BTC-USDT", minOrderSize: "0.002" }],
        },
      },
    };
    expect(extractMinOrderSize(body, "BTC-USDT")).toBe(0.002);
  });

  it("returns null when symbol is missing", () => {
    expect(extractMinOrderSize({ data: { perpetualContract: [] } }, "BTC-USDT")).toBeNull();
  });

  it("returns null when payload is malformed", () => {
    expect(extractMinOrderSize(null, "BTC-USDT")).toBeNull();
    expect(extractMinOrderSize("nope" as unknown, "BTC-USDT")).toBeNull();
  });
});
