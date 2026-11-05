/**
 * Phase 3 source-contract tests for the paper engine facade.
 *
 * These tests do NOT exercise runtime behavior — they lock the public API
 * surface, the numeric constant values, and the module dependency graph so a
 * future refactor cannot silently break callers or introduce a cycle inside
 * `src/lib/paper/`.
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import * as engine from "../engine";
import * as constants from "../constants";

const PAPER_DIR = resolve(__dirname, "..");

/** Names historically exported from `@/lib/paper/engine` that external callers
 *  (verified via `rg`) rely on. Adding to this list is fine; removing is a
 *  breaking change that must be reviewed. */
const FACADE_PUBLIC_API = [
  // constants / helpers re-exported from ./constants
  "ONYX_MAX_TOTAL_OPEN",
  "ONYX_MAX_ALT_POSITIONS",
  "ONYX_BENCH_STOPS",
  "ONYX_RECENT_TRADE_LIMIT",
  "STARTING_ACCOUNT_BALANCE",
  "MMR",
  "MAX_HEAT",
  "WALLET_BASE",
  "MARGIN_FRACTION",
  "TARGET_LEVERAGE",
  "TAKER_BPS",
  "SLIP_BPS",
  "FEE_RATE",
  "SLIP_RATE",
  "EXECUTION_INTERVAL_MIN",
  "HEALTH_INTERVAL_MIN",
  "SCAN_UNIVERSE_SIZE",
  "INTERVAL_MIN",
  "FETCH_LIMIT",
  "MIN_STRUCTURAL_TP_DISTANCE_PCT",
  "MIN_TP_TO_STOP_DISTANCE_RATIO",
  "MAX_LOSS_MARGIN_FRAC",
  "shouldTriggerMaxLoss",
  "HUNTER_K_THRESHOLD",
  "HUNTER_RETRACE_WINDOW",
  "TREND_FILTER_ENABLED",
  "TREND_NEUTRAL_BLOCKS",
  "effectiveLeverage",
  "DEFAULT_PAPER_SYMBOLS",
  // orchestration entry point
  "runPaperTick",
] as const;

describe("paper engine facade — public API", () => {
  it.each(FACADE_PUBLIC_API)("re-exports %s", (name) => {
    expect((engine as Record<string, unknown>)[name]).toBeDefined();
  });
});

describe("paper engine constants — snapshot (no drift)", () => {
  it("matches the frozen strategy/sizing/leverage/fee/PnL values", () => {
    // These values must never drift in a refactor. Any change here means a
    // strategy/sizing/leverage/fee/PnL change and requires an explicit,
    // reviewed decision — not a Phase 3 refactor.
    expect({
      ONYX_MAX_TOTAL_OPEN: constants.ONYX_MAX_TOTAL_OPEN,
      ONYX_MAX_ALT_POSITIONS: constants.ONYX_MAX_ALT_POSITIONS,
      ONYX_BENCH_STOPS: constants.ONYX_BENCH_STOPS,
      ONYX_RECENT_TRADE_LIMIT: constants.ONYX_RECENT_TRADE_LIMIT,
      STARTING_ACCOUNT_BALANCE: constants.STARTING_ACCOUNT_BALANCE,
      MMR: constants.MMR,
      MAX_HEAT: constants.MAX_HEAT,
      WALLET_BASE: constants.WALLET_BASE,
      MARGIN_FRACTION: constants.MARGIN_FRACTION,
      TARGET_LEVERAGE: constants.TARGET_LEVERAGE,
      TAKER_BPS: constants.TAKER_BPS,
      SLIP_BPS: constants.SLIP_BPS,
      FEE_RATE: constants.FEE_RATE,
      SLIP_RATE: constants.SLIP_RATE,
      EXECUTION_INTERVAL_MIN: constants.EXECUTION_INTERVAL_MIN,
      HEALTH_INTERVAL_MIN: constants.HEALTH_INTERVAL_MIN,
      SCAN_UNIVERSE_SIZE: constants.SCAN_UNIVERSE_SIZE,
      INTERVAL_MIN: constants.INTERVAL_MIN,
      FETCH_LIMIT: constants.FETCH_LIMIT,
      MIN_STRUCTURAL_TP_DISTANCE_PCT: constants.MIN_STRUCTURAL_TP_DISTANCE_PCT,
      MIN_TP_TO_STOP_DISTANCE_RATIO: constants.MIN_TP_TO_STOP_DISTANCE_RATIO,
      MAX_LOSS_MARGIN_FRAC: constants.MAX_LOSS_MARGIN_FRAC,
      HUNTER_K_THRESHOLD: constants.HUNTER_K_THRESHOLD,
      HUNTER_RETRACE_WINDOW: constants.HUNTER_RETRACE_WINDOW,
      TREND_FILTER_ENABLED: constants.TREND_FILTER_ENABLED,
      TREND_NEUTRAL_BLOCKS: constants.TREND_NEUTRAL_BLOCKS,
    }).toEqual({
      ONYX_MAX_TOTAL_OPEN: 4,
      ONYX_MAX_ALT_POSITIONS: 4,
      ONYX_BENCH_STOPS: 3,
      ONYX_RECENT_TRADE_LIMIT: 200,
      STARTING_ACCOUNT_BALANCE: 3_600,
      MMR: 0.005,
      MAX_HEAT: 4.0,
      WALLET_BASE: 600,
      MARGIN_FRACTION: 0.10,
      TARGET_LEVERAGE: 100,
      TAKER_BPS: 5,
      SLIP_BPS: 2,
      FEE_RATE: 5 / 10_000,
      SLIP_RATE: 2 / 10_000,
      EXECUTION_INTERVAL_MIN: 15,
      HEALTH_INTERVAL_MIN: 5,
      SCAN_UNIVERSE_SIZE: 4,
      INTERVAL_MIN: 15,
      FETCH_LIMIT: 198,
      MIN_STRUCTURAL_TP_DISTANCE_PCT: 0.0025,
      MIN_TP_TO_STOP_DISTANCE_RATIO: 2.0,
      MAX_LOSS_MARGIN_FRAC: 0.50,
      HUNTER_K_THRESHOLD: 1.3,
      HUNTER_RETRACE_WINDOW: 25,
      TREND_FILTER_ENABLED: true,
      TREND_NEUTRAL_BLOCKS: false,
    });
  });

  it("facade re-exports the same constant identities as ./constants", () => {
    expect(engine.MAX_LOSS_MARGIN_FRAC).toBe(constants.MAX_LOSS_MARGIN_FRAC);
    expect(engine.shouldTriggerMaxLoss).toBe(constants.shouldTriggerMaxLoss);
    expect(engine.STARTING_ACCOUNT_BALANCE).toBe(
      constants.STARTING_ACCOUNT_BALANCE,
    );
  });
});

// ─── No circular dependencies inside src/lib/paper/ ────────────────────────
//
// We only inspect *relative* imports between siblings in this directory. That
// is enough to catch cycles introduced by the Phase 3 split (engine ↔
// constants) and any future extraction — third-party or `@/…` imports cannot
// create a cycle *inside* this directory.

interface ModuleGraph {
  [file: string]: string[];
}

function buildRelativeGraph(dir: string): ModuleGraph {
  const graph: ModuleGraph = {};
  const files = readdirSync(dir).filter(
    (f) => f.endsWith(".ts") && !f.endsWith(".test.ts") && !f.endsWith(".d.ts"),
  );
  const importRe = /from\s+['"](\.\/[^'"]+)['"]/g;
  for (const f of files) {
    const src = readFileSync(join(dir, f), "utf8");
    const deps = new Set<string>();
    let m: RegExpExecArray | null;
    while ((m = importRe.exec(src)) !== null) {
      // Normalize "./foo" or "./foo.ts" → "foo.ts"
      const raw = m[1].replace(/^\.\//, "");
      const withExt = raw.endsWith(".ts") ? raw : `${raw}.ts`;
      if (files.includes(withExt)) deps.add(withExt);
    }
    graph[f] = Array.from(deps);
  }
  return graph;
}

function findCycle(graph: ModuleGraph): string[] | null {
  const WHITE = 0, GRAY = 1, BLACK = 2;
  const color = new Map<string, number>();
  const stack: string[] = [];
  for (const node of Object.keys(graph)) color.set(node, WHITE);

  function dfs(node: string): string[] | null {
    color.set(node, GRAY);
    stack.push(node);
    for (const next of graph[node] ?? []) {
      const c = color.get(next) ?? WHITE;
      if (c === GRAY) {
        const start = stack.indexOf(next);
        return stack.slice(start).concat(next);
      }
      if (c === WHITE) {
        const cyc = dfs(next);
        if (cyc) return cyc;
      }
    }
    stack.pop();
    color.set(node, BLACK);
    return null;
  }

  for (const node of Object.keys(graph)) {
    if ((color.get(node) ?? WHITE) === WHITE) {
      const cyc = dfs(node);
      if (cyc) return cyc;
    }
  }
  return null;
}

describe("paper engine module graph", () => {
  it("has no circular dependencies among sibling modules", () => {
    const graph = buildRelativeGraph(PAPER_DIR);
    const cycle = findCycle(graph);
    expect(cycle, cycle ? `cycle: ${cycle.join(" → ")}` : "no cycle").toBeNull();
  });

  it("engine.ts depends on constants.ts (extraction landed)", () => {
    const graph = buildRelativeGraph(PAPER_DIR);
    expect(graph["engine.ts"]).toContain("constants.ts");
  });

  it("constants.ts only depends on ./parityConstants (shared JSON loader)", () => {
    // parityConstants is a leaf that re-exports shared/mainnet_parity_constants.json
    // for TS/Python parity (DEBT-01). It has no other siblings.
    const graph = buildRelativeGraph(PAPER_DIR);
    for (const dep of graph["constants.ts"] ?? []) {
      expect(["parityConstants.ts"]).toContain(dep);
    }
  });

  it("Phase 4C extractions landed as sibling modules", () => {
    const graph = buildRelativeGraph(PAPER_DIR);
    expect(graph["engine.ts"]).toEqual(
      expect.arrayContaining(["types.ts", "pricing.ts", "telemetry.ts"]),
    );
  });

  it("types.ts only depends on sibling type sources", () => {
    const graph = buildRelativeGraph(PAPER_DIR);
    for (const dep of graph["types.ts"] ?? []) {
      expect(["signal.ts", "regime.ts", "routing.ts"]).toContain(dep);
    }
  });

  it("pricing.ts only depends on ./constants, ./signal (types), and ./bosSignificance", () => {
    const graph = buildRelativeGraph(PAPER_DIR);
    for (const dep of graph["pricing.ts"] ?? []) {
      expect(["constants.ts", "signal.ts", "bosSignificance.ts"]).toContain(dep);
    }
  });


  it("telemetry.ts has no relative sibling imports (pure leaf)", () => {
    const graph = buildRelativeGraph(PAPER_DIR);
    expect(graph["telemetry.ts"]).toEqual([]);
  });
});
