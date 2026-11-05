import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const source = readFileSync(path.resolve(__dirname, "../exchanges.tsx"), "utf8");

describe("SynFutures setup visibility", () => {
  it("provides the admin setup check in both responsive layouts", () => {
    const [mobile, desktop] = source.split("{/* DESKTOP");
    expect(mobile).toContain("{isOwner && <SynFuturesSdkPanel />}");
    expect(desktop).toContain("{isOwner && <SynFuturesSdkPanel />}");
  });
});
