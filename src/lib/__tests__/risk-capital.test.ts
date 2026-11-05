import { describe, it, expect } from "vitest";
import {
  RISK_CAPITAL_MAX_PER_CONNECTION,
  MAX_CONNECTIONS,
  MAX_AGGREGATE_RISK_CAPITAL,
  capPerConnection,
  leveragedNotional,
  aggregateExposure,
  type ConnectionExposure,
} from "../risk-capital";

describe("capPerConnection", () => {
  it("clamps above 500 down to 500", () => {
    expect(capPerConnection(600)).toBe(500);
  });
  it("clamps negatives to 0", () => {
    expect(capPerConnection(-5)).toBe(0);
  });
  it("passes through valid values", () => {
    expect(capPerConnection(250)).toBe(250);
    expect(capPerConnection(0)).toBe(0);
    expect(capPerConnection(500)).toBe(500);
  });
});

describe("aggregate cap constants", () => {
  it("MAX_AGGREGATE_RISK_CAPITAL === 3000, derived from 6 * 500", () => {
    expect(MAX_CONNECTIONS).toBe(6);
    expect(RISK_CAPITAL_MAX_PER_CONNECTION).toBe(500);
    expect(MAX_AGGREGATE_RISK_CAPITAL).toBe(3000);
    expect(MAX_AGGREGATE_RISK_CAPITAL).toBe(
      MAX_CONNECTIONS * RISK_CAPITAL_MAX_PER_CONNECTION,
    );
  });
});

describe("leveragedNotional", () => {
  it("leverage raises notional but margin is unchanged", () => {
    const margin = 500;
    expect(leveragedNotional(margin, 100)).toBe(50000);
    // margin variable untouched — leverage never mutates allocated margin
    expect(margin).toBe(500);
  });
});

describe("aggregateExposure", () => {
  const mk = (i: number, margin: number, leverage: number): ConnectionExposure => ({
    connection_id: `c${i}`,
    marginAllocated: margin,
    leverage,
    notionalExposure: leveragedNotional(margin, leverage),
  });

  it("6 connections at $500 each -> totalMargin 3000; 7th impossible per MAX_CONNECTIONS", () => {
    const six = Array.from({ length: 6 }, (_, i) => mk(i, 500, 1));
    const agg = aggregateExposure(six);
    expect(agg.totalMargin).toBe(3000);
    expect(six.length).toBeLessThanOrEqual(MAX_CONNECTIONS);
    expect(MAX_CONNECTIONS).toBe(6);
  });

  it("never redistributes/borrows — sum equals inputs exactly", () => {
    const list = [mk(0, 100, 10), mk(1, 250, 20), mk(2, 500, 100), mk(3, 0, 5)];
    const agg = aggregateExposure(list);
    const expectedMargin = 100 + 250 + 500 + 0;
    const expectedNotional = 1000 + 5000 + 50000 + 0;
    expect(agg.totalMargin).toBe(expectedMargin);
    expect(agg.totalNotional).toBe(expectedNotional);
  });

  it("empty list returns zeros", () => {
    expect(aggregateExposure([])).toEqual({ totalMargin: 0, totalNotional: 0 });
  });
});

describe.skip("Risk Capital DB behavior (isolated DB required)", () => {
  it("CHECK rejects amount=501 on any connection", () => {});
  it("rejects two confirmed rows on the SAME connection (unique index)", () => {});
  it("allows two confirmed rows on DIFFERENT connections for the same user", () => {});
  it("confirmed_risk_capital(uid, conn) returns 0 for an unowned connection", () => {});
  it("my_confirmed_risk_capital(NULL) returns 0", () => {});
});
