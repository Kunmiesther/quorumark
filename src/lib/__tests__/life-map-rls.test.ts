/**
 * RLS / ownership behavioral tests for the P3 Life Map + Risk Capital tables.
 *
 * These are intentionally SKIPPED. They require an isolated Supabase branch
 * or a local DB with test users — inserting fixtures into the production
 * database is forbidden by the P3 process rules.
 *
 * To enable: point a test-only Supabase client at an isolated branch/local
 * DB, provision two throwaway auth users (User A and User B), and un-skip.
 */
import { describe, it } from "vitest";

describe.skip("P3 RLS — Life Map + Risk Capital (isolated DB only)", () => {
  it("User A cannot SELECT User B's life_categories", () => {});
  it("User A cannot INSERT a life_categories row with user_id = User B", () => {});
  it("User A cannot SELECT User B's life_obligations", () => {});
  it("User A cannot UPDATE User B's life_obligations", () => {});
  it("User A cannot DELETE User B's life_obligations", () => {});
  it("life_obligation_history rejects UPDATE and DELETE for any authenticated user (append-only)", () => {});
  it("User A cannot SELECT User B's risk_capital_allocations", () => {});
  it("risk_capital_allocations unique-confirmed index prevents 2 confirmed rows for the same user", () => {});
  it("confirmed_risk_capital(uuid) is NOT callable by anon/authenticated (EXECUTE revoked)", () => {});
  it("my_confirmed_risk_capital() returns 0 when auth.uid() is null", () => {});
  it("my_confirmed_risk_capital() returns sum of confirmed rows for the signed-in user", () => {});

  // Life Map v2 (bills)
  it("User A cannot SELECT User B's bills", () => {});
  it("User A cannot INSERT a bills row with user_id = User B", () => {});
  it("User A cannot UPDATE or archive User B's bills", () => {});
  it("User A cannot SELECT User B's bill_allocations", () => {});
  it("User A cannot INSERT a bill_allocations row with user_id = User B", () => {});
  it("bill_allocations partial UNIQUE (user_id, trade_id, bill_id) rejects duplicate inserts", () => {});
  it("User A cannot SELECT User B's bill_sync_cursor", () => {});
});
