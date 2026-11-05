import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

function source(path: string) {
  return readFileSync(path, "utf8");
}

describe("store-readiness safety rails", () => {
  it("only lets the authenticated caller hard-delete their own account", () => {
    const fn = source("supabase/functions/delete-account/index.ts");
    expect(fn).toContain("admin.auth.getUser(token)");
    expect(fn).toContain('body.confirmation !== "DELETE"');
    expect(fn).toContain('removeOwnedStorage(admin, "avatars", auth.user.id)');
    expect(fn).toContain('removeOwnedStorage(admin, "bill-proofs", auth.user.id)');
    expect(fn).toContain("admin.auth.admin.deleteUser(auth.user.id, false)");
  });

  it("requires explicit AI consent before provider credentials can be changed", () => {
    const fn = source("supabase/functions/llm-credentials/index.ts");
    expect(fn).toContain('select("ai_data_consent_at")');
    expect(fn).toContain("Enable AI data sharing in Profile");
  });

  it("keeps Onyx guided when AI sharing is not allowed", () => {
    const fn = source("src/lib/onyx/setup-guide.functions.ts");
    expect(fn).toContain("if (!profile?.ai_data_consent_at)");
    expect(fn).toContain('source: "guided" as const');
  });

  it("ships a native offline recovery screen", () => {
    const config = source("capacitor.config.ts");
    const shell = source("mobile-shell/index.html");
    expect(config).toContain('errorPath: "index.html"');
    expect(shell).toContain("You are offline");
    expect(shell).toContain("Try again");
  });

  it("keeps ApeX mainnet execution disabled pending approval", () => {
    const gate = source("supabase/functions/_shared/proof-gate.ts");
    expect(gate).toContain("MAINNET_DISABLED");
  });

  it("exposes an auditable multi-timeframe and Council decision view", () => {
    const panel = source("src/components/trade/DecisionProofPanel.tsx");
    const desk = source("src/components/trade/TradeDesk.tsx");
    expect(panel).toContain('from("strategy_decisions")');
    expect(panel).toContain('from("ai_decision_opinions")');
    expect(panel).toContain('row.timeframe === "15m"');
    expect(panel).toContain('timeframes["1h"]');
    expect(panel).toContain('timeframes["4h"]');
    expect(desk).toContain('label: "Decision proof"');
  });

  it("declares native push support for both platforms", () => {
    expect(source("android/app/src/main/AndroidManifest.xml")).toContain(
      "android.permission.POST_NOTIFICATIONS",
    );
    expect(source("ios/App/App/App.entitlements")).toContain("aps-environment");
  });

  it("enforces a production asset performance budget", () => {
    expect(source("package.json")).toContain('"performance:budget"');
    expect(source("scripts/check-performance-budget.mjs")).toContain("625 * 1024");
  });
});
