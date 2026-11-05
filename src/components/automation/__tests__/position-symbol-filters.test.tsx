import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { PositionSymbolFilters } from "../PositionSymbolFilters";

const options = [
  { symbol: "ALL", count: 3 },
  { symbol: "BTC", count: 2 },
  { symbol: "ETH", count: 0 },
  { symbol: "SOL", count: 0 },
  { symbol: "XRP", count: 0 },
];

afterEach(cleanup);

describe("Position symbol filters", () => {
  it("shows all four logos with readable labels and unchanged counts", () => {
    render(<PositionSymbolFilters options={options} selected="ALL" onSelect={vi.fn()} />);
    expect(screen.getByRole("group", { name: "Filter live positions by symbol" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "All symbols 3" }).getAttribute("aria-pressed")).toBe(
      "true",
    );
    for (const { symbol, count } of options.slice(1)) {
      const button = screen.getByRole("button", { name: `${symbol} ${count}` });
      expect(button.getAttribute("aria-pressed")).toBe("false");
      expect(button.querySelector("img")?.getAttribute("src")).toContain(
        symbol === "SOL" ? "/branding/solanaLogoMark.svg" : `/${symbol.toLowerCase()}.svg`,
      );
      expect(button.querySelector("img")?.getAttribute("width")).toBe("20");
    }
  });

  it("keeps zero-count filters interactive and reflects the selected symbol", () => {
    const onSelect = vi.fn();
    const { rerender } = render(
      <PositionSymbolFilters options={options} selected="ALL" onSelect={onSelect} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "ETH 0" }));
    expect(onSelect).toHaveBeenCalledExactlyOnceWith("ETH");
    rerender(<PositionSymbolFilters options={options} selected="ETH" onSelect={onSelect} />);
    expect(screen.getByRole("button", { name: "ETH 0" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("button", { name: "All symbols 3" }).getAttribute("aria-pressed")).toBe(
      "false",
    );
  });

  it("preserves the accessible label and count when a logo fails", () => {
    render(<PositionSymbolFilters options={options} selected="BTC" onSelect={vi.fn()} />);
    const button = screen.getByRole("button", { name: "BTC 2" });
    fireEvent.error(button.querySelector("img")!);
    expect(button.querySelector("img")).toBeNull();
    expect(screen.getByRole("button", { name: "BTC 2" })).toBe(button);
  });
});
