import { describe, expect, it } from "vitest";

import { walletLogo } from "@/lib/wallet-logos";

describe("wallet logo registry", () => {
  it("bundles Phantom instead of depending on an expiring asset proxy", () => {
    const logo = walletLogo("Phantom");
    expect(logo).toMatch(/^data:image\/svg\+xml,/);
    expect(logo).toContain("AB9FF2");
    expect(logo).not.toContain("/__l5e/assets-v1/");
  });
  it("uses the bundled official MetaMask mark", () => {
    const logo = walletLogo("MetaMask");

    expect(logo).toBeTruthy();
    expect(logo).toMatch(/^data:image\/svg\+xml,/);
    expect(logo).toContain("%23ff5c16");
    expect(logo).not.toContain("/__l5e/assets-v1/");
  });
});
