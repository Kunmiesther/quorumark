/**
 * Server-only boundary for the Quorumark MVP.
 *
 * Legacy execution is enabled only by an explicit, exact opt-out. Missing,
 * malformed, or client-provided configuration cannot open an execution path.
 * This module must never be imported by client components.
 */

export const QUORUMARK_MVP_DISABLED_CODE = "QUORUMARK_MVP_EXECUTION_DISABLED";
export const QUORUMARK_MVP_DISABLED_MESSAGE =
  "Legacy execution is disabled while Quorumark MVP mode is active.";

type ServerEnvironment = Record<string, string | undefined>;

/** Defaults to MVP mode. Only the exact server-side value "disabled" opts out. */
export function isQuorumarkMvpMode(env: ServerEnvironment = process.env): boolean {
  return env.QUORUMARK_MVP_MODE !== "disabled";
}

export function assertLegacyExecutionDisabled(
  operation: string,
  env: ServerEnvironment = process.env,
): void {
  if (isQuorumarkMvpMode(env)) {
    throw new Error(`${QUORUMARK_MVP_DISABLED_CODE}:${operation}`);
  }
}

export function quorumarkMvpDisabledResponse(operation: string): Response {
  return Response.json(
    {
      ok: false,
      error: QUORUMARK_MVP_DISABLED_CODE,
      message: QUORUMARK_MVP_DISABLED_MESSAGE,
      operation,
    },
    { status: 503, headers: { "cache-control": "no-store" } },
  );
}
