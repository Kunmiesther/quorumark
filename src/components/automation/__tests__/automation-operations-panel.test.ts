import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const source = fs.readFileSync(path.resolve(__dirname, "../AutomationOperationsPanel.tsx"), "utf8");
const pageSource = fs.readFileSync(
  path.resolve(__dirname, "../../../routes/_authenticated/automation.tsx"),
  "utf8",
);

describe("Automation operations monitor contract", () => {
  it("uses persisted runtime, Council, strategy, and event sources", () => {
    expect(source).toContain("useExecutionStatus");
    expect(source).toContain("useBotHealth");
    expect(source).toContain("useShortlistCycle");
    expect(source).toContain("useBotEvents");
    expect(source).toContain('.from("user_strategy")');
  });

  it("does not expose an execution mutation", () => {
    expect(source).not.toContain("submitManualLiveTestOrder");
    expect(source).not.toContain("place-order");
    expect(source).not.toContain("automation-order");
  });

  it("labels the AI Council as advisory", () => {
    expect(source).toMatch(/Advisory evidence only/);
  });

  it("serializes nested persisted event evidence instead of showing object coercion", () => {
    expect(source).toContain("JSON.stringify(value)");
    expect(source).not.toContain("`${key}: ${String(value)}`");
  });

  it("gives the owner explicit paper, live, and pause controls without submitting an order", () => {
    expect(source).toContain('eq("role", "admin")');
    expect(source).toContain('const LIVE_CONFIRMATION = "ARM LIVE AUTOMATION"');
    expect(source).toMatch(/mode:\s*"live",\s*enabled:\s*true/);
    expect(source).toContain('event: "OWNER_AUTOMATION_MODE_PAUSED"');
    expect(source).toContain('.eq("mode", mode)');
    expect(source).toContain("OWNER_LIVE_AUTOMATION_ARMED");
    expect(source).toContain("!execution.canArmLiveAutomation");
    expect(source).toContain("execution.canArmLiveAutomation");
    expect(source).not.toContain("submitManualLiveTestOrder");
    expect(source).not.toContain("place-order");
  });

  it("requires venue-valid leverage and protects newer settings when arming", () => {
    expect(source).toContain("validLiveLeverage(leverage ?? NaN");
    expect(source).toContain("params: { ...objectParam(row.params), leverage }");
    expect(source).toContain('.eq("enabled", row.enabled)');
    expect(source).toContain("JSON.stringify(row.params)");
    expect(source).toContain("Configuration changed. Refresh and review the strategy again.");
  });

  it("opens in Live and keeps the operations evidence synchronized with the page view", () => {
    expect(pageSource).toContain('useState<"live" | "paper">("live")');
    expect(pageSource).toContain('aria-label="Autopilot operating view"');
    expect(pageSource).toContain("<AutomationOperationsPanel book={book} />");
    expect(pageSource).toContain("<AutomationMandates />");
    expect(pageSource).toContain("<LiveReviewDesk />");
    expect(pageSource).toContain("<SuiteSelectCard embedded setupBook={book} />");
    expect(pageSource).toContain("<AutopilotOnyxChat onOpenBuilder={openBuilder} />");
    expect(pageSource).toContain("<AutomationObservatory book={book} />");
    expect(source).toContain("const cycle = useShortlistCycle(book)");
    expect(source).toContain("eventBook(event) === book");
    expect(source).not.toContain('useState<Book>("paper")');
    expect(source).toContain("row.mode === book");
    expect(pageSource).toContain("<AutomationIncomePanel book={book} />");
  });

  it("makes a view switch read-only and preserves the separate owner arming confirmation", () => {
    expect(pageSource).toContain("Switching views does not change any strategy's execution mode.");
    expect(source).toContain('const LIVE_CONFIRMATION = "ARM LIVE AUTOMATION"');
    expect(source).toContain("Viewing this page does not enable trading");
    expect(source).toContain(
      'book === "live" ? "Live automation status" : "Paper automation status"',
    );
  });

  it("shows authoritative automation state and filters persisted evidence by book", () => {
    expect(source).toContain("Automation off — no strategy configured");
    expect(source).toContain("${execution.runtimeReason} No live strategy rows are armed");
    expect(source).toContain("Process health only");
    expect(source).toContain("eventBook(event) === book");
    expect(source).toContain("No persisted {book} events yet.");
  });

  it("makes saved simulation rows visibly reviewable from the empty Live view", () => {
    expect(source).toContain("Ready for Live review");
    expect(source).toContain("Review & arm");
    expect(source).toContain("arming requires the owner confirmation phrase");
    expect(source).toContain("hasVerifiedLiveRoute");
    expect(source).toContain("Route not ready");
    expect(source).toContain("savedCount={savedTurtleCount}");
  });

  it("counts distinct configured trading Turtles and prevents Scout execution controls", () => {
    expect(source).toContain('row.strategies?.slug !== "ema-cross"');
    expect(source).toContain("distinctStrategyCount");
    expect(source).toContain("active trading Turtles");
    expect(source).toContain("distinctStrategyCount(rowsInView)");
    expect(source).toContain("Scout recon only");
  });
});
