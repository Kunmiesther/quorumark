import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(__dirname, "../../../../../..");
const vercel = JSON.parse(fs.readFileSync(path.join(ROOT, "vercel.json"), "utf8")) as {
  crons: Array<{ path: string; schedule: string }>;
};

const REQUIRED = new Map([
  ["/api/public/hooks/paper-tick", "*/5 * * * *"],
  ["/api/public/hooks/committee-cycle", "*/15 * * * *"],
  ["/api/public/hooks/missed-opportunity-review", "*/15 * * * *"],
  ["/api/public/hooks/ai-advisory", "*/5 * * * *"],
  ["/api/public/hooks/live-advisory", "*/5 * * * *"],
  ["/api/public/hooks/live-fills", "* * * * *"],
  ["/api/public/hooks/live-positions", "* * * * *"],
  ["/api/public/hooks/tp-council", "* * * * *"],
  ["/api/public/hooks/watchdog-snapshot", "* * * * *"],
]);

describe("production runtime cron wiring", () => {
  it("schedules every required runtime stage at its intended cadence", () => {
    const configured = new Map(vercel.crons.map((cron) => [cron.path, cron.schedule]));
    expect(configured).toEqual(REQUIRED);
  });

  it("makes every Vercel cron target GET-compatible and CRON_SECRET-aware", () => {
    for (const route of REQUIRED.keys()) {
      const filename = `${route.split("/").at(-1)}.ts`;
      const source = fs.readFileSync(
        path.join(ROOT, "src/routes/api/public/hooks", filename),
        "utf8",
      );
      expect(source, `${filename} must accept Vercel GET invocations`).toMatch(/GET:\s*handle/);
      expect(source, `${filename} must accept Vercel CRON_SECRET`).toContain(
        "process.env.CRON_SECRET",
      );
    }
  });

  it("routes live TP exits through the Railway automation broker", () => {
    const source = fs.readFileSync(path.join(ROOT, "src/lib/live/tpCouncil.server.ts"), "utf8");
    expect(source).toContain("/v1/automation/orders");
    expect(source).toContain("x-worker-signature");
    expect(source).not.toContain("/functions/v1/execution-broker");
  });
});
