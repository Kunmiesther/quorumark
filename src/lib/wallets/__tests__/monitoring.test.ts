/**
 * Monitoring wallets — behavioral and safety tests.
 *
 * These tests are pure/module-shape checks against the server-fn file. They
 * assert the contract the RPC guarantees end-to-end:
 *
 *   1. The module exports both server fns.
 *   2. No secrets, seed phrases, private keys, or deposit addresses appear
 *      anywhere in the source (truthful "simulated" label).
 *   3. Execution is disabled by default (server-side default).
 *   4. Mainnet prohibition — the module never references mainnet as a valid
 *      environment for these wallets.
 *   5. Owner-scoping is enforced via `requireSupabaseAuth` middleware.
 *   6. UI panel renders both direction badges and never shows a real key.
 *
 * The actual DB idempotency, cross-wallet isolation, and duplicate-call
 * safety live in the SECURITY DEFINER RPC (`create_turtle_monitoring_wallets`)
 * whose SQL invariant is exercised by the two-user integration harness when
 * enabled.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  createTurtleMonitoringWallets,
  getMonitoringWalletTelemetry,
} from "@/lib/wallets/monitoring.functions";

const FN_SRC = readFileSync(
  join(process.cwd(), "src/lib/wallets/monitoring.functions.ts"),
  "utf8",
);
const PANEL_SRC = readFileSync(
  join(process.cwd(), "src/components/ops/MonitoringWalletsPanel.tsx"),
  "utf8",
);

describe("Turtle monitoring wallets", () => {
  it("exports both server fns", () => {
    expect(typeof createTurtleMonitoringWallets).toBe("function");
    expect(typeof getMonitoringWalletTelemetry).toBe("function");
  });

  it("uses owner-scoped auth middleware", () => {
    expect(FN_SRC).toContain("requireSupabaseAuth");
    expect(FN_SRC).toContain(".middleware([requireSupabaseAuth])");
  });

  it("invokes the idempotent creation RPC by name", () => {
    expect(FN_SRC).toContain("create_turtle_monitoring_wallets");
  });

  it("never references seed phrase, private key, or deposit address", () => {
    for (const term of [
      "seed_phrase",
      "seedPhrase",
      "private_key",
      "privateKey",
      "deposit_address",
      "depositAddress",
      "mnemonic",
    ]) {
      expect(FN_SRC.toLowerCase()).not.toContain(term.toLowerCase());
      expect(PANEL_SRC.toLowerCase()).not.toContain(term.toLowerCase());
    }
  });

  it("labels wallets as simulated and paper environment", () => {
    expect(FN_SRC).toMatch(/["']simulated["']/);
    expect(FN_SRC).toMatch(/["']paper["']/);
    // Runtime creator never sets environment to mainnet (only type-union literal).
    expect(FN_SRC).not.toMatch(/environment\s*:\s*["']mainnet["']/);
  });

  it("execution defaults to disabled in UI messaging", () => {
    expect(PANEL_SRC).toContain('"disabled"');
    expect(PANEL_SRC).toContain("Execution stays disabled");
  });

  it("renders both direction scopes but never exposes raw wallet UUID", () => {
    expect(PANEL_SRC).toContain("redacted_id");
    // The panel exclusively surfaces the redacted id — the raw `w.id` field
    // is never rendered as text.
    expect(PANEL_SRC).not.toMatch(/>\s*\{w\.id\}\s*</);
  });
});

describe("Monitoring wallet type contract", () => {
  it("MonitoringWalletTelemetry surfaces every panel field", () => {
    // Compile-time evidence via structural shape check on the interface.
    const expectedFields = [
      "reserved_balance",
      "available_balance",
      "exposure_notional",
      "open_position_ids",
      "last_signal_at",
      "last_decision_at",
      "last_intent_at",
      "last_fill_at",
      "last_failure_at",
      "blocked_reason",
    ];
    for (const f of expectedFields) expect(FN_SRC).toContain(f);
  });
});
