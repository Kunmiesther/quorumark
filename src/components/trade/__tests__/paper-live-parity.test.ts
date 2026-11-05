/**
 * Ruling #7 — paper/live parity guards.
 *
 * Enforced by static analysis on TradeDesk.tsx so a future edit can't silently
 * regress the safety rules the owner set:
 *
 *   • LIVE mode reads only from `public.positions`; PAPER reads only from
 *     `public.paper_positions`. Neither table is queried in the other's
 *     branch (no silent fallback).
 *   • Every surface that shows positions, trades, or an order action carries
 *     a runtime-derived PAPER / LIVE badge (BookBadge / book-badge testid).
 *   • The route never defaults to a book when `?book=` is missing — an
 *     explicit chooser is rendered instead.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

const DESK = fs.readFileSync(path.resolve(__dirname, "../TradeDesk.tsx"), "utf8");
const HISTORY = fs.readFileSync(
  path.resolve(__dirname, "../TradeHistoryCard.tsx"),
  "utf8",
);
const ROUTE = fs.readFileSync(
  path.resolve(__dirname, "../../../routes/_authenticated/trade.tsx"),
  "utf8",
);

/** Extract the body of the useOpenPositions hook so we can assert per-branch
 * table access. Matches from `function useOpenPositions` up to the next
 * top-level `function ` declaration. */
function sliceUseOpenPositions(src: string): string {
  const start = src.indexOf("function useOpenPositions(");
  expect(start).toBeGreaterThan(-1);
  const after = src.indexOf("\nfunction ", start + 20);
  return src.slice(start, after === -1 ? undefined : after);
}

describe("Ruling #7 — paper/live parity", () => {
  it("useOpenPositions LIVE branch reads only public.positions", () => {
    const body = sliceUseOpenPositions(DESK);
    // Split into paper branch and live branch by the `if (book === "paper")`
    const paperIdx = body.indexOf('if (book === "paper")');
    expect(paperIdx).toBeGreaterThan(-1);
    // Find the closing of the paper block by scanning braces
    const openBrace = body.indexOf("{", paperIdx);
    let depth = 0;
    let closeIdx = -1;
    for (let i = openBrace; i < body.length; i++) {
      if (body[i] === "{") depth++;
      else if (body[i] === "}") {
        depth--;
        if (depth === 0) {
          closeIdx = i;
          break;
        }
      }
    }
    expect(closeIdx).toBeGreaterThan(openBrace);
    const paperBranch = body.slice(paperIdx, closeIdx + 1);
    const liveBranch = body.slice(closeIdx + 1);

    // PAPER branch queries paper_positions and NEVER positions
    expect(paperBranch).toMatch(/\.from\("paper_positions"\)/);
    expect(paperBranch).not.toMatch(/\.from\("positions"\)/);

    // LIVE branch queries positions and NEVER paper_positions
    expect(liveBranch).toMatch(/\.from\("positions"\)/);
    expect(liveBranch).not.toMatch(/\.from\("paper_positions"\)/);
  });

  it("empty live positions renders an empty state without ever falling back to paper", () => {
    // Branch isolation is proven above. Here we assert the empty label is
    // computed from the current `book` variable — a hardcoded "paper" string
    // in the empty state would be the exact silent fallback Ruling #7 forbids.
    expect(DESK).toMatch(/No open positions \(\$\{book\}\)/);
  });

  it("every position/trade/order surface renders a BookBadge tied to `book`", () => {
    // Positions card, history card, and OrderPanel deploy area all emit a
    // book-badge testid.
    expect(DESK).toMatch(/book-badge-\$\{book\}/); // BookBadge component
    expect(DESK).toMatch(/<BookBadge book=\{book\}/); // used at least once
    expect(HISTORY).toMatch(/book-badge-\$\{book\}/);
    // The order-action surface calls it out explicitly.
    expect(DESK).toMatch(/Order routes to[\s\S]{0,200}BookBadge/);
  });

  it("route does NOT default the book — renders an explicit chooser", () => {
    // No hardcoded INITIAL_BOOK constant, no silent fallback to 'live' or 'paper'.
    expect(ROUTE).not.toMatch(/INITIAL_BOOK/);
    expect(ROUTE).toMatch(/ModeChooser/);
    expect(ROUTE).toMatch(/data-testid="trade-mode-unresolved"/);
  });
});
