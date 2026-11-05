import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

const SOURCE = fs.readFileSync(path.resolve(__dirname, "../apex-capital.ts"), "utf8");
const GRAPH = fs.readFileSync(
  path.resolve(__dirname, "../../../../../supabase/functions/apex-capital-flow/index.ts"),
  "utf8",
);

describe("ApeX capital proxy boundary", () => {
  it("uses one fixed broker destination and forwards the caller bearer token", () => {
    expect(SOURCE).toMatch(/process\.env\["TURTLE_BROKER_BASE_URL"\]/);
    expect(SOURCE).toMatch(/authorization,/);
    expect(SOURCE).toMatch(/`\$\{brokerUrl\}\/v1\/capital`/);
    expect(SOURCE).not.toMatch(/withdraw|destination_address|chain_id/i);
  });

  it("accepts only the three internal capital operations and USDT", () => {
    expect(SOURCE).toMatch(/READ_CAPITAL/);
    expect(SOURCE).toMatch(/MOVE_FUNDING_TO_PERPS/);
    expect(SOURCE).toMatch(/MOVE_PERPS_TO_FUNDING/);
    expect(SOURCE).toMatch(/body\.asset !== "USDT"/);
  });

  it("gives the LangGraph deployment a same-origin production fallback", () => {
    expect(GRAPH).toMatch(/TURTLE_CAPITAL_PROXY_URL/);
    expect(GRAPH).toMatch(/https:\/\/www\.turtlebot\.app\/api\/internal\/apex-capital/);
  });
});
