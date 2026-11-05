import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { ChartSymbolSelector } from "../ChartSymbolSelector";

afterEach(cleanup);

describe("chart symbol selector", () => {
  it("switches the shared chart/ticket selection without submitting a form", () => {
    function Desk() {
      const [symbol, setSymbol] = useState("ETH-USDT");
      return (
        <>
          <ChartSymbolSelector
            symbol={symbol}
            symbols={["BTC-USDT", "ETH-USDT", "SOL-USDT", "XRP-USDT"]}
            onSymbol={setSymbol}
          />
          <output aria-label="Ticket symbol">{symbol}</output>
        </>
      );
    }
    render(<Desk />);
    const selector = screen.getByRole("combobox", { name: "Chart symbol" });
    expect(screen.getAllByRole("option")).toHaveLength(4);
    for (const symbol of ["BTC-USDT", "SOL-USDT", "XRP-USDT", "ETH-USDT"]) {
      fireEvent.change(selector, { target: { value: symbol } });
      expect(screen.getByLabelText("Ticket symbol").textContent).toBe(symbol);
      expect((selector as HTMLSelectElement).value).toBe(symbol);
    }
  });

  it("keeps an external position's symbol visible and permits switching back", () => {
    render(
      <ChartSymbolSelector
        symbol="TAKE-USDT"
        symbols={["BTC-USDT", "ETH-USDT", "BTC-USDT"]}
        onSymbol={() => {}}
      />,
    );
    expect(screen.getAllByRole("option")).toHaveLength(3);
    expect((screen.getByRole("combobox") as HTMLSelectElement).value).toBe("TAKE-USDT");
  });
});
