/**
 * Onyx execution-commander decision layer.
 *
 * Called by the paper engine AFTER Phase A (candidate collection) and
 * BEFORE Phase C (execute). Applies hard guardrails first, then asks
 * GPT-5.5 to rank + pick which candidates to actually deploy given
 * free-wallet capacity. Falls back to deterministic guardrail-ranked
 * deploys if the AI call fails / is rate-limited / times out.
 *
 * NEVER touches Supabase, the signer, or the broker. Pure decision logic.
 */

import type { Direction, TrendState } from "@/lib/paper/signal";
import { glmGenerationOptions, type GlmTransport } from "@/lib/ai/glmTransport.server";
import type { Regime } from "@/lib/paper/regime";
import type { StrategyLeg } from "@/lib/paper/routing";

const ANCHORS = new Set(["BTC", "ETH"]);
const TOGETHER_AI_URL = "https://api.together.xyz/v1/chat/completions";
const MODEL = "zai-org/GLM-5.3-Flash";

/** Everything the engine needs to actually open the position in Phase C.
 * Built in Phase A per-leg; passed opaquely through the decision layer. */
export interface OnyxCandidate {
  key: string;                 // "SYMBOL:dir:leg" unique in a tick
  symbol: string;
  base: string;                // e.g. "BTC"
  direction: Direction;
  leg: "accumulator" | "sniper" | "sweep" | "hunter" | "dca" | "scout" | "vanguard" | "arbiter";
  regime: Regime | null;
  walletKey: string;

  // Sizing + prices already computed by the leg-specific detector.
  entryRawPx: number;
  fillPx: number;
  stopLevel: number;
  tpLevel: number;
  zoneUpper: number;
  zoneLower: number;
  zoneLevel: number;
  qty: number;
  notional: number;
  margin: number;
  leverage: number;
  entryFee: number;
  entryCandleTs: number;
  openedFromSignal: string;

  // Context for AI reasoning (advisory, not required for exec).
  trendState: TrendState | null;
  trendSlopePct: number | null;
  /** Higher = better for deterministic ranking. In practice the engine
   *  passes the TP:stop distance ratio (already validated by the leg). */
  movementScore: number;
}

/** A snapshot of an OPEN paper position handed to Onyx for open-book
 *  management. Onyx returns HOLD or CLOSE per position. */
export interface OnyxOpenPosition {
  walletKey: string;
  positionId: string;
  symbol: string;
  base: string;
  direction: Direction;
  strategy: "accumulator" | "sniper" | "sweep" | "hunter" | "dca" | "scout";
  entryPx: number;
  worstPx: number;          // used as the exit price if we CLOSE this tick
  markPx: number;
  qty: number;
  margin: number;
  pnlPctOfMargin: number;   // signed; negative = losing; NET of modeled fees/slippage
  ageMinutes: number;
  regime: Regime | null;
  trendState: TrendState | null;
  trendSlopePct: number | null;
  /** SCOUT DEFENSIVE LAYER — true when a confirmed 5m close broke the
   *  position's protective swing. Onyx MUST close these. */
  structureBroken?: boolean;
  brokenLevel?: number | null;
  // ─── Persisted DCA rung context. New campaigns use five rungs and
  //     wallet-compounded margin; historical campaigns retain their frozen data.
  //     Passed to Onyx purely for CONTEXT/explanation. It does NOT itself
  //     grant close authority — `validateAiClose` enforces the policy.
  filledRungCount?: number;
  pendingRungCount?: number;
  totalPlannedRungs?: number;
  perRungMargin?: number;
  totalPlannedMargin?: number;
  deepestRungPrice?: number;   // hard-stop anchor
  /**
   * Armed strategy hard stop. `null` while the ladder is not fully filled —
   * DO NOT interpret null as "no protection" or as permission to close;
   * cross-margin liquidation, kill switch, and Scout BOS still cover the
   * position.
   */
  hardStopLevel?: number | null;
  nextRungPrice?: number | null;
}

export interface RecentTradeLite {
  walletKey: string;
  exitReason: string; // "stop" | "tp_touch" | ...
  closedAt: string;   // ISO
}

export interface FleetSnapshot {
  walletCount: number;
  openCount: number;
  altOpenCount: number;
  freeWalletCount: number;
  benchedWallets: string[];
  maxTotalOpen: number;
  maxAltPositions: number;
  benchConsecutiveStops: number;
}

export type RejectionReason =
  | "benched_wallet"
  | "correlated_over_exposure"
  | "onyx_capacity"
  | "onyx_held"
  | "onyx_skipped";

/** Every close reason ever surfaced by Onyx to the engine. `bank_profit`
 *  is only ever produced when `validateAiClose` explicitly approves it. */
export type OnyxCloseReason = "scout_bos" | "bank_profit";

export interface OnyxClose {
  position: OnyxOpenPosition;
  reason: OnyxCloseReason;
  rationale: string;
}

/** Sanitized log entry for every AI-requested close that was REJECTED by
 *  the deterministic validator. Written to telemetry by the engine. */
export interface RejectedAiClose {
  positionId: string;
  walletKey: string;
  symbol: string;
  reason: "pending_rungs_active" | "not_profitable_enough" | "unknown_position" | "invalid_payload";
  detail: string;   // sanitized — no raw AI text, no secrets
  requestedRationale: string;   // truncated
}

export interface Decision {
  approved: Array<OnyxCandidate & { rationale: string; priority: number }>;
  rejected: Array<{ candidate: OnyxCandidate; reason: RejectionReason }>;
  closes: OnyxClose[];
  /** AI-requested closes that failed the deterministic gate. Never executed. */
  rejectedCloses: RejectedAiClose[];
  aiCalled: boolean;
  aiError: string | null;
  usedFallback: boolean;
  narrative: string;
  /** Set when the AI call was skipped entirely for cost control. */
  skipReason: "no_candidates" | "no_capacity" | "no_api_key" | "no_work" | null;
}

// ─── DETERMINISTIC CLOSE VALIDATOR ────────────────────────────────────────
import { ONYX_BANK_PROFIT_MARGIN_ROI_PCT, ONYX_AI_ENABLED, isEightRungSymbol } from "@/lib/paper/constants";

/**
 * The ONLY predicate that authorizes a discretionary Onyx close.
 *
 * Two policy layers:
 *   (1) GENERAL SAFETY (all symbols, byte-for-byte historical): a losing
 *       full-ladder position with no scout_bos signal is `not_profitable_enough`;
 *       a position at or past +30 % net margin ROI is `bank_profit`.
 *   (2) BTC/ETH 100× 8-RUNG PROHIBITION (canonical allowlist only): a DCA
 *       position on BTC-USDT or ETH-USDT with pending rungs may NEVER be
 *       discretionarily cut. This layer does NOT apply to LINK-USDT,
 *       SOL-USDT, XRP-USDT, DOGE-USDT, AVAX-USDT or any other symbol —
 *       their pre-existing close policy is preserved verbatim.
 *
 * Mechanical exits (per-lot TP, hard stop past deepest rung, scout_bos,
 * account-wide liquidation, kill switch) bypass this — they are surfaced
 * by the engine itself, not by AI discretion.
 */
export function validateAiClose(
  pos: OnyxOpenPosition,
): { allowed: true; reason: OnyxCloseReason; detail: string }
  | { allowed: false; reason: RejectedAiClose["reason"]; detail: string } {
  const filled = pos.filledRungCount ?? 1;
  const pending = pos.pendingRungCount ?? 0;
  const total = pos.totalPlannedRungs ?? (filled + pending);
  // (a) profitable-above-threshold path — always OK, even mid-ladder, for
  //     every symbol. Same rule for BTC/ETH and every alt.
  if (pos.pnlPctOfMargin >= ONYX_BANK_PROFIT_MARGIN_ROI_PCT) {
    return {
      allowed: true,
      reason: "bank_profit",
      detail: `bank_profit: net roi ${pos.pnlPctOfMargin.toFixed(1)}% ≥ ${ONYX_BANK_PROFIT_MARGIN_ROI_PCT}%`,
    };
  }
  // (b) Legacy canonical forced-leverage symbol only: mid-ladder is
  //     untouchable. The exported allowlist helper keeps its historical name.
  if (pending > 0 && isEightRungSymbol(pos.symbol)) {
    return {
      allowed: false,
      reason: "pending_rungs_active",
      detail: `held (canonical ladder): ${filled}/${total} rungs filled, ${pending} pending — mid-ladder DCA is never cut discretionarily`,
    };
  }
  // (c) ladder fully deployed (or non-canonical symbol) and losing → still
  //     requires thesis-invalidated, which is a Scout signal (scout_bos).
  //     Without that signal, the ONLY way out is bank profit above threshold
  //     (handled above). Reject.
  return {
    allowed: false,
    reason: "not_profitable_enough",
    detail: `held: net roi ${pos.pnlPctOfMargin.toFixed(1)}% < ${ONYX_BANK_PROFIT_MARGIN_ROI_PCT}% and no scout_bos signal`,
  };
}



/** Count consecutive stops at the head of most-recent-first trades per wallet.
 *  `trades` MUST already be sorted by closed_at DESC. */
export function computeBenchedWallets(
  trades: RecentTradeLite[],
  threshold: number,
): string[] {
  const byWallet = new Map<string, string[]>();
  for (const t of trades) {
    const arr = byWallet.get(t.walletKey);
    if (arr) arr.push(t.exitReason);
    else byWallet.set(t.walletKey, [t.exitReason]);
  }
  const out: string[] = [];
  for (const [wk, arr] of byWallet) {
    let n = 0;
    for (const r of arr) {
      if (r === "stop") n++;
      else break;
    }
    if (n >= threshold) out.push(wk);
  }
  return out.sort();
}

export async function decideOnyxForCandidates(
  candidates: OnyxCandidate[],
  fleet: FleetSnapshot,
  apiKey: string | null,
  fetchImpl: typeof fetch = fetch,
  openPositions: OnyxOpenPosition[] = [],
  glm?: GlmTransport,
): Promise<Decision> {
  const rejected: Decision["rejected"] = [];
  const benched = new Set(fleet.benchedWallets);
  const survivors: OnyxCandidate[] = [];
  for (const c of candidates) {
    if (benched.has(c.walletKey)) {
      rejected.push({ candidate: c, reason: "benched_wallet" });
      continue;
    }
    survivors.push(c);
  }
  survivors.sort((a, b) => b.movementScore - a.movementScore);

  const capacity = Math.min(
    Math.max(0, fleet.maxTotalOpen - fleet.openCount),
    fleet.freeWalletCount,
  );
  const altCapacityLeft = Math.max(0, fleet.maxAltPositions - fleet.altOpenCount);

  // GUARDIAN v2 — the Railway worker is the SOLE BOS-close authority. The
  // engine no longer converts an internal `structure_broken=true` stamp into
  // a `scout_bos` close. The stamp + SCOUT_BOS / SCOUT_BOS_REJECTED events
  // are retained upstream purely as telemetry. A BOS-driven close now
  // requires a `scout_guardian_directives` row from the worker, which the
  // engine consumes on its next tick.
  const scoutBosCloses: OnyxClose[] = [];
  const scoutBosPositionIds = new Set<string>();

  // Discretionary / counter-trend closes are DISABLED — a red position with
  // no BOS is HELD. The only automatic Onyx-surfaced exit is Scout BOS,
  // plus any AI-requested close that passes `validateAiClose` (bank profit).
  // Cost gating: only call the AI when there is real deploy work. Review work
  // no longer justifies an AI call because Onyx cannot close positions.
  const hasDeployWork = survivors.length > 0 && capacity > 0;
  // Open positions must be reviewed — the AI may request a bank_profit close
  // which `validateAiClose` will admit only when net-profitable past the
  // threshold. Every other request is rejected + logged, so mid-ladder DCA
  // stays intact.
  const hasReviewWork = openPositions.length > 0;
  const allCloses = [...scoutBosCloses];
  const rejectedClosesEmpty: RejectedAiClose[] = [];

  const pickDeterministic = (label: string): Decision["approved"] => {
    const approved: Decision["approved"] = [];
    let altLeft = altCapacityLeft;
    let capLeft = capacity;
    for (const c of survivors) {
      if (capLeft <= 0) {
        rejected.push({ candidate: c, reason: "onyx_capacity" });
        continue;
      }
      if (!ANCHORS.has(c.base) && altLeft <= 0) {
        rejected.push({ candidate: c, reason: "correlated_over_exposure" });
        continue;
      }
      approved.push({
        ...c,
        rationale: `${label}: rank ${approved.length + 1} by movement score ${Math.round(c.movementScore)}`,
        priority: approved.length + 1,
      });
      capLeft--;
      if (!ANCHORS.has(c.base)) altLeft--;
    }
    return approved;
  };

  if (!hasDeployWork && !hasReviewWork) {
    // Nothing to do beyond deterministic closes (which is possibly nothing).
    if (survivors.length > 0 && capacity <= 0) {
      for (const c of survivors) rejected.push({ candidate: c, reason: "onyx_capacity" });
      return {
        approved: [], rejected, closes: allCloses, rejectedCloses: rejectedClosesEmpty,
        aiCalled: false, aiError: null, usedFallback: false,
        narrative: "", skipReason: "no_capacity",
      };
    }
    return {
      approved: [], rejected, closes: allCloses, rejectedCloses: rejectedClosesEmpty,
      aiCalled: false, aiError: null, usedFallback: false,
      narrative: "", skipReason: "no_candidates",
    };
  }

  if (!ONYX_AI_ENABLED || !apiKey) {
    return {
      approved: pickDeterministic("deterministic"),
      rejected, closes: allCloses, rejectedCloses: rejectedClosesEmpty,
      aiCalled: false, aiError: null, usedFallback: false,
      narrative: ONYX_AI_ENABLED
        ? "AI key unavailable; deterministic guardrail deploy."
        : "Deterministic guardrail deploy (ONYX_AI_ENABLED=false).",
      skipReason: ONYX_AI_ENABLED ? "no_api_key" : null,
    };
  }


  try {
    const system =
      "You are ONYX, TurtleBot's paper-execution commander running a cross-margin " +
      "DCA book. Each cycle you RANK and PICK which pre-guardrailed candidates " +
      "to DEPLOY given free-wallet capacity + alt-cap. " +
      "\n\nOPEN POSITIONS: mid-ladder DCA is NEVER cut discretionarily. A DCA " +
      "position with ANY pending rung is HELD — a red mid-ladder position is " +
      "the whole point of the DCA. You MAY only request a close when the " +
      "position is net-profitable past the bank-profit threshold; every other " +
      "request will be REJECTED by the deterministic validator, logged, and " +
      "ignored. Mechanical exits (per-rung +1% take-profit, Scout Break of " +
      "Structure, hard stop past the deepest rung, cross liquidation) are " +
      "handled by the engine, not you. Output STRICT JSON only.";
    const user = {
      capacity, alt_capacity_left: altCapacityLeft,
      fleet: {
        wallets_total: fleet.walletCount,
        wallets_free: fleet.freeWalletCount,
        open_positions: fleet.openCount,
        alt_open: fleet.altOpenCount,
        benched: fleet.benchedWallets,
      },
      candidates: survivors.slice(0, 20).map((c) => ({
        key: c.key, symbol: c.symbol, base: c.base, direction: c.direction,
        leg: c.leg, regime: c.regime, wallet: c.walletKey,
        entry: Number(c.fillPx.toFixed(6)),
        stop: Number(c.stopLevel.toFixed(6)),
        tp: Number(c.tpLevel.toFixed(6)),
        trend: c.trendState,
        movement: Math.round(c.movementScore),
      })),
      open_positions: openPositions.slice(0, 20).map((p) => ({
        position_id: p.positionId,
        wallet: p.walletKey,
        symbol: p.symbol,
        direction: p.direction,
        strategy: p.strategy,
        pnl_roi_pct: Number(p.pnlPctOfMargin.toFixed(2)),
        filled_rungs: p.filledRungCount ?? 1,
        pending_rungs: p.pendingRungCount ?? 0,
        total_rungs: p.totalPlannedRungs ?? ((p.filledRungCount ?? 1) + (p.pendingRungCount ?? 0)),
        per_rung_margin: p.perRungMargin ?? null,
        total_planned_margin: p.totalPlannedMargin ?? null,
        deepest_rung: p.deepestRungPrice ?? null,
        hard_stop: p.hardStopLevel ?? null,
        next_rung: p.nextRungPrice ?? null,
        mark: Number(p.markPx.toFixed(6)),
        structure_broken: Boolean(p.structureBroken),
      })),
      output_schema: {
        deploys: [{ key: "candidate key from candidates", priority: 1, rationale: "one sentence" }],
        closes: [{ position_id: "open position id (only if net-profitable past threshold)", rationale: "one sentence" }],
        narrative: "2-3 sentence commander summary",
      },
      rules: [
        `Deploy AT MOST ${capacity} candidates.`,
        `Do not exceed ${altCapacityLeft} non-BTC/ETH deploys.`,
        "Only reference keys from candidates.",
        "A closes[] entry for a DCA position with any pending rung will be REJECTED.",
        `A closes[] entry for a position with pnl_roi_pct < ${ONYX_BANK_PROFIT_MARGIN_ROI_PCT} will be REJECTED.`,
        "Return valid JSON matching output_schema; no markdown fences.",
      ],
    };


    const res = await fetchImpl(glm?.url ?? TOGETHER_AI_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: glm?.model ?? MODEL,
        ...(glm ? glmGenerationOptions(glm, 1200) : { max_tokens: 1200 }),
        messages: [
          { role: "system", content: system },
          { role: "user", content: JSON.stringify(user) },
        ],
        response_format: { type: "json_object" },
      }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      return {
        approved: pickDeterministic("fallback"),
        rejected, closes: allCloses, rejectedCloses: rejectedClosesEmpty,
        aiCalled: true,
        aiError: `AI ${res.status}: ${text.slice(0, 160)}`,
        usedFallback: true,
        narrative: "AI unavailable; deterministic guardrail deploy.",
        skipReason: null,
      };
    }
    const body = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const raw = body.choices?.[0]?.message?.content ?? "";
    let parsed: {
      deploys?: Array<{ key?: string; priority?: number; rationale?: string }>;
      closes?: Array<{ position_id?: string; rationale?: string }>;
      narrative?: string;
    } = {};
    try { parsed = JSON.parse(raw); } catch {
      return {
        approved: pickDeterministic("fallback"),
        rejected, closes: allCloses, rejectedCloses: rejectedClosesEmpty,
        aiCalled: true, aiError: "AI returned non-JSON", usedFallback: true,
        narrative: "Malformed AI response; deterministic deploy.",
        skipReason: null,
      };
    }
    const bySurvivorKey = new Map(survivors.map((s) => [s.key, s] as const));
    const approved: Decision["approved"] = [];
    let altLeft = altCapacityLeft;
    let capLeft = capacity;
    const seen = new Set<string>();
    const deploys = (parsed.deploys ?? []).slice().sort(
      (a, b) => Number(a.priority ?? 999) - Number(b.priority ?? 999),
    );
    for (const d of deploys) {
      const key = String(d.key ?? "");
      if (!key || seen.has(key)) continue;
      const cand = bySurvivorKey.get(key);
      if (!cand) continue;
      if (capLeft <= 0) break;
      if (!ANCHORS.has(cand.base) && altLeft <= 0) {
        rejected.push({ candidate: cand, reason: "correlated_over_exposure" });
        seen.add(key);
        continue;
      }
      seen.add(key);
      approved.push({
        ...cand,
        rationale: (String(d.rationale ?? "").slice(0, 400)) || "onyx deploy",
        priority: approved.length + 1,
      });
      capLeft--;
      if (!ANCHORS.has(cand.base)) altLeft--;
    }
    for (const c of survivors) {
      if (!seen.has(c.key)) rejected.push({ candidate: c, reason: "onyx_held" });
    }

    // ── DETERMINISTIC AI-CLOSE VALIDATION ───────────────────────────────
    // Any close the AI requested is run through `validateAiClose`. Rejected
    // requests are logged (sanitized) and the position is left intact —
    // the engine never sees them and no ONYX CUT UI is emitted. The scout
    // BOS force-closes are appended AFTER, deduped by position_id, and
    // always take precedence over any AI-requested close for the same pos.
    const aiCloses: OnyxClose[] = [];
    const rejectedCloses: RejectedAiClose[] = [];
    const byPosId = new Map(openPositions.map((p) => [p.positionId, p] as const));
    for (const c of (parsed.closes ?? [])) {
      const pid = String(c?.position_id ?? "");
      const rationale = String(c?.rationale ?? "").slice(0, 200);
      if (!pid) {
        rejectedCloses.push({
          positionId: "", walletKey: "", symbol: "",
          reason: "invalid_payload", detail: "missing position_id",
          requestedRationale: rationale,
        });
        continue;
      }
      const pos = byPosId.get(pid);
      if (!pos) {
        rejectedCloses.push({
          positionId: pid, walletKey: "", symbol: "",
          reason: "unknown_position",
          detail: "position not in open snapshot",
          requestedRationale: rationale,
        });
        continue;
      }
      // Scout BOS wins over any AI close for the same position — skip; the
      // scout_bos entry is already in allCloses / will be appended below.
      if (scoutBosPositionIds.has(pid)) continue;
      const v = validateAiClose(pos);
      if (!v.allowed) {
        rejectedCloses.push({
          positionId: pid, walletKey: pos.walletKey, symbol: pos.symbol,
          reason: v.reason, detail: v.detail, requestedRationale: rationale,
        });
        continue;
      }
      aiCloses.push({ position: pos, reason: v.reason, rationale: rationale || v.detail });
    }

    const closes = [...scoutBosCloses, ...aiCloses];

    return {
      approved, rejected, closes, rejectedCloses,
      aiCalled: true, aiError: null, usedFallback: false,
      narrative: String(parsed.narrative ?? "").slice(0, 600),
      skipReason: null,
    };
  } catch (e) {
    return {
      approved: pickDeterministic("fallback"),
      rejected, closes: allCloses, rejectedCloses: rejectedClosesEmpty,
      aiCalled: true, aiError: (e as Error).message, usedFallback: true,
      narrative: "AI threw; deterministic deploy.",
      skipReason: null,
    };
  }
}


// Re-exports for engine convenience.
export type { StrategyLeg };
