import { describe, it, expect } from "vitest";
import {
  deriveExecutionStatus,
  describeExecutionStatus,
  STATUS_LABELS,
  type ExecutionStatus,
  type ExecutionStatusInput,
} from "@/lib/execution-status";

const base: ExecutionStatusInput = {
  hasVerifiedConnection: false,
  hasMainnetConnection: false,
  hasSigningCredential: false,
  enabled: false,
  mode: "paper",
};

describe("deriveExecutionStatus", () => {
  it("returns 'setup' when there is no verified connection", () => {
    expect(deriveExecutionStatus({ ...base })).toBe("setup");
    expect(
      deriveExecutionStatus({
        ...base,
        hasMainnetConnection: true,
        enabled: true,
        hasSigningCredential: true,
      }),
    ).toBe("setup");
  });

  it("returns 'mainnet_locked' for verified mainnet connection without signing credential", () => {
    expect(
      deriveExecutionStatus({
        ...base,
        hasVerifiedConnection: true,
        hasMainnetConnection: true,
        enabled: false,
      }),
    ).toBe("mainnet_locked");
  });

  it("returns 'needs_attention' when a mainnet connection is present but permissions are not verified", () => {
    expect(
      deriveExecutionStatus({
        ...base,
        hasVerifiedConnection: true,
        hasMainnetConnection: false,
        permissionsVerified: false,
        enabled: true,
        mode: "live",
      }),
    ).toBe("needs_attention");
  });

  it("returns 'paper' for verified non-mainnet connection", () => {
    expect(
      deriveExecutionStatus({
        ...base,
        hasVerifiedConnection: true,
        hasMainnetConnection: false,
        enabled: false,
      }),
    ).toBe("paper");
  });

  it("returns 'live_routing_off' when signing credential is ready but strategy is paused or paper", () => {
    expect(
      deriveExecutionStatus({
        ...base,
        hasVerifiedConnection: true,
        hasMainnetConnection: true,
        hasSigningCredential: true,
        enabled: false,
        mode: "live",
      }),
    ).toBe("live_routing_off");
    expect(
      deriveExecutionStatus({
        ...base,
        hasVerifiedConnection: true,
        hasMainnetConnection: true,
        hasSigningCredential: true,
        enabled: true,
        mode: "paper",
      }),
    ).toBe("live_routing_off");
  });

  it("returns 'mainnet_active' only when credential, strategy enabled, and live mode", () => {
    expect(
      deriveExecutionStatus({
        ...base,
        hasVerifiedConnection: true,
        hasMainnetConnection: true,
        hasSigningCredential: true,
        enabled: true,
        mode: "live",
      }),
    ).toBe("mainnet_active");
  });

  it("'mainnet_active' is UNREACHABLE without a signing credential", () => {
    const modes: Array<string | null> = ["paper", "live", null, "test"];
    for (const mode of modes) {
      for (const enabled of [true, false]) {
        for (const hasMainnetConnection of [true, false]) {
          const status = deriveExecutionStatus({
            hasVerifiedConnection: true,
            hasMainnetConnection,
            hasSigningCredential: false,
            enabled,
            mode,
          });
          expect(status).not.toBe("mainnet_active");
        }
      }
    }
  });
});

describe("describeExecutionStatus", () => {
  it("names the missing item for mainnet_locked (no credential)", () => {
    const r = describeExecutionStatus({
      ...base,
      hasVerifiedConnection: true,
      hasMainnetConnection: true,
    });
    expect(r.status).toBe("mainnet_locked");
    expect(r.description.toLowerCase()).toContain("signing credential");
    expect(r.description.toLowerCase()).not.toContain("proof");
  });

  it("names paused strategy for live_routing_off when enabled=false", () => {
    const r = describeExecutionStatus({
      ...base,
      hasVerifiedConnection: true,
      hasMainnetConnection: true,
      hasSigningCredential: true,
      enabled: false,
      mode: "live",
    });
    expect(r.status).toBe("live_routing_off");
    expect(r.description.toLowerCase()).toContain("paused");
  });

  it("names paper mode for live_routing_off when mode=paper", () => {
    const r = describeExecutionStatus({
      ...base,
      hasVerifiedConnection: true,
      hasMainnetConnection: true,
      hasSigningCredential: true,
      enabled: true,
      mode: "paper",
    });
    expect(r.status).toBe("live_routing_off");
    expect(r.description.toLowerCase()).toContain("paper mode");
  });

  it("mainnet_active is positive tone", () => {
    const r = describeExecutionStatus({
      ...base,
      hasVerifiedConnection: true,
      hasMainnetConnection: true,
      hasSigningCredential: true,
      enabled: true,
      mode: "live",
    });
    expect(r.status).toBe("mainnet_active");
    expect(r.tone).toBe("positive");
  });
});

describe("STATUS_LABELS", () => {
  it("has the expected statuses", () => {
    const keys = Object.keys(STATUS_LABELS).sort();
    expect(keys).toEqual(
      (
        [
          "live_routing_off",
          "mainnet_active",
          "mainnet_locked",
          "needs_attention",
          "paper",
          "setup",
        ] as ExecutionStatus[]
      ).sort(),
    );
  });

  it("contains no customer-facing testnet or legacy proof string", () => {
    const serialized = JSON.stringify(STATUS_LABELS).toLowerCase();
    expect(serialized).not.toContain("testnet");
    expect(serialized).not.toContain("signer proof");
  });

  it("assigns tones as specified", () => {
    expect(STATUS_LABELS.setup.tone).toBe("neutral");
    expect(STATUS_LABELS.paper.tone).toBe("neutral");
    expect(STATUS_LABELS.mainnet_locked.tone).toBe("warning");
    expect(STATUS_LABELS.mainnet_active.tone).toBe("positive");
  });
});
