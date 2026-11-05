import { describe, expect, it } from "vitest";
import { edgeErrorMessage, isTransientEdgeError } from "./invokeWithRetry";

describe("edge error details", () => {
  it("surfaces the function's safe JSON message instead of Supabase's wrapper", async () => {
    const message = await edgeErrorMessage({
      message: "Edge Function returned a non-2xx status code",
      context: Response.json({ ok: false, message: "CREDENTIAL_NOT_FOUND" }, { status: 502 }),
    });
    expect(message).toBe("CREDENTIAL_NOT_FOUND");
  });

  it("falls back cleanly when the response is not JSON", async () => {
    const message = await edgeErrorMessage({
      message: "Edge Function returned a non-2xx status code",
      context: new Response("gateway error", { status: 502 }),
    });
    expect(message).toBe("Edge Function returned a non-2xx status code");
  });

  it("still recognizes detailed 5xx reasons as transient", () => {
    expect(isTransientEdgeError({ message: "BROKER_UNREACHABLE 503" })).toBe(true);
  });
});
