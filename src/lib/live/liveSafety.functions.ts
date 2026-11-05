import { createServerFn } from "@tanstack/react-start";
import { getRequestHeader } from "@tanstack/react-start/server";

import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { assertLegacyExecutionDisabled } from "@/lib/quorumark-mvp-policy.server";

export type LiveSafetyOperation = "close_all" | "cancel_all";

export interface LiveSafetyInput {
  connectionId: string;
  operation: LiveSafetyOperation;
}

export interface LiveSafetyResult {
  status: string;
  found: number;
  completed: number;
  failed: number;
  detail: string | null;
}

function validateLiveSafetyInput(raw: unknown): LiveSafetyInput {
  const input = raw as Partial<LiveSafetyInput> | null | undefined;
  if (!input || typeof input !== "object") throw new Error("INVALID_INPUT");
  const connectionId = String(input.connectionId ?? "").trim();
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(connectionId)
  ) {
    throw new Error("INVALID_CONNECTION_ID");
  }
  if (!(input.operation === "close_all" || input.operation === "cancel_all")) {
    throw new Error("INVALID_OPERATION");
  }
  return { connectionId, operation: input.operation };
}

export const executeLiveSafetyAction = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator(validateLiveSafetyInput)
  .handler(async ({ data, context }): Promise<LiveSafetyResult> => {
    assertLegacyExecutionDisabled("live-safety-action");
    const admin = await context.supabase.rpc("has_role", {
      _user_id: context.userId,
      _role: "admin",
    });
    if (admin.error || admin.data !== true) throw new Error("NOT_AUTHORIZED");

    const brokerUrl = process.env["TURTLE_BROKER_BASE_URL"];
    if (!brokerUrl) throw new Error("BROKER_NOT_CONFIGURED");
    const authHeader = getRequestHeader("authorization") ?? "";
    if (!authHeader.toLowerCase().startsWith("bearer ")) throw new Error("MISSING_BEARER");

    const endpoint = data.operation === "close_all" ? "close-all" : "cancel-all";
    const response = await fetch(`${brokerUrl.replace(/\/$/, "")}/v1/safety/${endpoint}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: authHeader,
        "x-request-id": crypto.randomUUID(),
      },
      body: JSON.stringify({ connection_id: data.connectionId }),
    });
    const text = await response.text().catch(() => "");
    let json: Record<string, unknown> = {};
    try {
      json = text ? (JSON.parse(text) as Record<string, unknown>) : {};
    } catch {
      json = {};
    }
    if (!response.ok) {
      throw new Error(String(json["error"] ?? `BROKER_HTTP_${response.status}`));
    }
    const found = Number(json["found"] ?? 0);
    const completed = Number(
      data.operation === "close_all" ? (json["submitted"] ?? 0) : (json["cancelled"] ?? 0),
    );
    const failed = Number(json["failed"] ?? 0);
    const missingClientIds = Number(json["missing_client_ids"] ?? 0);
    const unsupportedRows = Number(json["unsupported_position_rows"] ?? 0);
    const detailParts = [
      missingClientIds > 0 ? `${missingClientIds} order(s) lacked a cancellable client id` : "",
      unsupportedRows > 0 ? `${unsupportedRows} position row(s) were unsupported` : "",
    ].filter(Boolean);
    return {
      status: String(json["status"] ?? "completed"),
      found: Number.isFinite(found) ? found : 0,
      completed: Number.isFinite(completed) ? completed : 0,
      failed: Number.isFinite(failed) ? failed : 0,
      detail: detailParts.length > 0 ? detailParts.join("; ") : null,
    };
  });
