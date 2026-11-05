import { render, screen, cleanup } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { PositionProtectionReadout } from "../PositionProtectionReadout";
afterEach(cleanup);
describe("venue protection readout", () => {
  it("shows all TP levels, SL and partial quantities", () => {
    render(
      <PositionProtectionReadout
        protection={{
          takeProfits: [
            { id: "1", price: 0.06599, quantity: 5000, closePosition: false },
            { id: "2", price: 0.07, quantity: 11000, closePosition: false },
          ],
          stops: [{ id: "3", price: 0.05, quantity: null, closePosition: true }],
        }}
      />,
    );
    expect(screen.getByText(/TP1 0.06599/)).toBeTruthy();
    expect(screen.getByText(/TP2 0.07000/)).toBeTruthy();
    expect(screen.getByText(/5,000 units/)).toBeTruthy();
    expect(screen.getByText(/SL 0.05000/)).toBeTruthy();
    expect(screen.getByText(/close position/)).toBeTruthy();
  });
  it("does not claim that a bot target is an exchange order", () => {
    render(
      <PositionProtectionReadout protection={{ takeProfits: [], stops: [] }} botTarget={80000} />,
    );
    expect(screen.getByText("TP not visible at venue")).toBeTruthy();
    expect(screen.getByText("SL not visible at venue")).toBeTruthy();
    expect(screen.getByText(/Bot target 80,000.00 · not order proof/)).toBeTruthy();
  });
});
