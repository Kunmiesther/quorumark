import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  TONE_DOT,
  TONE_TEXT,
  ageSeconds,
  fmtSignedUsd,
  fmtUsd,
  relTime,
} from "@/components/exchanges/trust/primitives";
import { VENUE_GROUPS } from "@/components/exchanges/trust/ExchangeGroups";

/** Strip comments so prose describing what is absent is not read as a use. */
function code(path: string): string {
  return readFileSync(path, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

const PAGE = code("src/routes/_authenticated/exchanges.tsx");
const HOOK = code("src/hooks/useTrustCenter.ts");
const SAFETY = code("src/components/exchanges/trust/SafetyCenterPanel.tsx");
const GROUPS = code("src/components/exchanges/trust/ExchangeGroups.tsx");
const ACCOUNT = code("src/components/exchanges/trust/AccountHealthPanel.tsx");
const CONNECTION_SHEET = code("src/components/turtle/ExchangeConnectionsSheet.tsx");

describe("money figures are never invented", () => {
  it("renders an em dash, not a zero, for a missing amount", () => {
    // A funded account shown as $0.00 is the single most damaging thing this
    // page could display.
    expect(fmtUsd(null)).toBe("—");
    expect(fmtUsd(undefined)).toBe("—");
    expect(fmtUsd(Number.NaN)).toBe("—");
    expect(fmtUsd(0)).toBe("$0.00");
    expect(fmtUsd(1234.5)).toBe("$1,234.50");
  });

  it("keeps a missing PnL tonally neutral rather than green or red", () => {
    expect(fmtSignedUsd(null)).toEqual({ text: "—", tone: "unknown" });
    expect(fmtSignedUsd(12).tone).toBe("ok");
    expect(fmtSignedUsd(-12).tone).toBe("down");
    expect(fmtSignedUsd(0).tone).toBe("idle");
  });

  it("never floors a missing MONEY figure to zero", () => {
    // Counts may legitimately default to 0 — "0 wallets linked" is true.
    // Currency may not: a funded account rendered as $0.00 is a lie.
    for (const field of ["Usd", "Balance", "Equity", "Margin", "Pnl", "margin", "equity"]) {
      const pattern = new RegExp(`${field}[A-Za-z]*\\s*[:=][^;,\\n]*\\?\\?\\s*0\\b`);
      expect(PAGE).not.toMatch(pattern);
      expect(ACCOUNT).not.toMatch(pattern);
      expect(HOOK).not.toMatch(pattern);
    }
  });
});

describe("realised figures", () => {
  it("reads PnL and fees from the LIVE book only", () => {
    // Paper results on a page about real money would be the worst possible
    // category error.
    expect(HOOK).toContain('.eq("book", "live")');
    expect(HOOK).toContain("realized_pnl");
    expect(HOOK).toContain("fees_usd");
  });

  it("stays null when the trades read fails, rather than reporting zero", () => {
    // "$0.00 closed PnL" on a losing account is a lie; "—" is not.
    expect(HOOK).toContain("tradesFailed");
    expect(HOOK).toMatch(/tradesFailed\s*\?\s*\{\s*closedPnl: null/);
  });

  it("reports daily loss as a positive figure against the limit", () => {
    // A profitable day is 0 loss, not a negative one that would render as a
    // green number under a "Daily loss" label.
    expect(PAGE).toContain("Math.max(0, -trust.todayRealisedUsd)");
    expect(PAGE).toMatch(/todayRealisedUsd === null \? null/);
  });
});

describe("live execution evidence", () => {
  it("reads the real mainnet order-intent ledger", () => {
    expect(HOOK).toContain('.from("order_intents")');
    expect(HOOK).toContain('.eq("environment", "mainnet")');
    expect(HOOK).not.toContain("intents: []");
  });

  it("checks broker and signer readiness independently of the market worker", () => {
    expect(HOOK).toContain("getExecutionRuntimeHealth");
    expect(HOOK).toContain('name: "Automation worker"');
    expect(HOOK).toContain('name: "Live order broker"');
  });
});

describe("freshness", () => {
  it("says 'never' rather than guessing when there is no timestamp", () => {
    expect(relTime(null)).toBe("never");
    expect(relTime("not-a-date")).toBe("never");
    expect(ageSeconds(null)).toBeNull();
  });

  it("formats recent ages in seconds", () => {
    expect(relTime(new Date(Date.now() - 5_000).toISOString())).toMatch(/^\ds ago$/);
  });
});

describe("tone contract", () => {
  it("has a distinct treatment for idle and unknown, never green", () => {
    // Collapsing "nothing to report" into ok is how a broken system looks
    // fine; collapsing it into down is how a quiet one looks broken.
    expect(TONE_DOT.idle).not.toBe(TONE_DOT.ok);
    expect(TONE_DOT.unknown).not.toBe(TONE_DOT.ok);
    expect(TONE_DOT.idle).not.toBe(TONE_DOT.down);
    expect(TONE_TEXT.unknown).not.toBe(TONE_TEXT.ok);
  });
});

describe("subsystem honesty", () => {
  it("distinguishes active standby, not asked, and unavailable AI states", () => {
    expect(HOOK).toContain('state: "Enabled"');
    expect(HOOK).toContain('state: "Not asked"');
    expect(HOOK).toContain('state: "Unavailable"');
    expect(HOOK).toContain("cycleIsFresh");
  });

  it("keeps the advisory AI out of the overall verdict", () => {
    // The committee cannot stop a trade, so it must not be able to turn the
    // page red and imply that it did.
    expect(HOOK).toMatch(/filter\(\(s\) => s\.key !== "ai"\)/);
  });

  it("never claims a subsystem is ok without a fresh record", () => {
    expect(HOOK).toContain("MARKET_DATA_STALE_SEC");
    expect(HOOK).toMatch(/state: "Stale"/);
  });

  it("pairs a waiting reason with a recommended action", () => {
    expect(HOOK).toContain("recommendedAction");
    // Every waiting branch sets one.
    const waitingBranches = HOOK.match(/waiting: true/g) ?? [];
    const actions = HOOK.match(/recommendedAction:\s*\n?\s*["`]/g) ?? [];
    expect(actions.length).toBeGreaterThanOrEqual(waitingBranches.length);
  });
});

describe("safety controls tell the truth about what they can do", () => {
  it("never wires a close-positions or cancel-orders path", () => {
    // The broker exposes these; this app has no client route to them, and
    // inventing one here would be an unreviewed path that moves real money.
    expect(SAFETY).not.toMatch(/CLOSE_ALL_POSITIONS|CANCEL_ALL_ORDERS/);
    expect(SAFETY).not.toMatch(/functions\.invoke/);
    expect(SAFETY).toContain('label="Close all positions"');
    expect(SAFETY).toContain('label="Cancel open orders"');
  });

  it("gives every disabled control a stated reason", () => {
    const disabled = SAFETY.match(/disabled\b(?!Reason)/g) ?? [];
    const reasons = SAFETY.match(/disabledReason/g) ?? [];
    expect(reasons.length).toBeGreaterThanOrEqual(3);
    expect(disabled.length).toBeGreaterThan(0);
  });

  it("emergency stop only pauses — it never closes or cancels", () => {
    expect(SAFETY).toContain("is_live: false");
    expect(SAFETY).not.toMatch(/\.delete\(\)/);
    expect(SAFETY).not.toMatch(/close|cancel/i.source ? /closePosition|cancelOrder/ : /$^/);
  });

  it("reports a partial outcome instead of overstating success", () => {
    expect(SAFETY).toContain("killSwitchRecorded");
    expect(SAFETY).toContain("Kill switch not recorded");
  });
});

describe("connections", () => {
  it("groups the owner-specified DEX and CEX venues", () => {
    expect(VENUE_GROUPS).toEqual([
      { kind: "DEX", venues: ["apex_omni", "aster", "synfutures"] },
      { kind: "CEX", venues: ["coinbase", "kraken"] },
    ]);
  });

  it("reuses the existing connection actions rather than new endpoints", () => {
    expect(GROUPS).toContain('action: "test"');
    expect(GROUPS).toContain('action: "disconnect"');
    expect(GROUPS).toContain("is_live");
    // No new edge function is introduced by this page.
    const invocations = new Set(GROUPS.match(/functions\.invoke\("([\w-]+)"/g) ?? []);
    expect([...invocations]).toEqual(['functions.invoke("exchange-credentials"']);
  });

  it("shows unconnected venues as a fact instead of hiding them", () => {
    expect(GROUPS).toContain("Not connected");
    expect(GROUPS).toContain("UnconnectedVenue");
  });
});

describe("secrets", () => {
  it("never collects or renders a seed phrase or private key", () => {
    // Stating the guarantee in copy is fine and desirable. Reading one from
    // the user, or binding one to a value, is not.
    for (const src of [PAGE, HOOK, SAFETY, GROUPS, ACCOUNT]) {
      expect(src).not.toMatch(/<input/i);
      expect(src).not.toMatch(/(seed|mnemonic|privateKey|private_key)\s*[:=]/i);
      expect(src).not.toMatch(/type="password"/i);
    }
  });

  it("states the guarantee in the page copy", () => {
    expect(PAGE).toMatch(/Seed phrases and owner-wallet private keys are never requested/);
  });

  it("enables Aster with its dedicated agent credential mapping", () => {
    expect(CONNECTION_SHEET).toContain('id: "aster"');
    expect(CONNECTION_SHEET).toMatch(/id: "aster"[^\n]+requiresPassphrase: true[^\n]+available: true/);
    expect(CONNECTION_SHEET).toContain("Master wallet address");
    expect(CONNECTION_SHEET).toContain("Agent signing key");
    expect(CONNECTION_SHEET).toContain("Agent wallet address");
    expect(CONNECTION_SHEET).toContain("https://www.asterdex.com/en/api-wallet");
    expect(CONNECTION_SHEET).toContain("Never enter your owner-wallet private key");
  });
});

describe("preserved functionality", () => {
  it("keeps every control the previous Exchange page had", () => {
    for (const kept of [
      "ExchangeConnectionsSheet",
      "AddWalletModal",
      "WalletsSection",
      "ApexActivateSigning",
      "ApexFundingCard",
      "LiveTradingToggle",
      "ProofOfLifeButton",
    ]) {
      expect(PAGE).toContain(kept);
    }
  });

  it("keeps the same connections query key so other surfaces still work", () => {
    expect(PAGE).toContain('"exchange-connections-full"');
    expect(PAGE).toContain("apex_execution_credentials_status");
  });

  it("is still the same route, not a new page", () => {
    expect(PAGE).toContain('createFileRoute("/_authenticated/exchanges")');
  });
});

describe("responsive", () => {
  it("has a mobile column and a desktop split, and no fixed-width overflow", () => {
    expect(PAGE).toContain("lg:hidden");
    expect(PAGE).toContain("hidden lg:block");
    // Horizontal scrolling is the failure mode this page must not have.
    expect(PAGE).not.toMatch(/overflow-x-(auto|scroll)/);
    // `max-w-[...]` is the correct responsive tool and is expected. A fixed
    // `w-[...]` at container scale is what forces a phone to scroll sideways.
    expect(PAGE).not.toMatch(/(?<!max-)\bw-\[\d{3,}px\]/);
    expect(PAGE).toMatch(/max-w-\[\d+px\]/);
  });

  it("stacks status metrics rather than forcing a wide row on phones", () => {
    const monitor = code("src/components/exchanges/trust/TrustMonitorPanel.tsx");
    expect(monitor).toMatch(/grid-cols-2[^"]*sm:grid-cols-3/);
    expect(SAFETY).toMatch(/grid-cols-2[^"]*sm:grid-cols-4/);
    expect(SAFETY).toMatch(/grid-cols-1[^"]*sm:grid-cols-2/);
  });
});
