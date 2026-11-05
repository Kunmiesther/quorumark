import { describe, it, expect, afterEach } from "vitest";
import "@testing-library/jest-dom/vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { DualPositionCard, type SidePosition } from "@/components/turtle/DualPositionCard";

const flat: SidePosition = { active: false };
const active: SidePosition = {
  active: true,
  entryPrice: 100,
  currentPrice: 110,
  pnlUsd: 10,
  pnlPercent: 10,
  leverage: "100x",
};

afterEach(() => cleanup());

describe("DualPositionCard subtraction", () => {
  it("renders ONE compact line when both sides are flat (no giant empty panels)", () => {
    render(
      <DualPositionCard
        book="live"
        data={{ symbol: "BTC-USDT", longPosition: flat, shortPosition: flat }}
      />,
    );
    expect(screen.getByTestId("dual-position-flat")).toBeInTheDocument();
    expect(screen.queryByTestId("dual-position-active")).not.toBeInTheDocument();
    expect(screen.getByText("BTC-USDT")).toBeInTheDocument();
    expect(screen.getByText(/watching for entry/i)).toBeInTheDocument();
    // The old "No active long position" / "Bot is listening" copy is gone.
    expect(screen.queryByText(/No active long position/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/No active short position/i)).not.toBeInTheDocument();
  });

  it("expands into the full position panel when a position exists", () => {
    render(
      <DualPositionCard
        book="live"
        data={{ symbol: "BTC-USDT", longPosition: active, shortPosition: flat }}
      />,
    );
    expect(screen.getByTestId("dual-position-active")).toBeInTheDocument();
    expect(screen.queryByTestId("dual-position-flat")).not.toBeInTheDocument();
    expect(screen.getByText("LONG")).toBeInTheDocument();
    expect(screen.getByText(/Unrealized P&L/i)).toBeInTheDocument();
    // Empty short slot is no longer rendered.
    expect(screen.queryByText(/SHORT · Flat/i)).not.toBeInTheDocument();
  });
});
