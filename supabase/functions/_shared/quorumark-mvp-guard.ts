/**
 * Supabase Edge Function boundary for Quorumark MVP deployments.
 *
 * Edge functions have an independent environment, so they cannot inherit the
 * TanStack server policy at runtime. They remain disabled unless the exact
 * server-only opt-out value is configured in that function's environment.
 */

export const QUORUMARK_MVP_DISABLED_CODE = "QUORUMARK_MVP_EXECUTION_DISABLED";

type DenoEnvironment = {
  env: { get: (name: string) => string | undefined };
};

function rawMode(): string | undefined {
  const deno = (globalThis as typeof globalThis & { Deno?: DenoEnvironment }).Deno;
  return deno?.env.get("QUORUMARK_MVP_MODE");
}

export function isQuorumarkMvpMode(raw: string | undefined = rawMode()): boolean {
  return raw !== "disabled";
}

export function quorumarkMvpDisabledResponse(
  operation: string,
  headers: Record<string, string> = { "content-type": "application/json" },
): Response {
  return new Response(
    JSON.stringify({
      ok: false,
      error: QUORUMARK_MVP_DISABLED_CODE,
      operation,
    }),
    { status: 503, headers: { ...headers, "cache-control": "no-store" } },
  );
}
