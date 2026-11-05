/**
 * Edge function invoke with a short retry for transient platform errors.
 *
 * The hosted edge runtime can briefly return 503
 * SUPABASE_EDGE_RUNTIME_SERVICE_DEGRADED while a worker is recycled. That is
 * not an application error: retrying the same read a moment later succeeds.
 * Only transient transport/5xx failures are retried — real function errors
 * (4xx, validation, venue rejects) are returned to the caller untouched.
 */
import { supabase } from "@/integrations/supabase/client";

type InvokeResult<T> = { data: T | null; error: { message: string } | null };
type EdgeErrorLike = { message?: string; context?: unknown };

const TRANSIENT = /(503|degraded|temporarily unavailable|failed to fetch|network|timeout|502|504)/i;

export function isTransientEdgeError(error: { message?: string } | null): boolean {
  return !!error?.message && TRANSIENT.test(error.message);
}

/**
 * Supabase wraps every non-2xx function response in `FunctionsHttpError` and
 * gives it the generic message "Edge Function returned a non-2xx status
 * code". The actual safe application reason remains on `error.context` as a
 * Response. Preserve that reason so operators can distinguish a disabled
 * signer, missing credential, venue rejection, or malformed request.
 */
export async function edgeErrorMessage(error: EdgeErrorLike): Promise<string> {
  const fallback = error.message || "EDGE_FUNCTION_FAILED";
  if (!(error.context instanceof Response)) return fallback;
  try {
    const payload = (await error.context.clone().json()) as {
      message?: unknown;
      error?: unknown;
      code?: unknown;
    };
    for (const value of [payload.message, payload.error, payload.code]) {
      if (typeof value === "string" && value.trim()) return value.trim();
    }
  } catch {
    // The fallback remains more useful than throwing while formatting an error.
  }
  return fallback;
}

export async function invokeWithRetry<T = unknown>(
  name: string,
  body: Record<string, unknown>,
  opts: { retries?: number; delayMs?: number } = {},
): Promise<InvokeResult<T>> {
  const retries = opts.retries ?? 2;
  const delayMs = opts.delayMs ?? 600;

  let last: InvokeResult<T> = { data: null, error: { message: "NOT_ATTEMPTED" } };
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const { data, error } = await supabase.functions.invoke(name, { body });
      last = {
        data: (data ?? null) as T | null,
        error: error ? { message: await edgeErrorMessage(error) } : null,
      };
    } catch (e) {
      last = {
        data: null,
        error: { message: e instanceof Error ? e.message : "REQUEST_FAILED" },
      };
    }
    if (!last.error || !isTransientEdgeError(last.error)) return last;
    if (attempt < retries) await new Promise((r) => setTimeout(r, delayMs * (attempt + 1)));
  }
  return last;
}
