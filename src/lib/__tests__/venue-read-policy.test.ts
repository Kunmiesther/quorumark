import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { selectReadableVenueConnections } from "../../../supabase/functions/_shared/venue-read-policy";

type Row = { exchange: string; status: string; permission_read: boolean; is_live: boolean; permission_trade: boolean };
const base: Row = { exchange: "aster", status: "verified", permission_read: true, is_live: false, permission_trade: false };
class Query {
  constructor(public rows: Row[]) {}
  eq(column: string, value: boolean): this {
    this.rows = this.rows.filter(row => row[column as keyof Row] === value);
    return this;
  }
  in(column: string, values: string[]): this {
    this.rows = this.rows.filter(row => values.includes(String(row[column as keyof Row])));
    return this;
  }
}

describe("read-only venue observation is independent of order routing", () => {
  it.each(["aster", "apex_omni", "apex_omni_testnet"])("observes %s while paused, without trade permission", exchange => {
    const row = { ...base, exchange };
    expect(selectReadableVenueConnections(new Query([row])).rows).toEqual([row]);
    expect(row.is_live).toBe(false);
    expect(row.permission_trade).toBe(false);
  });
  it.each(["verified", "paused"])("observes %s accounts whether routing is on or off", status => {
    const rows = [false, true].map(is_live => ({ ...base, status, is_live }));
    expect(selectReadableVenueConnections(new Query(rows)).rows).toEqual(rows);
  });
  it.each(["disconnected", "pending_verification", "verifying", "needs_attention", "unsupported"])("excludes %s accounts even if their old live flag is true", status => {
    expect(selectReadableVenueConnections(new Query([{ ...base, status, is_live: true }])).rows).toEqual([]);
  });
  it("excludes accounts without read permission and unsupported venues", () => {
    const rows = [{ ...base, permission_read: false }, { ...base, exchange: "synfutures" }];
    expect(selectReadableVenueConnections(new Query(rows)).rows).toEqual([]);
  });
  it.each(["reconcile-live-positions", "ingest-live-fills"])("wires %s to the read policy, not the trading switch", fn => {
    const source = readFileSync(`supabase/functions/${fn}/index.ts`, "utf8");
    expect(source).toContain("selectReadableVenueConnections(supabase");
    expect(source).not.toMatch(/\.eq\("is_live",\s*true\)/);
  });
});
