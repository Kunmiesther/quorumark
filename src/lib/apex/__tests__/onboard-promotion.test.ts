import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const source = readFileSync(
  resolve(process.cwd(), "src/lib/apex/onboard.functions.ts"),
  "utf8",
);

describe("ApeX onboarding permission promotion", () => {
  it("uses a server-only admin client after broker verification", () => {
    expect(source).toContain(
      'await import("@/integrations/supabase/client.server")',
    );
    expect(source).toContain('supabaseAdmin\n      .from("exchange_connections")');
    expect(source).toContain('.eq("user_id", context.userId)');
    expect(source).toContain('.select("id")');
    expect(source).not.toMatch(
      /context\.supabase\s*\.from\("exchange_connections"\)\s*\.update/,
    );
  });

  it("keeps strategy activation on the same trusted server client", () => {
    expect(source).not.toMatch(
      /context\.supabase\s*\.from\("user_strategy"\)/,
    );
    expect(source.match(/supabaseAdmin\s*\.from\("user_strategy"\)/g)).toHaveLength(3);
    expect(source).toContain('supabaseAdmin\n          .from("strategies")');
  });
});
