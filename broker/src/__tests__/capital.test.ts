import { describe, expect, it } from "vitest";
import { CapitalRequestSchema } from "../capital";

const base = {
  connection_id: "00000000-0000-4000-8000-000000000001",
  asset: "USDT",
  idempotency_key: "capital-12345678",
};

describe("ApeX internal capital request", () => {
  it("accepts reads without an amount", () => {
    expect(CapitalRequestSchema.safeParse({ ...base, operation: "READ_CAPITAL" }).success).toBe(
      true,
    );
  });

  it("requires a positive amount for both internal directions", () => {
    for (const operation of ["MOVE_FUNDING_TO_PERPS", "MOVE_PERPS_TO_FUNDING"] as const) {
      expect(CapitalRequestSchema.safeParse({ ...base, operation, amount: "5.25" }).success).toBe(
        true,
      );
      expect(CapitalRequestSchema.safeParse({ ...base, operation, amount: "0" }).success).toBe(
        false,
      );
    }
  });

  it("cannot accept an external address, chain, or other asset", () => {
    expect(
      CapitalRequestSchema.safeParse({
        ...base,
        operation: "MOVE_FUNDING_TO_PERPS",
        amount: "1",
        asset: "ETH",
        address: "0xdead",
        chain_id: 1,
      }).success,
    ).toBe(false);
  });
});
