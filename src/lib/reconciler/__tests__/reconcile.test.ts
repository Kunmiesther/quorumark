/**
 * Reconciler contract guard — verifies the reconciler edge function encodes
 * the invariants the live desk depends on:
 *
 *   1. It ONLY hits read-only ApeX endpoints. No order placement / cancel
 *      paths are reachable from the reconciler.
 *   2. It writes source='live' every time and reads source='live' when
 *      choosing which rows to close, so paper rows are never touched.
 *   3. It closes stale open rows (present in DB, missing at venue).
 *   4. It stamps synced_at so the UI freshness chip works.
 *   5. Every venue call is HMAC-SHA256 signed in-process from encrypted
 *      credentials (owner ruling #12 decoupled reads from the signer
 *      container; the signing contract itself is unchanged and canonical).
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

const SRC = fs.readFileSync(
  path.resolve(__dirname, "../../../../supabase/functions/reconcile-live-positions/index.ts"),
  "utf8",
);
const READER = fs.readFileSync(
  path.resolve(__dirname, "../../../../supabase/functions/_shared/apex-omni-read.ts"),
  "utf8",
);
const DESK = fs.readFileSync(
  path.resolve(__dirname, "../../../components/trade/TradeDesk.tsx"),
  "utf8",
);

describe("reconcile-live-positions edge function", () => {
  it("only calls READ-ONLY venue endpoints", () => {
    expect(SRC).toMatch(/fetchOpenPositions/);
    expect(SRC).not.toMatch(/\/v1\/orders/);
    expect(SRC).not.toMatch(/\/v1\/cancel/);
    expect(SRC).not.toMatch(/apexCancelOrder/);
    expect(SRC).not.toMatch(/create-order/);
  });

  it("signs every venue call with HMAC-SHA256 over the canonical message", () => {
    // ts + METHOD + signPath + body, HMAC-SHA256, base64 — identical to
    // signer/app/orders_v3.py :: sign_canonical.
    expect(READER).toMatch(/name:\s*"HMAC",\s*hash:\s*"SHA-256"/);
    expect(READER).toMatch(/\$\{tsMs\}\$\{method\.toUpperCase\(\)\}\$\{signPath\}\$\{body\}/);
    expect(READER).toMatch(/"APEX-SIGNATURE":\s*signature/);
    expect(READER).toMatch(/"APEX-API-KEY"/);
    expect(READER).toMatch(/"APEX-PASSPHRASE"/);
    // Credentials are never read in plaintext from the database.
    expect(READER).toMatch(/decryptField/);
    expect(READER).toMatch(/encrypted_api_secret/);
  });

  it("writes source='live' on upsert and never mixes with paper", () => {
    expect(SRC).toMatch(/source:\s*"live"/);
    // The read that decides which rows to close must filter to live-only.
    expect(SRC).toMatch(/\.eq\("source",\s*"live"\)/);
  });

  it("stamps synced_at on both insert and update paths", () => {
    expect(SRC).toMatch(/synced_at:/);
  });

  it("does not turn a failed open-order read into an empty protected snapshot", () => {
    expect(SRC).toMatch(/if \(!ordResp\.ok\) return/);
    expect(SRC).toMatch(/open_orders_readable:\s*true/);
    expect(SRC).not.toMatch(/ordResp\.ok \? ordResp\.orders : \[\]/);
  });

  it("closes stale rows that are absent at the venue", () => {
    expect(SRC).toContain("livePositionClosePatch(now, row.strategy_metadata)");
    expect(SRC).toContain('.eq("status", "open").lte("synced_at", now)');
    expect(SRC).toMatch(/seenKeys\.has/);
  });

  it("only enumerates ApeX live-enabled connections", () => {
    expect(SRC).toMatch(/is_live/);
    expect(SRC).toMatch(/apex_omni/);
  });
});

describe("TradeDesk live-desk wiring", () => {
  it("live query filters by source='live' so paper rows can't leak in", () => {
    expect(DESK).toMatch(/\.eq\("source",\s*"live"\)/);
  });

  it("selects synced_at + protection fields the reconciler writes", () => {
    expect(DESK).toMatch(/synced_at/);
    expect(DESK).toMatch(/liquidation_price/);
    expect(DESK).toMatch(/unrealized_pnl/);
  });

  it("renders a freshness / error chip for the live venue sync", () => {
    expect(DESK).toMatch(/data-testid="live-sync-chip"/);
    expect(DESK).toMatch(/data-stale/);
    expect(DESK).toMatch(/data-error/);
  });

  it("paper desk still reads paper_positions (unchanged)", () => {
    expect(DESK).toMatch(/from\("paper_positions"\)/);
  });
});
