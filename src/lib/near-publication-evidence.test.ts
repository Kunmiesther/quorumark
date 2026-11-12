import { afterEach, describe, expect, it, vi } from "vitest";
import { assertPublicationContractReady } from "./near-publication-evidence";

describe("NEAR publication contract preflight", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("allows approval when the owner view returns successfully", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ result: { result: [34, 116, 101, 115, 116, 110, 101, 116, 34] } }),
    }));

    await expect(assertPublicationContractReady()).resolves.toBeUndefined();
  });

  it("blocks wallet approval when the deployed contract is uninitialized", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ result: { error: "wasm execution failed with error: WasmTrap(Unreachable)" } }),
    }));

    await expect(assertPublicationContractReady()).rejects.toThrow(/must be initialized/);
  });
});
