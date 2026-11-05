import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = path.resolve(__dirname, "../../../../../..");
const hook = fs.readFileSync(path.join(root, "src/routes/api/public/hooks/live-fills.ts"), "utf8");
const edge = fs.readFileSync(
  path.join(root, "supabase/functions/ingest-live-fills/index.ts"),
  "utf8",
);
const config = fs.readFileSync(path.join(root, "supabase/config.toml"), "utf8");

describe("live fill polling boundary", () => {
  it("allows only cron-authorized requests and does not expose venue account details", () => {
    expect(hook).toContain("isAuthorizedCronRequest(request, [process.env.CRON_SECRET])");
    expect(hook).toContain("status: 401");
    expect(hook).toContain('functions.invoke("ingest-live-fills"');
    expect(hook).not.toContain("place-order");
    expect(hook).not.toContain("execution-broker");
  });

  it("requires the service-role bearer token before reading all venue connections", () => {
    expect(edge).toContain('isAuthorizedServiceReader(req, serviceKey, Deno.env.get("SUPABASE_SECRET_KEYS"))');
    expect(hook).toContain("apikey: process.env.SUPABASE_SECRET_KEY");
    expect(edge).toContain("SERVICE_ROLE_REQUIRED");
    expect(config).toMatch(/\[functions\.ingest-live-fills\]\s*verify_jwt = true/);
  });
});
