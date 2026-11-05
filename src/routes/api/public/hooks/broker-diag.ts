/**
 * Owner diagnostic for the worker -> Railway broker automation HMAC hop.
 *
 * Token-gated (BROKER_DIAG_TOKEN). NEVER returns secret material — only
 * presence/shape metadata (length, whitespace/quote contamination) and the
 * sanitized broker response for a deliberately INVALID intent (no order is
 * ever created: the intent omits `purpose`, so the broker rejects it at
 * validation AFTER the signature check).
 *
 * Interpretation:
 *   401 INVALID_AUTOMATION_SIGNATURE -> BROKER_SIGNING_SECRET does not match
 *                                       WORKER_ORDER_SHARED_SECRET.
 *   400 INVALID_AUTOMATION_ORDER -> the HMAC hop is healthy.
 */
import { createFileRoute } from "@tanstack/react-router";
import { quorumarkMvpDisabledResponse } from "@/lib/quorumark-mvp-policy.server";

function shape(v: string | undefined) {
  if (v === undefined) return { present: false };
  return {
    present: true,
    length: v.length,
    trimmedLength: v.trim().length,
    hasSurroundingWhitespace: v !== v.trim(),
    hasQuotes: /^["']|["']$/.test(v),
    hasNewline: /[\r\n]/.test(v),
  };
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const row = value as Record<string, unknown>;
  return `{${Object.keys(row)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(row[key])}`)
    .join(",")}}`;
}

async function hmacHex(secret: string, message: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(message));
  return Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export const Route = createFileRoute("/api/public/hooks/broker-diag")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const expected = process.env["BROKER_DIAG_TOKEN"];
        const got = request.headers.get("x-diag-token") ?? "";
        if (!expected || got !== expected) {
          return new Response("unauthorized", { status: 401 });
        }
        if (process.env.QUORUMARK_MVP_MODE !== "disabled") {
          return quorumarkMvpDisabledResponse("broker-diagnostic");
        }

        const rawSecret = process.env["BROKER_SIGNING_SECRET"];
        const brokerUrl = process.env["TURTLE_BROKER_BASE_URL"]?.trim().replace(/\/$/, "");
        const env = {
          BROKER_SIGNING_SECRET: shape(rawSecret),
          TURTLE_BROKER_BASE_URL: { present: Boolean(brokerUrl) },
        };

        if (!rawSecret || !brokerUrl) {
          return Response.json({ env, probe: null, note: "BROKER_NOT_CONFIGURED_IN_WORKER" });
        }

        // Deliberately invalid intent: no `purpose` => rejected at validation,
        // never submitted to a venue.
        const payload = { diag: true, idempotency_key: `diag:${Date.now()}` };
        const body = canonicalJson(payload);
        const path = "/v1/automation/orders";
        const timestamp = String(Math.floor(Date.now() / 1000));
        const nonce = crypto.randomUUID().replaceAll("-", "");
        const sig = await hmacHex(rawSecret.trim(), `${timestamp}\n${nonce}\n${path}\n${body}`);
        const run = async () => {
          const r = await fetch(`${brokerUrl}${path}`, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "x-worker-timestamp": timestamp,
              "x-worker-nonce": nonce,
              "x-worker-signature": sig,
            },
            body,
          });
          const text = await r.text().catch(() => "");
          return { status: r.status, body: text.slice(0, 300) };
        };
        // NOTE: a venue-normalization probe was run here once to prove the
        // VENUE_CONNECTION_MISMATCH fix. It is deliberately NOT kept: any
        // intent with a real purpose reaches the signer and the venue, so a
        // diagnostic endpoint must never be able to emit one.
        return Response.json({ env, probe: await run() });
      },
    },
  },
});
