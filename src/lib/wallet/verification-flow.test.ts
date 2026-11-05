// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { runVerificationFlow, type VerificationPhase } from "./verification-flow";
import { WalletError } from "./providers";

function baseDeps(overrides: Partial<Parameters<typeof runVerificationFlow>[1]> = {}) {
  const phases: VerificationPhase[] = [];
  return {
    phases,
    deps: {
      connect: vi.fn(async () => ({
        publicAddress: "0xabc",
        provider: "coinbase" as const,
        chain: "ethereum" as const,
      })),
      requestChallenge: vi.fn(async () => ({
        ok: true,
        challenge_text: "prove ownership",
        nonce_hash: "hash",
      })),
      sign: vi.fn(async () => ({ signature: "0xdeadbeef" })),
      verify: vi.fn(async () => ({ ok: true })),
      onPhase: (p: VerificationPhase) => phases.push(p),
      ...overrides,
    },
  };
}

describe("verification flow state machine", () => {
  it("happy path: idle→connecting→awaiting_signature→verifying→verified", async () => {
    const { deps, phases } = baseDeps();
    const res = await runVerificationFlow("coinbase", deps);
    expect(res.ok).toBe(true);
    expect(phases).toEqual(["connecting", "awaiting_signature", "verifying", "verified"]);
  });

  it("connect rejection → error phase, sign/verify never called", async () => {
    const { deps, phases } = baseDeps({
      connect: vi.fn(async () => {
        throw new WalletError("USER_REJECTED_CONNECT", "no");
      }),
    });
    await expect(runVerificationFlow("coinbase", deps)).rejects.toMatchObject({
      code: "USER_REJECTED_CONNECT",
    });
    expect(phases).toEqual(["connecting", "error"]);
    expect(deps.sign).not.toHaveBeenCalled();
    expect(deps.verify).not.toHaveBeenCalled();
  });

  it("signature rejection → error phase before verify, no verified result", async () => {
    const { deps, phases } = baseDeps({
      sign: vi.fn(async () => {
        throw new WalletError("USER_REJECTED_SIGN", "no");
      }),
    });
    await expect(runVerificationFlow("coinbase", deps)).rejects.toMatchObject({
      code: "USER_REJECTED_SIGN",
    });
    expect(phases).toEqual(["connecting", "awaiting_signature", "error"]);
    expect(deps.verify).not.toHaveBeenCalled();
  });

  it("server verify failure → error, no verified phase", async () => {
    const { deps, phases } = baseDeps({
      verify: vi.fn(async () => ({ ok: false, code: "INVALID_SIGNATURE", message: "nope" })),
    });
    await expect(runVerificationFlow("coinbase", deps)).rejects.toMatchObject({
      code: "INVALID_SIGNATURE",
    });
    expect(phases).toEqual(["connecting", "awaiting_signature", "verifying", "error"]);
    expect(phases).not.toContain("verified");
  });

  it("challenge failure → error before signing", async () => {
    const { deps, phases } = baseDeps({
      requestChallenge: vi.fn(async () => ({ ok: false, message: "rate limited" })),
    });
    await expect(runVerificationFlow("coinbase", deps)).rejects.toMatchObject({
      code: "CHALLENGE_FAILED",
    });
    expect(phases).toEqual(["connecting", "error"]);
    expect(deps.sign).not.toHaveBeenCalled();
  });

  it("WalletConnect session-expired error surfaces from connect and skips sign/verify", async () => {
    const { deps, phases } = baseDeps({
      connect: vi.fn(async () => {
        throw new WalletError("WALLETCONNECT_SESSION_EXPIRED", "expired");
      }),
    });
    await expect(runVerificationFlow("walletconnect", deps)).rejects.toMatchObject({
      code: "WALLETCONNECT_SESSION_EXPIRED",
    });
    expect(phases).toEqual(["connecting", "error"]);
  });
});
