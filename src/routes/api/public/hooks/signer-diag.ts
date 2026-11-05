/**
 * TEMPORARY owner diagnostic for the ApeX live-order path.
 *
 * Token-gated (TMP_SIGNER_DIAG_TOKEN). Returns no secret material: it only
 * relays the signer's own health payload and its REDACTED in-memory reject
 * buffer, and can submit one deliberately minimal live order through the
 * real signer path so the venue's actual answer can be observed.
 *
 * DELETE once the code-3 investigation is closed.
 */
import { createFileRoute } from "@tanstack/react-router";
import { quorumarkMvpDisabledResponse } from "@/lib/quorumark-mvp-policy.server";

async function hmacHex(secret: string, msg: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(msg));
  return Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function signerPost(base: string, secret: string, path: string, body: unknown) {
  const raw = JSON.stringify(body ?? {});
  const ts = String(Math.floor(Date.now() / 1000));
  const nonce = crypto.randomUUID().replace(/-/g, "");
  const sig = await hmacHex(secret, `${ts}\n${nonce}\n${path}\n${raw}`);
  const r = await fetch(`${base}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-signer-timestamp": ts,
      "x-signer-nonce": nonce,
      "x-signer-signature": sig,
    },
    body: raw,
  });
  const text = await r.text().catch(() => "");
  return { status: r.status, body: text.slice(0, 4000) };
}

export const Route = createFileRoute("/api/public/hooks/signer-diag")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const expected = process.env["TMP_SIGNER_DIAG_TOKEN"];
        const got = request.headers.get("x-diag-token") ?? "";
        if (!expected || got !== expected) {
          return new Response("unauthorized", { status: 401 });
        }
        if (process.env.QUORUMARK_MVP_MODE !== "disabled") {
          return quorumarkMvpDisabledResponse("signer-diagnostic");
        }
        const base = (process.env["SIGNER_BASE_URL"] ?? "").replace(/\/$/, "");
        const secret = process.env["SIGNER_SHARED_SECRET"] ?? "";
        if (!base || !secret) return Response.json({ error: "SIGNER_NOT_CONFIGURED" });

        let payload: Record<string, unknown> = {};
        try {
          payload = (await request.json()) as Record<string, unknown>;
        } catch {
          payload = {};
        }
        const action = String(payload["action"] ?? "health");

        if (action === "health") {
          const r = await fetch(`${base}/healthz`);
          return Response.json({ status: r.status, body: (await r.text()).slice(0, 500) });
        }
        if (action === "last-rejects") {
          return Response.json(await signerPost(base, secret, "/v1/last-rejects", {}));
        }
        if (action === "create-order") {
          return Response.json(
            await signerPost(base, secret, "/v1/create-order", payload["body"] ?? {}),
          );
        }
        if (action === "build-order") {
          return Response.json(
            await signerPost(base, secret, "/v1/build-order", payload["body"] ?? {}),
          );
        }
        return Response.json({ error: "UNKNOWN_ACTION" });
      },
    },
  },
});
