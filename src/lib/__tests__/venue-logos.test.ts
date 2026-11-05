import { describe, expect, it } from "vitest";

import { venueLogo } from "@/lib/venue-logos";

describe("venueLogo", () => {
  it.each(["apex_omni", "aster", "synfutures"])(
    "returns a public brand mark for %s",
    (venue) => {
      expect(venueLogo(venue)).toBeTruthy();
    },
  );
});
