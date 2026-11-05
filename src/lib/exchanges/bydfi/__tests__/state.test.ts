import { describe, expect, it } from "vitest";
import { computeBydfiState, isBydfiTradeReady } from "../state";

const NOW = 1_700_000_000_000;

describe("bydfi/state machine", () => {
  it("returns NOT_CONNECTED without credentials", () => {
    expect(computeBydfiState({ hasCredentials: false, handshake: null, now: NOW })).toBe("NOT_CONNECTED");
  });

  it("returns VERIFYING while handshake is in flight or missing", () => {
    expect(computeBydfiState({ hasCredentials: true, handshake: null, now: NOW })).toBe("VERIFYING");
    expect(
      computeBydfiState({
        hasCredentials: true,
        handshake: { authOk: false, capabilitiesOk: false, verifiedAt: null, expiresAt: null, lastErrorCode: null, inFlight: true },
        now: NOW,
      }),
    ).toBe("VERIFYING");
  });

  it("REJECTED on hard credential/signature/permission errors", () => {
    for (const code of ["invalid_credentials", "signature_rejected", "permission_denied", "withdrawal_permission_present"] as const) {
      expect(
        computeBydfiState({
          hasCredentials: true,
          handshake: { authOk: false, capabilitiesOk: false, verifiedAt: null, expiresAt: null, lastErrorCode: code, inFlight: false },
          now: NOW,
        }),
      ).toBe("REJECTED");
    }
  });

  it("EXPIRED past the cached expires_at", () => {
    expect(
      computeBydfiState({
        hasCredentials: true,
        handshake: { authOk: true, capabilitiesOk: true, verifiedAt: NOW - 10, expiresAt: NOW - 1, lastErrorCode: null, inFlight: false },
        now: NOW,
      }),
    ).toBe("EXPIRED");
  });

  it("DEGRADED after transient errors even with cached caps", () => {
    for (const code of ["rate_limited", "network_timeout", "http_error"] as const) {
      expect(
        computeBydfiState({
          hasCredentials: true,
          handshake: { authOk: true, capabilitiesOk: true, verifiedAt: NOW - 10, expiresAt: NOW + 10_000, lastErrorCode: code, inFlight: false },
          now: NOW,
        }),
      ).toBe("DEGRADED");
    }
  });

  it("CAPABILITIES_VERIFIED only when full handshake ok and fresh", () => {
    const state = computeBydfiState({
      hasCredentials: true,
      handshake: { authOk: true, capabilitiesOk: true, verifiedAt: NOW - 10, expiresAt: NOW + 10_000, lastErrorCode: null, inFlight: false },
      now: NOW,
    });
    expect(state).toBe("CAPABILITIES_VERIFIED");
    expect(isBydfiTradeReady(state)).toBe(true);
  });

  it("auth-only success is CONNECTED_READ_ONLY and NOT trade-ready", () => {
    const state = computeBydfiState({
      hasCredentials: true,
      handshake: { authOk: true, capabilitiesOk: false, verifiedAt: null, expiresAt: null, lastErrorCode: null, inFlight: false },
      now: NOW,
    });
    expect(state).toBe("CONNECTED_READ_ONLY");
    expect(isBydfiTradeReady(state)).toBe(false);
  });

  it("no non-verified state is ever trade-ready", () => {
    for (const s of ["NOT_CONNECTED", "VERIFYING", "CONNECTED_READ_ONLY", "DEGRADED", "EXPIRED", "REJECTED"] as const) {
      expect(isBydfiTradeReady(s)).toBe(false);
    }
  });
});
