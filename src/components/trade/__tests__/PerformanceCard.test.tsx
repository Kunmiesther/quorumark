import { describe, it, expect, afterEach } from "vitest";
import "@testing-library/jest-dom/vitest";
import { render, screen, cleanup } from "@testing-library/react";
import {
  PerformanceCard,
  type PerformanceSection,
} from "@/components/trade/PerformanceCard";

const overall: PerformanceSection = {
  id: "overall",
  title: "Overall · Paper book",
  stats: [
    { label: "Open", value: "3", tone: "accent" },
    { label: "Attempted", value: "42" },
    { label: "Wins", value: "27", tone: "pos" },
    { label: "Losses", value: "15", tone: "neg" },
    { label: "Win rate", value: "64%", tone: "pos" },
    { label: "Realized", value: "+$1,204", tone: "pos" },
  ],
};

afterEach(() => cleanup());

describe("PerformanceCard", () => {
  it("renders the six overall stats from a single section", () => {
    render(<PerformanceCard sections={[overall]} />);
    expect(screen.getByTestId("perf-section-overall")).toBeInTheDocument();
    for (const s of overall.stats ?? []) {
      expect(screen.getByText(s.label)).toBeInTheDocument();
      expect(screen.getByText(s.value)).toBeInTheDocument();
    }
  });

  it("accepts multiple sections without any container refactor", () => {
    const perStrategy: PerformanceSection = {
      id: "hunter",
      title: "Hunter",
      stats: [{ label: "Wins", value: "9", tone: "pos" }],
    };
    render(<PerformanceCard sections={[overall, perStrategy]} />);
    expect(screen.getByTestId("perf-section-overall")).toBeInTheDocument();
    expect(screen.getByTestId("perf-section-hunter")).toBeInTheDocument();
  });
});
