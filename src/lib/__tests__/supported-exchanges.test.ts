import { describe, expect, it } from "vitest";

import {
  SUPPORTED_DEX,
  isSupportedDex,
  venueSupportsMarket,
} from "../supported-exchanges";

describe("TurtleBot perpetual venues", () => {
  it("uses ApeX Omni, Aster, and SynFutures as the product venue set", () => {
    expect(SUPPORTED_DEX).toEqual(["apex_omni", "aster", "synfutures"]);
  });

  it.each(["apex_omni", "aster", "synfutures"])(
    "%s is a futures-only supported DEX",
    (venue) => {
      expect(isSupportedDex(venue)).toBe(true);
      expect(venueSupportsMarket(venue, "futures")).toBe(true);
      expect(venueSupportsMarket(venue, "spot")).toBe(false);
    },
  );
});
