// @vitest-environment node
import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
it("keeps public wallet identity scoped to JWT owner and never reads the Aster signing secret", () => {
  const source = readFileSync("supabase/functions/exchange-credentials/index.ts", "utf8");
  const action = source
    .split('if (action === "wallet_identities") {')[1]
    .split("// Diagnostic:")[0];
  expect(action).toContain("if (!userId || isDiagBypass)");
  expect(action).toContain('.eq("user_id", userId).eq("status", "verified")');
  expect(action).toContain('.select("encrypted_api_key")');
  expect(action).not.toContain("encrypted_api_secret");
  expect(action).not.toMatch(/\.update\(|\.insert\(|\.delete\(|console\./);
  expect(action).toContain(
    "return { connection_id: connection.id, exchange: connection.exchange, account_address: address }",
  );
});
