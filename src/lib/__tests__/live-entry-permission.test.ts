import { describe, expect, it } from "vitest";
import { permitsLiveEntry } from "../../../supabase/functions/_shared/live-entry-permission";
const ready = { is_live: true, status: "verified", permission_trade: true, permissions_verified: true };
describe("owner live-entry control", () => {
  it("accepts the owner's verified live connection", () => expect(permitsLiveEntry(ready)).toBe(true));
  it.each([null, {}, { ...ready, is_live: false }, { ...ready, is_live: undefined },
    { ...ready, status: "paused" }, { ...ready, permission_trade: false },
    { ...ready, permissions_verified: false }, { ...ready, is_live: "true" }])
    ("does not authorize an unready connection %j", connection => expect(permitsLiveEntry(connection)).toBe(false));
});
