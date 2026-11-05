/**
 * LifeMapFundingCard guards — same source as /life-map, priority ordering,
 * overflow strategy, and honest zero rendering.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

const SRC = fs.readFileSync(
  path.resolve(__dirname, "../TradeDesk.tsx"),
  "utf8",
);
const LIFEMAP_PAGE = fs.readFileSync(
  path.resolve(__dirname, "../../../routes/_authenticated/life-map.tsx"),
  "utf8",
);

describe("LifeMapFundingCard", () => {
  it("reads the SAME selector as the /life-map page (getLifeMapSnapshot)", () => {
    expect(SRC).toMatch(/getLifeMapSnapshot/);
    expect(LIFEMAP_PAGE).toMatch(/getLifeMapSnapshot/);
  });

  it("does not maintain a parallel bills fetch — snapshot is single source", () => {
    // listBills fetch was previously used alongside the snapshot; the rewrite
    // uses snap.bills directly so counts and coverage match the Life Map page.
    expect(SRC).not.toMatch(/listBills/);
  });

  it("renders one row per bill with progress bar and coverage / target", () => {
    expect(SRC).toMatch(/data-testid="life-map-funding-row"/);
    expect(SRC).toMatch(/fmtUsd\(covered\)/);
    expect(SRC).toMatch(/fmtUsd\(amount\)/);
  });


  it("orders rows by engine priority (server-sorted; no client re-sort by name)", () => {
    // We rely on the server: priority ASC, created_at ASC. Guard the
    // implementation against silently sorting alphabetically on the client.
    expect(SRC).not.toMatch(/\.sort\(\(a, b\) => a\.bill\.name\.localeCompare/);
  });

  it("uses the +N more overflow affordance with a collapsed count", () => {
    expect(SRC).toMatch(/FUNDING_COLLAPSED_ROWS\s*=\s*8/);
    expect(SRC).toMatch(/data-testid="life-map-funding-more"/);
    expect(SRC).toMatch(/\+\$\{overflow\} more|`\+\$\{overflow\} more`/);
  });

  it("keeps summary footer (coverage line, available allocation, manage button)", () => {
    expect(SRC).toMatch(/Coverage · /);
    expect(SRC).toMatch(/Available Realized-Profit Allocation/);
    expect(SRC).toMatch(/Manage Allocation/);
  });

  it("progress bar uses onixus-teal token; zero coverage stays neutral (transparent fill)", () => {
    expect(SRC).toMatch(/var\(--onixus-teal\)/);
    expect(SRC).toMatch(/zero \? "transparent" : "var\(--onixus-teal\)"/);
  });

  it("uses onixus-hot-blue for the '+N more' toggle (platform palette, no stock blue)", () => {
    expect(SRC).toMatch(/text-\[color:var\(--onixus-hot-blue\)\][\s\S]{0,500}\+\$\{overflow\} more/);
  });

  it("respects the active desk book (paper|live) for available allocation label", () => {
    expect(SRC).toMatch(/book === "paper"[\s\S]*?Simulated gains/);
    expect(SRC).toMatch(/Protected for funding/);
  });
});
