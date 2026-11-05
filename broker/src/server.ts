// TurtleBot Public Execution Broker — Railway service.
//
// Trust model (do NOT weaken):
//   - Exposed over HTTPS only (Railway terminates TLS at the public edge).
//   - Authoritative identity comes from a Supabase JWT verified against
//     the Supabase JWKS. No client-supplied user_id is trusted.
//   - Server resolves ownership, limits and kill-switch through Supabase as
//     the caller. RLS enforces ownership; this broker holds no service-role key.
//   - Signing NEVER happens here. This process calls the private signer at
//     $SIGNER_BASE_URL (a *.railway.internal hostname) with an HMAC over
//     timestamp + nonce + method + path + exact body, keyed by
//     $SIGNER_SHARED_SECRET.
//   - The signer's responses are sanitized before returning to the browser.
//     Signer secrets are never surfaced.
//   - Every mainnet flag defaults false. Live execution requires the
//     corresponding venue gates, authenticated caller and private signer.

import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { createHmac, randomUUID, randomBytes, timingSafeEqual } from "node:crypto";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { LiveOrderSchema, liveOrderRiskRejection, type LiveOrderLimits } from "./liveOrder.js";
import { makeJwtVerifier } from "./auth.js";
import { CapitalRequestSchema } from "./capital.js";
import {
  AutomationOrderSchema,
  automationSignerPurpose,
  unsupportedCampaignReason,
} from "./automationOrder.js";
import {
  cancellableClientOrderIds,
  reduceOnlyCloseIntents,
  SafetyActionSchema,
} from "./safetyAction.js";
import { verifyWorkerRequest } from "./workerAuth.js";
import { registerAsterLifecycleRoutes } from "./asterLifecycle.js";
import { registerSynFuturesLifecycleRoutes } from "./synfuturesLifecycle.js";

// ---------- environment ----------
type Env = {
  SUPABASE_URL: string;
  SUPABASE_PUBLISHABLE_KEY: string;
  SUPABASE_JWT_ISSUER: string;
  SUPABASE_JWKS_URL: string;
  SIGNER_BASE_URL: string;
  SIGNER_SHARED_SECRET: string;
  WORKER_ORDER_SHARED_SECRET: string | null;
  SIGNER_TIMEOUT_MS: number;
  CORS_ALLOWED_ORIGINS: string[];
  RATE_LIMIT_PER_MIN: number;
  APEX_MAINNET_READS_ENABLED: boolean;
  APEX_MAINNET_SIGNER_ENABLED: boolean;
  APEX_MAINNET_CANARY_ENABLED: boolean;
  APEX_MAINNET_AUTOMATION_ENABLED: boolean;
  ASTER_MAINNET_AUTOMATION_ENABLED: boolean;
  SYNFUTURES_MAINNET_AUTOMATION_ENABLED?: boolean;
  APEX_MAINNET_CAPITAL_ENABLED: boolean;
  NODE_ENV: string;
  PORT: number;
};

function required(name: string): string {
  const v = process.env[name];
  if (!v || !v.trim()) throw new Error(`MISSING_ENV:${name}`);
  return v;
}

function loadEnv(): Env {
  const url = required("SUPABASE_URL");
  // Accept either the new-style publishable key or the legacy anon key under
  // the same slot; both are safe to ship to the broker (RLS is enforced
  // server-side by PostgREST using the caller's bearer JWT).
  const publishable =
    process.env.SUPABASE_PUBLISHABLE_KEY?.trim() || process.env.SUPABASE_ANON_KEY?.trim();
  if (!publishable) throw new Error("MISSING_ENV:SUPABASE_PUBLISHABLE_KEY");
  return {
    SUPABASE_URL: url,
    SUPABASE_PUBLISHABLE_KEY: publishable,
    SUPABASE_JWT_ISSUER: process.env.SUPABASE_JWT_ISSUER ?? `${url}/auth/v1`,
    SUPABASE_JWKS_URL: process.env.SUPABASE_JWKS_URL ?? `${url}/auth/v1/.well-known/jwks.json`,
    SIGNER_BASE_URL: required("SIGNER_BASE_URL"),
    SIGNER_SHARED_SECRET: required("SIGNER_SHARED_SECRET"),
    WORKER_ORDER_SHARED_SECRET: process.env.WORKER_ORDER_SHARED_SECRET?.trim() || null,
    SIGNER_TIMEOUT_MS: Number(process.env.SIGNER_TIMEOUT_MS ?? "5000"),
    CORS_ALLOWED_ORIGINS: (process.env.CORS_ALLOWED_ORIGINS ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    RATE_LIMIT_PER_MIN: Number(process.env.RATE_LIMIT_PER_MIN ?? "60"),
    APEX_MAINNET_READS_ENABLED: process.env.APEX_MAINNET_READS_ENABLED === "true",
    APEX_MAINNET_SIGNER_ENABLED: process.env.APEX_MAINNET_SIGNER_ENABLED === "true",
    APEX_MAINNET_CANARY_ENABLED: process.env.APEX_MAINNET_CANARY_ENABLED === "true",
    APEX_MAINNET_AUTOMATION_ENABLED: process.env.APEX_MAINNET_AUTOMATION_ENABLED === "true",
    ASTER_MAINNET_AUTOMATION_ENABLED: process.env.ASTER_MAINNET_AUTOMATION_ENABLED === "true",
    SYNFUTURES_MAINNET_AUTOMATION_ENABLED: process.env.SYNFUTURES_MAINNET_AUTOMATION_ENABLED === "true",
    APEX_MAINNET_CAPITAL_ENABLED: process.env.APEX_MAINNET_CAPITAL_ENABLED === "true",
    NODE_ENV: process.env.NODE_ENV ?? "production",
    PORT: Number(process.env.PORT ?? "8080"),
  };
}

// ---------- allowed operations (typed allowlist) ----------
const ALLOWED_OPERATIONS = new Set([
  "VERIFY_CREDENTIALS",
  "READ_ACCOUNT",
  "READ_MARKETS",
  "READ_ORDERS",
  "READ_POSITIONS",
  "READ_CAPITAL",
  "BUILD_ORDER",
  "SIGN_ORDER",
  "CREATE_ORDER",
  "CANCEL_ORDER",
  "CANCEL_ALL_ORDERS",
  "CLOSE_POSITION",
  "CLOSE_ALL_POSITIONS",
  "RECONCILE",
  "MOVE_FUNDING_TO_PERPS",
  "MOVE_PERPS_TO_FUNDING",
]);

// ---------- HMAC helper ----------
function computeHmac(
  secret: string,
  timestamp: string,
  nonce: string,
  path: string,
  body: string,
): string {
  const h = createHmac("sha256", secret);
  // Must match signer/app/security.py exactly:
  // HMAC_SHA256(secret, `${timestamp}\n${nonce}\n${path}\n${raw_body}`)
  // Do not include the HTTP method; the private signer binds requests by URL
  // path and exact body bytes. Including method here makes every broker call
  // fail before wallet-signature validation, surfacing as a misleading
  // INVALID_SIGNATURE to the UI.
  h.update(`${timestamp}\n${nonce}\n${path}\n${body}`);
  return h.digest("hex");
}

type OnboardEnvironment = "mainnet" | "testnet";

function normalizeApexEnvironment(value: unknown): OnboardEnvironment | null {
  const env = String(value ?? "")
    .trim()
    .toLowerCase();
  if (env === "mainnet" || env === "production" || env === "prod") return "mainnet";
  if (env === "testnet" || env === "test" || env === "sandbox") return "testnet";
  return null;
}

// ---------- server ----------
export async function build() {
  const env = loadEnv();

  const app = Fastify({
    logger: {
      level: env.NODE_ENV === "production" ? "info" : "debug",
      redact: {
        paths: [
          "req.headers.authorization",
          'req.headers["x-signer-signature"]',
          "req.headers.cookie",
          "*.SIGNER_SHARED_SECRET",
          "*.SUPABASE_PUBLISHABLE_KEY",
          "*.apiKey",
          "*.apiSecret",
          "*.passphrase",
          "*.omniSeed",
        ],
        remove: true,
      },
    },
    trustProxy: true,
    disableRequestLogging: false,
    bodyLimit: 32 * 1024,
    genReqId: () => randomUUID(),
  });

  const workerRawBodies = new WeakMap<FastifyRequest, string>();
  const parseJson = app.getDefaultJsonParser("error", "error");
  app.removeContentTypeParser("application/json");
  app.addContentTypeParser("application/json", { parseAs: "string" }, (req, body, done) => {
    if (["/v1/automation/orders", "/v1/automation/synfutures/protect"].includes(req.routeOptions.url ?? "")) {
      workerRawBodies.set(req, body as string);
    }
    // Retain Fastify's normal JSON/prototype validation and body-size limit.
    parseJson(req, body as string, done);
  });

  await app.register(cors, {
    origin: (origin, cb) => {
      // No Origin => non-browser call (allowed; identity comes from JWT).
      if (!origin) return cb(null, true);
      if (env.CORS_ALLOWED_ORIGINS.includes(origin)) return cb(null, true);
      return cb(new Error("CORS_ORIGIN_NOT_ALLOWED"), false);
    },
    credentials: false,
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: [
      "Authorization",
      "Content-Type",
      "X-Request-Id",
      "X-Worker-Timestamp",
      "X-Worker-Nonce",
      "X-Worker-Signature",
      "X-Worker-Signature-Version",
    ],
    maxAge: 600,
  });

  await app.register(rateLimit, {
    max: env.RATE_LIMIT_PER_MIN,
    timeWindow: "1 minute",
    keyGenerator: (req) => {
      // Prefer authenticated user id; fall back to IP.
      const auth = (req.headers.authorization ?? "") as string;
      if (auth.toLowerCase().startsWith("bearer ")) {
        // Cheap key: hash last 24 chars of token so the rate-limit key is stable per session but not the token itself.
        return `u:${auth.slice(-24)}`;
      }
      return `ip:${req.ip}`;
    },
    errorResponseBuilder: () => ({ error: "RATE_LIMITED" }),
  });

  // Per-request Supabase client bound to the CALLER's bearer JWT. RLS on
  // `exchange_connections`, `profiles`, etc. restricts every read/write to
  // the authenticated user (auth.uid()). The broker no longer holds a
  // service-role key — same security outcome via RLS.
  //
  // New-format `sb_publishable_*` keys are opaque, not JWTs. PostgREST
  // still expects them as `apikey`, and the caller's Supabase JWT is the
  // `Authorization: Bearer` value. When @supabase/supabase-js would send
  // the publishable key as bearer (its default), strip it so PostgREST
  // sees only the caller token.
  function supabaseAsCaller(authorization: string): SupabaseClient {
    const pub = env.SUPABASE_PUBLISHABLE_KEY;
    return createClient(env.SUPABASE_URL, pub, {
      auth: { persistSession: false, autoRefreshToken: false },
      global: {
        headers: { Authorization: authorization },
        fetch: (input, init) => {
          const h = new Headers(init?.headers);
          if (pub.startsWith("sb_") && h.get("Authorization") === `Bearer ${pub}`) {
            h.set("Authorization", authorization);
          }
          h.set("apikey", pub);
          return fetch(input, { ...init, headers: h });
        },
      },
    });
  }

  const verifyBearer = makeJwtVerifier(env);
  const workerOrderNonces = new Map<string, number>();

  async function callSigner(path: string, payload: Record<string, unknown>) {
    const body = JSON.stringify(payload);
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const nonce = randomBytes(16).toString("hex");
    const signature = computeHmac(env.SIGNER_SHARED_SECRET, timestamp, nonce, path, body);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), path.startsWith("/v1/synfutures/")
      ? Math.max(env.SIGNER_TIMEOUT_MS,45_000) : env.SIGNER_TIMEOUT_MS);
    let response: Response;
    try {
      response = await fetch(`${env.SIGNER_BASE_URL.replace(/\/$/, "")}${path}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-signer-timestamp": timestamp,
          "x-signer-nonce": nonce,
          "x-signer-signature": signature,
        },
        body,
        signal: controller.signal,
      });
    } catch {
      throw new Error("SIGNER_UNREACHABLE");
    } finally {
      clearTimeout(timeout);
    }

    const responseBody = await response.text();
    const responseSignature = response.headers.get("x-signer-signature") ?? "";
    const responseTimestamp = response.headers.get("x-signer-timestamp") ?? "";
    const responseNonce = response.headers.get("x-signer-nonce") ?? "";
    if (responseSignature && responseTimestamp && responseNonce) {
      const expected = computeHmac(
        env.SIGNER_SHARED_SECRET,
        responseTimestamp,
        responseNonce,
        path,
        responseBody,
      );
      const actualBuffer = Buffer.from(responseSignature, "utf8");
      const expectedBuffer = Buffer.from(expected, "utf8");
      if (
        actualBuffer.length !== expectedBuffer.length ||
        !timingSafeEqual(actualBuffer, expectedBuffer)
      ) {
        throw new Error("SIGNER_RESPONSE_UNVERIFIED");
      }
    }

    let json: Record<string, unknown> = {};
    try {
      json = JSON.parse(responseBody) as Record<string, unknown>;
    } catch {
      json = {};
    }
    return { ok: response.ok, status: response.status, json };
  }

  // Generic error → sanitized public response with a correlation id.
  app.setErrorHandler((err, req, reply) => {
    const status = (err as { statusCode?: number }).statusCode ?? 500;
    const message = err instanceof Error ? err.message : "BAD_REQUEST";
    const publicCode = status < 500 ? message : "INTERNAL_ERROR";
    req.log.error({ err, correlationId: req.id }, "request_failed");
    reply.status(status).send({ error: publicCode, correlation_id: req.id });
  });

  app.setNotFoundHandler((req, reply) => {
    reply.status(404).send({ error: "NOT_FOUND", correlation_id: req.id });
  });

  // ---------- health ----------
  app.get("/healthz", async () => ({
    ok: true,
    service: "turtlebot-broker",
    // Flags are exposed as booleans only (no secrets, no config paths).
    flags: {
      reads: env.APEX_MAINNET_READS_ENABLED,
      signer: env.APEX_MAINNET_SIGNER_ENABLED,
      canary: env.APEX_MAINNET_CANARY_ENABLED,
      automation: env.APEX_MAINNET_AUTOMATION_ENABLED,
      capital: env.APEX_MAINNET_CAPITAL_ENABLED,
    },
  }));

  // Deep-check that the private signer is reachable and answers /healthz.
  // Owner-only pattern: does NOT expose signer errors verbatim.
  app.get("/readyz", async (_req, reply) => {
    try {
      const controller = new AbortController();
      const t = setTimeout(() => controller.abort(), env.SIGNER_TIMEOUT_MS);
      const res = await fetch(`${env.SIGNER_BASE_URL.replace(/\/$/, "")}/healthz`, {
        signal: controller.signal,
      }).finally(() => clearTimeout(t));
      if (!res.ok) return reply.status(503).send({ ok: false, signer: "unhealthy" });
      const health = await res.json() as Record<string, unknown>;
      return { ok: true, signer: "ok", aster_automation_enabled: health.aster_automation_enabled === true };
    } catch {
      return reply.status(503).send({ ok: false, signer: "unreachable" });
    }
  });

  app.get("/v1/automation/capabilities", async () => {
    let signerReady = false;
    let asterSignerReady = false;
    let apexSignerReady = false;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), env.SIGNER_TIMEOUT_MS);
    try {
      const response = await fetch(
        `${env.SIGNER_BASE_URL.replace(/\/$/, "")}/healthz`,
        { signal: controller.signal },
      );
      const health = response.ok ? await response.json() as Record<string, unknown> : null;
      signerReady = health?.ok === true;
      asterSignerReady = signerReady && health?.aster_automation_enabled === true;
      apexSignerReady = signerReady && health?.apex_automation_enabled === true;
    } catch { /* Unreachable signer is not an executable route. */ }
    finally { clearTimeout(timer); }
    const authenticated = Boolean(env.WORKER_ORDER_SHARED_SECRET);
    const venues = {
      apex_omni: apexSignerReady && authenticated && env.APEX_MAINNET_SIGNER_ENABLED &&
        env.APEX_MAINNET_CANARY_ENABLED && env.APEX_MAINNET_AUTOMATION_ENABLED,
      aster: asterSignerReady && authenticated && env.ASTER_MAINNET_AUTOMATION_ENABLED,
    };
    const accepting = Object.values(venues).some(Boolean);
    return {
      ok: true, signer_reachable: signerReady,
      supported_campaign_rung_counts: accepting ? [5] : [],
      venues, accepting_orders: accepting,
    };
  });

  // ---------- authenticated preflight ----------
  // Owner smoke test: proves JWT verification and Supabase reachability work
  // end-to-end without touching any exchange endpoint.
  app.get("/v1/whoami", async (req: FastifyRequest, reply: FastifyReply) => {
    const identity = await verifyBearer(req.headers.authorization);
    // Read own profile row through PostgREST as the caller. RLS restricts
    // reads to auth.uid() = id, so `data` is non-null iff the caller has a
    // profile row of their own — same ownership sanity check as before.
    const sb = supabaseAsCaller(req.headers.authorization as string);
    const { data, error } = await sb
      .from("profiles")
      .select("id")
      .eq("id", identity.sub)
      .maybeSingle();
    if (error)
      return reply.status(500).send({ error: "PROFILE_LOOKUP_FAILED", correlation_id: req.id });
    return { user_id: identity.sub, profile_exists: Boolean(data) };
  });

  // ---------- intent preflight (does NOT submit) ----------
  const IntentSchema = z.object({
    operation: z.string().min(1),
    venue: z.literal("apex_omni"),
    symbol: z.string().min(1).optional(),
    connection_id: z.string().uuid(),
    idempotency_key: z.string().min(8).max(64),
  });

  app.post("/v1/intents/preflight", async (req: FastifyRequest, reply: FastifyReply) => {
    const identity = await verifyBearer(req.headers.authorization);
    const parsed = IntentSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: "INVALID_INTENT", correlation_id: req.id });
    }
    const intent = parsed.data;

    if (!ALLOWED_OPERATIONS.has(intent.operation)) {
      return reply.status(403).send({ error: "OPERATION_NOT_ALLOWED", correlation_id: req.id });
    }

    const sb = supabaseAsCaller(req.headers.authorization as string);

    // Kill-switch (fail closed). The RPC is SECURITY DEFINER and self-scopes
    // to auth.uid() = p_user_id; anything else returns halted.
    let halted = true;
    try {
      const { data, error } = await sb.rpc("is_execution_halted", {
        p_user_id: identity.sub,
        p_connection_id: intent.connection_id,
      });
      halted = error ? true : data !== false;
    } catch {
      halted = true;
    }
    if (halted)
      return reply.status(423).send({ error: "EXECUTION_HALTED", correlation_id: req.id });

    // Ownership check: connection must belong to caller. RLS on
    // exchange_connections restricts SELECT to auth.uid() = user_id, so the
    // row is only visible when the caller owns it.
    const { data: conn } = await sb
      .from("exchange_connections")
      .select("id, user_id, exchange, status")
      .eq("id", intent.connection_id)
      .maybeSingle();
    if (!conn || conn.user_id !== identity.sub) {
      return reply.status(404).send({ error: "CONNECTION_NOT_FOUND", correlation_id: req.id });
    }
    if (conn.exchange !== "apex_omni") {
      return reply.status(400).send({ error: "VENUE_MISMATCH", correlation_id: req.id });
    }

    // Flag-driven gate. Reads need APEX_MAINNET_READS_ENABLED; writes need
    // APEX_MAINNET_SIGNER_ENABLED (build/sign/cancel/reconcile) and, for
    // order emission, APEX_MAINNET_CANARY_ENABLED. Signer performs the
    // authoritative per-operation gating too.
    const isRead =
      intent.operation.startsWith("READ_") || intent.operation === "VERIFY_CREDENTIALS";
    if (isRead && !env.APEX_MAINNET_READS_ENABLED) {
      return reply.status(403).send({ error: "READS_DISABLED", correlation_id: req.id });
    }
    if (!isRead && !env.APEX_MAINNET_SIGNER_ENABLED) {
      return reply.status(403).send({ error: "SIGNER_DISABLED", correlation_id: req.id });
    }
    const emits =
      intent.operation === "CREATE_ORDER" ||
      intent.operation === "CLOSE_POSITION" ||
      intent.operation === "CLOSE_ALL_POSITIONS";
    if (emits && !env.APEX_MAINNET_CANARY_ENABLED) {
      return reply.status(403).send({ error: "CANARY_DISABLED", correlation_id: req.id });
    }

    // Delegate to signer over HMAC. Signer performs authenticated ApeX read.
    const path = "/v1/read";
    const bodyStr = JSON.stringify({
      operation: intent.operation,
      symbol: intent.symbol ?? null,
      connection_id: intent.connection_id,
      user_id: identity.sub, // signer verifies server-side too
    });
    const ts = Math.floor(Date.now() / 1000).toString();
    const nonce = randomBytes(16).toString("hex");
    const sig = computeHmac(env.SIGNER_SHARED_SECRET, ts, nonce, path, bodyStr);

    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), env.SIGNER_TIMEOUT_MS);
    let signerRes: Response;
    try {
      signerRes = await fetch(`${env.SIGNER_BASE_URL.replace(/\/$/, "")}${path}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-signer-timestamp": ts,
          "x-signer-nonce": nonce,
          "x-signer-signature": sig,
        },
        body: bodyStr,
        signal: controller.signal,
      });
    } catch {
      return reply.status(503).send({ error: "SIGNER_UNREACHABLE", correlation_id: req.id });
    } finally {
      clearTimeout(t);
    }

    // Verify signer response signature if present (defence in depth).
    const respSig = signerRes.headers.get("x-signer-signature") ?? "";
    const respTs = signerRes.headers.get("x-signer-timestamp") ?? "";
    const respNonce = signerRes.headers.get("x-signer-nonce") ?? "";
    const respBody = await signerRes.text();
    if (respSig && respTs && respNonce) {
      const expected = computeHmac(env.SIGNER_SHARED_SECRET, respTs, respNonce, path, respBody);
      const a = Buffer.from(expected, "utf8");
      const b = Buffer.from(respSig, "utf8");
      if (a.length !== b.length || !timingSafeEqual(a, b)) {
        return reply
          .status(502)
          .send({ error: "SIGNER_RESPONSE_UNVERIFIED", correlation_id: req.id });
      }
    }
    if (!signerRes.ok) {
      return reply.status(502).send({ error: "SIGNER_ERROR", correlation_id: req.id });
    }

    let parsedBody: unknown = null;
    try {
      parsedBody = JSON.parse(respBody);
    } catch {
      parsedBody = null;
    }
    return { ok: true, operation: intent.operation, data: parsedBody };
  });

  // ---------- same-account ApeX capital allocation ----------
  app.post("/v1/capital", async (req: FastifyRequest, reply: FastifyReply) => {
    const identity = await verifyBearer(req.headers.authorization);
    const parsed = CapitalRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: "INVALID_CAPITAL_REQUEST", correlation_id: req.id });
    }
    const input = parsed.data;
    const isRead = input.operation === "READ_CAPITAL";
    if (isRead && !env.APEX_MAINNET_READS_ENABLED) {
      return reply.status(403).send({ error: "READS_DISABLED", correlation_id: req.id });
    }
    if (!isRead && (!env.APEX_MAINNET_SIGNER_ENABLED || !env.APEX_MAINNET_CAPITAL_ENABLED)) {
      return reply.status(403).send({ error: "CAPITAL_MOVES_DISABLED", correlation_id: req.id });
    }

    const sb = supabaseAsCaller(req.headers.authorization as string);
    const { data: conn, error: connError } = await sb
      .from("exchange_connections")
      .select("id,user_id,exchange,status,environment")
      .eq("id", input.connection_id)
      .maybeSingle();
    if (connError || !conn || conn.user_id !== identity.sub) {
      return reply.status(404).send({ error: "CONNECTION_NOT_FOUND", correlation_id: req.id });
    }
    if (conn.exchange !== "apex_omni" || !["mainnet", "production"].includes(conn.environment)) {
      return reply.status(400).send({ error: "VENUE_MISMATCH", correlation_id: req.id });
    }

    if (!isRead) {
      let halted = true;
      try {
        const result = await sb.rpc("is_execution_halted", {
          p_user_id: identity.sub,
          p_connection_id: input.connection_id,
        });
        halted = result.error ? true : result.data !== false;
      } catch {
        halted = true;
      }
      if (halted) {
        return reply.status(423).send({ error: "EXECUTION_HALTED", correlation_id: req.id });
      }
    }

    const path = "/v1/capital";
    const body = JSON.stringify({
      user_id: identity.sub,
      exchange_connection_id: input.connection_id,
      operation: input.operation,
      amount: input.amount ?? null,
      asset: input.asset,
      idempotency_key: input.idempotency_key,
    });
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const nonce = randomBytes(16).toString("hex");
    const signature = computeHmac(env.SIGNER_SHARED_SECRET, timestamp, nonce, path, body);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), env.SIGNER_TIMEOUT_MS);
    let response: Response;
    try {
      response = await fetch(`${env.SIGNER_BASE_URL.replace(/\/$/, "")}${path}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-signer-timestamp": timestamp,
          "x-signer-nonce": nonce,
          "x-signer-signature": signature,
        },
        body,
        signal: controller.signal,
      });
    } catch {
      return reply.status(503).send({ error: "SIGNER_UNREACHABLE", correlation_id: req.id });
    } finally {
      clearTimeout(timeout);
    }

    const responseBody = await response.text();
    const responseSignature = response.headers.get("x-signer-signature") ?? "";
    const responseTimestamp = response.headers.get("x-signer-timestamp") ?? "";
    const responseNonce = response.headers.get("x-signer-nonce") ?? "";
    if (responseSignature && responseTimestamp && responseNonce) {
      const expected = computeHmac(
        env.SIGNER_SHARED_SECRET,
        responseTimestamp,
        responseNonce,
        path,
        responseBody,
      );
      const actualBuffer = Buffer.from(responseSignature, "utf8");
      const expectedBuffer = Buffer.from(expected, "utf8");
      if (
        actualBuffer.length !== expectedBuffer.length ||
        !timingSafeEqual(actualBuffer, expectedBuffer)
      ) {
        return reply
          .status(502)
          .send({ error: "SIGNER_RESPONSE_UNVERIFIED", correlation_id: req.id });
      }
    }
    let json: Record<string, unknown> = {};
    try {
      json = JSON.parse(responseBody) as Record<string, unknown>;
    } catch {
      json = {};
    }
    if (!response.ok) {
      const detail = typeof json.detail === "string" ? json.detail : "SIGNER_ERROR";
      return reply.status(response.status).send({ error: detail, correlation_id: req.id });
    }
    return reply.send({ ok: true, ...json });
  });

  // ---------- worker-authenticated automated live orders ----------
  //
  // The worker has no user JWT and no database administrator credential. It
  // receives user/connection scope only from the separately HMAC-authenticated
  // worker-ingest service. This route authenticates that machine with a
  // dedicated replay-protected HMAC, validates a strict credential-free
  // intent, then delegates to the private signer. The signer independently
  // resolves ownership, credentials, kill switch, venue exposure, collateral,
  // idempotency, sizing clamps, and protective orders.
  app.post("/v1/automation/orders", async (req: FastifyRequest, reply: FastifyReply) => {
    const auth = verifyWorkerRequest({
      secret: env.WORKER_ORDER_SHARED_SECRET,
      timestamp: String(req.headers["x-worker-timestamp"] ?? ""),
      nonce: String(req.headers["x-worker-nonce"] ?? ""),
      signature: String(req.headers["x-worker-signature"] ?? ""),
      path: "/v1/automation/orders",
      body: req.body,
      signatureVersion: String(req.headers["x-worker-signature-version"] ?? "canonical-v1"),
      rawBody: workerRawBodies.get(req),
      nowSeconds: Math.floor(Date.now() / 1000),
      seenNonces: workerOrderNonces,
    });
    if (!auth.ok) {
      const status = auth.code === "AUTOMATION_AUTH_NOT_CONFIGURED" ? 503 : 401;
      return reply.status(status).send({ ok: false, error: auth.code, reject_reason: auth.code, correlation_id: req.id });
    }
    const parsed = AutomationOrderSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: "INVALID_AUTOMATION_ORDER", correlation_id: req.id });
    }
    const input = parsed.data;
    if (input.venue === "synfutures") {
      if (!env.SYNFUTURES_MAINNET_AUTOMATION_ENABLED) {
        return reply.status(403).send({ok:false,reject_reason:"SYNFUTURES_AUTOMATION_DISABLED",correlation_id:req.id});
      }
    } else if (input.venue === "aster") {
      if (!input.reduce_only && !env.ASTER_MAINNET_AUTOMATION_ENABLED) {
        return reply.status(403).send({ error: "ASTER_AUTOMATION_DISABLED", correlation_id: req.id });
      }
    } else {
      if (!env.APEX_MAINNET_AUTOMATION_ENABLED) {
        return reply.status(403).send({ error: "AUTOMATION_DISABLED", correlation_id: req.id });
      }
      if (!env.APEX_MAINNET_SIGNER_ENABLED) {
        return reply.status(403).send({ error: "SIGNER_DISABLED", correlation_id: req.id });
      }
      if (!env.APEX_MAINNET_CANARY_ENABLED) {
        return reply.status(403).send({ error: "CANARY_DISABLED", correlation_id: req.id });
      }
    }
    const campaignRejection = unsupportedCampaignReason(input);
    if (campaignRejection) {
      return reply.status(409).send({
        status: "rejected",
        reject_reason: campaignRejection,
        correlation_id: req.id,
      });
    }
    const path = "/v1/orders";
    const signerBody = JSON.stringify({
      user_id: input.user_id,
      exchange_connection_id: input.connection_id,
      client_order_id: input.idempotency_key,
      symbol: input.symbol,
      side: input.side,
      order_type: input.order_type,
      size: input.size ?? null,
      price: input.price ?? null,
      leverage: input.leverage ?? null,
      reduce_only: input.reduce_only ?? false,
      environment: "mainnet",
      purpose: automationSignerPurpose(input),
      venue: input.venue,
      ...(input.venue === "synfutures" ? {margin_usdc:input.margin_usdc} : {}),
      ...(input.tp_tiers ? { tp_tiers: input.tp_tiers } : {}),
      ...(input.stop_pct ? { stop_pct: input.stop_pct } : {}),
      ...(input.campaign_rung_count ? { campaign_rung_count: input.campaign_rung_count } : {}),
      ...(input.campaign_margin_usd !== undefined
        ? { campaign_margin_usd: input.campaign_margin_usd }
        : {}),
      ...(input.campaign_margin_per_rung_usd !== undefined
        ? { campaign_margin_per_rung_usd: input.campaign_margin_per_rung_usd }
        : {}),
    });
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const nonce = randomBytes(16).toString("hex");
    const signature = computeHmac(env.SIGNER_SHARED_SECRET, timestamp, nonce, path, signerBody);
    const controller = new AbortController();
    // Five venue submissions with attached stops cannot share the legacy
    // single-order 5s budget. The signer remains bounded; an abort after any
    // accepted rung is ambiguous and must be reconciled, never retried.
    const signerTimeoutMs =
      input.campaign_rung_count === 5 || input.venue === "synfutures"
        ? Math.max(env.SIGNER_TIMEOUT_MS, 45_000)
        : env.SIGNER_TIMEOUT_MS;
    const timeout = setTimeout(() => controller.abort(), signerTimeoutMs);
    let signerResponse: Response;
    let responseBody: string;
    try {
      signerResponse = await fetch(`${env.SIGNER_BASE_URL.replace(/\/$/, "")}${path}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-signer-timestamp": timestamp,
          "x-signer-nonce": nonce,
          "x-signer-signature": signature,
        },
        body: signerBody,
        signal: controller.signal,
      });
      // The response body is part of the same bounded operation.
      responseBody = await signerResponse.text();
    } catch {
      return reply.status(503).send({
        status: "ambiguous",
        reject_reason: "SIGNER_UNREACHABLE",
        correlation_id: req.id,
      });
    } finally {
      clearTimeout(timeout);
    }

    const responseSignature = signerResponse.headers.get("x-signer-signature") ?? "";
    const responseTimestamp = signerResponse.headers.get("x-signer-timestamp") ?? "";
    const responseNonce = signerResponse.headers.get("x-signer-nonce") ?? "";
    if (responseSignature && responseTimestamp && responseNonce) {
      const expected = computeHmac(
        env.SIGNER_SHARED_SECRET,
        responseTimestamp,
        responseNonce,
        path,
        responseBody,
      );
      const expectedBytes = Buffer.from(expected, "utf8");
      const actualBytes = Buffer.from(responseSignature, "utf8");
      if (
        expectedBytes.length !== actualBytes.length ||
        !timingSafeEqual(expectedBytes, actualBytes)
      ) {
        return reply.status(502).send({
          status: "ambiguous",
          reject_reason: "SIGNER_RESPONSE_UNVERIFIED",
          correlation_id: req.id,
        });
      }
    }

    let signerJson: Record<string, unknown> = {};
    try {
      signerJson = JSON.parse(responseBody) as Record<string, unknown>;
    } catch {
      signerJson = {};
    }
    if (!signerResponse.ok) {
      const detail = typeof signerJson.detail === "string" ? signerJson.detail : "SIGNER_ERROR";
      return reply.status(signerResponse.status).send({
        status: signerResponse.status >= 500 ? "ambiguous" : "rejected",
        reject_reason: detail,
        correlation_id: req.id,
      });
    }

    if (!["submitted", "duplicate", "rejected", "ambiguous"].includes(String(signerJson.status))) {
      return reply.status(502).send({ status: "ambiguous", reject_reason: "SIGNER_RESPONSE_UNRECOGNISED", correlation_id: req.id });
    }

    req.log.info(
      {
        correlationId: req.id,
        userId: input.user_id,
        connectionId: input.connection_id,
        symbol: input.symbol,
        side: input.side,
        status: String(signerJson.status ?? "submitted"),
      },
      "automated_live_order_result",
    );
    return reply.send({
      status: String(signerJson.status ?? "submitted"),
      exchange_order_id:
        typeof signerJson.exchange_order_id === "string" ? signerJson.exchange_order_id : null,
      exchange_status:
        typeof signerJson.exchange_status === "string" ? signerJson.exchange_status : null,
      reject_reason: typeof signerJson.reject_reason === "string" ? signerJson.reject_reason : null,
      protections_attached: signerJson.protections_attached === true,
      campaign_rung_count:
        typeof signerJson.campaign_rung_count === "number" ? signerJson.campaign_rung_count : null,
      campaign_orders: Array.isArray(signerJson.campaign_orders) ? signerJson.campaign_orders : [],
      reconciliation_required: signerJson.reconciliation_required === true,
      filled_size: typeof signerJson.filled_size === "string" ? signerJson.filled_size : null,
      reduce_only: signerJson.reduce_only === true,
      correlation_id: req.id,
    });
  });

  app.post("/v1/automation/synfutures/protect", async(req,reply)=>{
    const path="/v1/automation/synfutures/protect";
    const auth=verifyWorkerRequest({secret:env.WORKER_ORDER_SHARED_SECRET,
      timestamp:String(req.headers["x-worker-timestamp"]??""),nonce:String(req.headers["x-worker-nonce"]??""),
      signature:String(req.headers["x-worker-signature"]??""),path,body:req.body,
      signatureVersion:String(req.headers["x-worker-signature-version"]??"canonical-v1"),rawBody:workerRawBodies.get(req),
      nowSeconds:Math.floor(Date.now()/1000),seenNonces:workerOrderNonces});
    if (!auth.ok)return reply.status(401).send({error:auth.code});
    const parsed=z.object({user_id:z.string().uuid(),connection_id:z.string().uuid()}).strict().safeParse(req.body);
    if (!parsed.success)return reply.status(400).send({error:"INVALID_SYNFUTURES_MONITOR_REQUEST"});
    try {
      const result=await callSigner("/v1/synfutures/protect",{user_id:parsed.data.user_id,
        exchange_connection_id:parsed.data.connection_id,entries_paused:!env.SYNFUTURES_MAINNET_AUTOMATION_ENABLED});
      if (!result.ok || result.json.status!=="monitored")return reply.status(503).send({error:"SYNFUTURES_MONITOR_UNCONFIRMED"});
      const keys=z.array(z.string().min(8).max(64)).max(20).safeParse(result.json.resolved_campaign_keys??[]);
      if (!keys.success)return reply.status(503).send({error:"SYNFUTURES_MONITOR_UNCONFIRMED"});
      return reply.send({status:"monitored",reconciliation_required:result.json.reconciliation_required===true,resolved_campaign_keys:keys.data});
    } catch {return reply.status(503).send({error:"SYNFUTURES_MONITOR_UNCONFIRMED"});}
  });

  registerAsterLifecycleRoutes(app, {
    verifyBearer,
    callSigner,
    ownedConnection: async (authorization, userId, connectionId) => {
      const { data, error } = await supabaseAsCaller(authorization)
        .from("exchange_connections")
        .select("user_id,exchange,environment,status,permission_trade,permissions_verified")
        .eq("id", connectionId)
        .eq("user_id", userId)
        .maybeSingle();
      return error ? null : data;
    },
  });

  registerSynFuturesLifecycleRoutes(app, {
    verifyBearer,
    callSigner,
    ownedConnection: async (authorization, userId, connectionId) => {
      const { data, error } = await supabaseAsCaller(authorization)
        .from("exchange_connections").select("user_id,exchange,environment")
        .eq("id", connectionId).eq("user_id", userId).maybeSingle();
      return error ? null : data;

    },
  });

  // ---------- owner-only live safety actions ----------
  //
  // These routes can only reduce risk. They derive order IDs, symbols, sides
  // and sizes from the signer's authenticated ApeX snapshot; the browser may
  // supply only the owned connection id. A kill switch deliberately does not
  // block cancellation or reduce-only exits.
  app.post("/v1/safety/cancel-all", async (req: FastifyRequest, reply: FastifyReply) => {
    const identity = await verifyBearer(req.headers.authorization);
    const parsed = SafetyActionSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: "INVALID_SAFETY_ACTION", correlation_id: req.id });
    }
    if (!env.APEX_MAINNET_SIGNER_ENABLED) {
      return reply.status(403).send({ error: "SIGNER_DISABLED", correlation_id: req.id });
    }

    const authorization = req.headers.authorization as string;
    const sb = supabaseAsCaller(authorization);
    const admin = await sb.rpc("has_role", { _user_id: identity.sub, _role: "admin" });
    if (admin.error || admin.data !== true) {
      return reply.status(403).send({ error: "ADMIN_ONLY", correlation_id: req.id });
    }

    const { data: conn, error: connError } = await sb
      .from("exchange_connections")
      .select("id,user_id,exchange,environment,status,permission_trade,permissions_verified")
      .eq("id", parsed.data.connection_id)
      .maybeSingle();
    if (connError || !conn || conn.user_id !== identity.sub) {
      return reply.status(404).send({ error: "CONNECTION_NOT_FOUND", correlation_id: req.id });
    }
    if (
      conn.exchange !== "apex_omni" ||
      normalizeApexEnvironment(conn.environment) !== "mainnet" ||
      conn.status !== "verified" ||
      conn.permission_trade !== true ||
      conn.permissions_verified !== true
    ) {
      return reply
        .status(409)
        .send({ error: "CONNECTION_NOT_SAFETY_READY", correlation_id: req.id });
    }

    let snapshot;
    try {
      snapshot = await callSigner("/v1/positions", {
        user_id: identity.sub,
        exchange_connection_id: parsed.data.connection_id,
      });
    } catch (error) {
      return reply.status(503).send({
        error: error instanceof Error ? error.message : "SIGNER_UNREACHABLE",
        correlation_id: req.id,
      });
    }
    if (!snapshot.ok || snapshot.json.status === "error") {
      return reply.status(502).send({ error: "POSITION_SNAPSHOT_FAILED", correlation_id: req.id });
    }
    const orders = Array.isArray(snapshot.json.open_orders) ? snapshot.json.open_orders : [];
    const clientOrderIds = cancellableClientOrderIds(orders);
    const missingClientIds = Math.max(0, orders.length - clientOrderIds.length);
    let cancelled = 0;
    const failed: string[] = [];
    for (const clientOrderId of clientOrderIds) {
      try {
        const result = await callSigner("/v1/cancel-order", {
          user_id: identity.sub,
          exchange_connection_id: parsed.data.connection_id,
          client_order_id: clientOrderId,
        });
        if (result.ok && result.json.status !== "error") cancelled += 1;
        else failed.push(clientOrderId);
      } catch {
        failed.push(clientOrderId);
      }
    }

    return reply.send({
      status: failed.length === 0 && missingClientIds === 0 ? "completed" : "partial",
      found: orders.length,
      cancelled,
      failed: failed.length,
      missing_client_ids: missingClientIds,
      correlation_id: req.id,
    });
  });

  app.post("/v1/safety/close-all", async (req: FastifyRequest, reply: FastifyReply) => {
    const identity = await verifyBearer(req.headers.authorization);
    const parsed = SafetyActionSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: "INVALID_SAFETY_ACTION", correlation_id: req.id });
    }
    if (!env.APEX_MAINNET_SIGNER_ENABLED) {
      return reply.status(403).send({ error: "SIGNER_DISABLED", correlation_id: req.id });
    }
    if (!env.APEX_MAINNET_CANARY_ENABLED) {
      return reply.status(403).send({ error: "CANARY_DISABLED", correlation_id: req.id });
    }

    const authorization = req.headers.authorization as string;
    const sb = supabaseAsCaller(authorization);
    const admin = await sb.rpc("has_role", { _user_id: identity.sub, _role: "admin" });
    if (admin.error || admin.data !== true) {
      return reply.status(403).send({ error: "ADMIN_ONLY", correlation_id: req.id });
    }

    const { data: conn, error: connError } = await sb
      .from("exchange_connections")
      .select("id,user_id,exchange,environment,status,permission_trade,permissions_verified")
      .eq("id", parsed.data.connection_id)
      .maybeSingle();
    if (connError || !conn || conn.user_id !== identity.sub) {
      return reply.status(404).send({ error: "CONNECTION_NOT_FOUND", correlation_id: req.id });
    }
    if (
      conn.exchange !== "apex_omni" ||
      normalizeApexEnvironment(conn.environment) !== "mainnet" ||
      conn.status !== "verified" ||
      conn.permission_trade !== true ||
      conn.permissions_verified !== true
    ) {
      return reply
        .status(409)
        .send({ error: "CONNECTION_NOT_SAFETY_READY", correlation_id: req.id });
    }

    let snapshot;
    try {
      snapshot = await callSigner("/v1/positions", {
        user_id: identity.sub,
        exchange_connection_id: parsed.data.connection_id,
      });
    } catch (error) {
      return reply.status(503).send({
        error: error instanceof Error ? error.message : "SIGNER_UNREACHABLE",
        correlation_id: req.id,
      });
    }
    if (!snapshot.ok || snapshot.json.status === "error") {
      return reply.status(502).send({ error: "POSITION_SNAPSHOT_FAILED", correlation_id: req.id });
    }
    const positions = Array.isArray(snapshot.json.positions) ? snapshot.json.positions : [];
    const intents = reduceOnlyCloseIntents(positions);
    let submitted = 0;
    const failed: string[] = [];
    for (let index = 0; index < intents.length; index += 1) {
      const intent = intents[index]!;
      const clientOrderId = [
        "tb-close",
        Date.now().toString(36),
        String(index + 1),
        intent.symbol.replace("-", "").toLowerCase(),
      ].join("-");
      try {
        const result = await callSigner("/v1/orders", {
          user_id: identity.sub,
          exchange_connection_id: parsed.data.connection_id,
          client_order_id: clientOrderId,
          symbol: intent.symbol,
          side: intent.side,
          order_type: "MARKET",
          size: intent.size,
          price: null,
          leverage: intent.leverage,
          reduce_only: true,
          environment: "mainnet",
          purpose: "owner_safety_close",
          venue: "apex_omni",
        });
        if (result.ok && result.json.status !== "error") submitted += 1;
        else failed.push(intent.symbol);
      } catch {
        failed.push(intent.symbol);
      }
    }

    return reply.send({
      status: failed.length === 0 ? (intents.length === 0 ? "noop" : "submitted") : "partial",
      found: positions.length,
      submitted,
      failed: failed.length,
      unsupported_position_rows: Math.max(0, positions.length - intents.length),
      correlation_id: req.id,
    });
  });

  // ---------- owner-only manual live canary ----------
  //
  // This is the only browser-reachable write route. It deliberately does not
  // accept user_id, venue, margin mode, protections, or arbitrary operation
  // names. Identity comes from the verified JWT; connection ownership and
  // admin status come from caller-scoped Supabase reads; the private signer
  // independently enforces the real mark-based notional cap.
  app.post("/v1/orders", async (req: FastifyRequest, reply: FastifyReply) => {
    const identity = await verifyBearer(req.headers.authorization);
    const parsed = LiveOrderSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: "INVALID_LIVE_ORDER", correlation_id: req.id });
    }
    if (!env.APEX_MAINNET_SIGNER_ENABLED) {
      return reply.status(403).send({ error: "SIGNER_DISABLED", correlation_id: req.id });
    }
    if (!env.APEX_MAINNET_CANARY_ENABLED) {
      return reply.status(403).send({ error: "CANARY_DISABLED", correlation_id: req.id });
    }

    const input = parsed.data;
    const authorization = req.headers.authorization as string;
    const sb = supabaseAsCaller(authorization);

    const { data: isAdmin, error: roleError } = await sb.rpc("has_role", {
      _user_id: identity.sub,
      _role: "admin",
    });
    if (roleError || isAdmin !== true) {
      return reply.status(403).send({ error: "ADMIN_ONLY", correlation_id: req.id });
    }

    const { data: conn, error: connError } = await sb
      .from("exchange_connections")
      .select(
        "id,user_id,exchange,environment,status,permission_trade,permissions_verified,is_live",
      )
      .eq("id", input.connection_id)
      .maybeSingle();
    if (connError || !conn || conn.user_id !== identity.sub) {
      return reply.status(404).send({ error: "CONNECTION_NOT_FOUND", correlation_id: req.id });
    }
    if (conn.exchange !== "apex_omni") {
      return reply.status(400).send({ error: "VENUE_MISMATCH", correlation_id: req.id });
    }
    if (
      normalizeApexEnvironment(conn.environment) !== "mainnet" ||
      conn.status !== "verified" ||
      conn.permission_trade !== true ||
      conn.permissions_verified !== true ||
      conn.is_live !== true
    ) {
      return reply.status(409).send({ error: "CONNECTION_NOT_LIVE_READY", correlation_id: req.id });
    }

    let halted = true;
    try {
      const { data, error } = await sb.rpc("is_execution_halted", {
        p_user_id: identity.sub,
        p_connection_id: input.connection_id,
      });
      halted = error ? true : data !== false;
    } catch {
      halted = true;
    }
    if (halted) {
      return reply.status(423).send({ error: "EXECUTION_HALTED", correlation_id: req.id });
    }

    const dayStart = new Date();
    dayStart.setUTCHours(0, 0, 0, 0);
    const [limitsResult, positionsResult, tradesResult] = await Promise.all([
      sb
        .from("user_trading_limits")
        .select("max_leverage,max_order_size_usd,max_total_exposure_usd,daily_loss_limit_usd")
        .eq("user_id", identity.sub)
        .maybeSingle(),
      sb
        .from("positions")
        .select("size,current_price,entry_price")
        .eq("user_id", identity.sub)
        .eq("status", "open"),
      sb
        .from("trades")
        .select("realized_pnl")
        .eq("user_id", identity.sub)
        .eq("book", "live")
        .gte("closed_at", dayStart.toISOString()),
    ]);
    if (limitsResult.error || positionsResult.error || tradesResult.error) {
      return reply.status(503).send({ error: "RISK_SNAPSHOT_UNAVAILABLE", correlation_id: req.id });
    }
    const limits: LiveOrderLimits = limitsResult.data
      ? {
          maxLeverage: Number(limitsResult.data.max_leverage),
          maxOrderSizeUsd: Number(limitsResult.data.max_order_size_usd),
          maxTotalExposureUsd: Number(limitsResult.data.max_total_exposure_usd),
          dailyLossLimitUsd: Number(limitsResult.data.daily_loss_limit_usd),
        }
      : {
          maxLeverage: 5,
          maxOrderSizeUsd: 100,
          maxTotalExposureUsd: 100,
          dailyLossLimitUsd: 25,
        };
    if (Object.values(limits).some((value) => !Number.isFinite(value) || value < 0)) {
      return reply.status(503).send({ error: "RISK_LIMITS_INVALID", correlation_id: req.id });
    }
    const currentExposureUsd = (positionsResult.data ?? []).reduce((sum, position) => {
      const price = Number(position.current_price) || Number(position.entry_price) || 0;
      return sum + Math.abs(Number(position.size) || 0) * price;
    }, 0);
    const todayRealisedUsd = (tradesResult.data ?? []).reduce(
      (sum, trade) => sum + (Number(trade.realized_pnl) || 0),
      0,
    );
    const riskReject = liveOrderRiskRejection(input, currentExposureUsd, todayRealisedUsd, limits);
    if (riskReject) {
      return reply.status(409).send({ error: riskReject, correlation_id: req.id });
    }

    const path = "/v1/orders";
    const signerBody = JSON.stringify({
      user_id: identity.sub,
      exchange_connection_id: input.connection_id,
      client_order_id: input.client_order_id,
      symbol: input.symbol,
      side: input.side,
      order_type: "MARKET",
      size: input.size,
      price: null,
      leverage: input.leverage,
      reduce_only: false,
      environment: "mainnet",
      purpose: "internal_owner_canary",
      venue: "apex_omni",
    });
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const nonce = randomBytes(16).toString("hex");
    const signature = computeHmac(env.SIGNER_SHARED_SECRET, timestamp, nonce, path, signerBody);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), env.SIGNER_TIMEOUT_MS);
    let signerResponse: Response;
    try {
      signerResponse = await fetch(`${env.SIGNER_BASE_URL.replace(/\/$/, "")}${path}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-signer-timestamp": timestamp,
          "x-signer-nonce": nonce,
          "x-signer-signature": signature,
        },
        body: signerBody,
        signal: controller.signal,
      });
    } catch {
      return reply.status(503).send({ error: "SIGNER_UNREACHABLE", correlation_id: req.id });
    } finally {
      clearTimeout(timeout);
    }

    const responseBody = await signerResponse.text();
    const responseSignature = signerResponse.headers.get("x-signer-signature") ?? "";
    const responseTimestamp = signerResponse.headers.get("x-signer-timestamp") ?? "";
    const responseNonce = signerResponse.headers.get("x-signer-nonce") ?? "";
    if (responseSignature && responseTimestamp && responseNonce) {
      const expected = computeHmac(
        env.SIGNER_SHARED_SECRET,
        responseTimestamp,
        responseNonce,
        path,
        responseBody,
      );
      const actualBuffer = Buffer.from(responseSignature, "utf8");
      const expectedBuffer = Buffer.from(expected, "utf8");
      if (
        actualBuffer.length !== expectedBuffer.length ||
        !timingSafeEqual(actualBuffer, expectedBuffer)
      ) {
        return reply
          .status(502)
          .send({ error: "SIGNER_RESPONSE_UNVERIFIED", correlation_id: req.id });
      }
    }

    let signerJson: Record<string, unknown> = {};
    try {
      signerJson = JSON.parse(responseBody) as Record<string, unknown>;
    } catch {
      signerJson = {};
    }
    if (!signerResponse.ok) {
      const detail = typeof signerJson.detail === "string" ? signerJson.detail : "SIGNER_ERROR";
      return reply.status(signerResponse.status).send({ error: detail, correlation_id: req.id });
    }

    const built =
      signerJson.built && typeof signerJson.built === "object"
        ? (signerJson.built as Record<string, unknown>)
        : {};
    req.log.info(
      {
        correlationId: req.id,
        userId: identity.sub,
        connectionId: input.connection_id,
        symbol: input.symbol,
        side: input.side,
        status: String(signerJson.status ?? "submitted"),
      },
      "internal_live_canary_result",
    );
    return {
      status: String(signerJson.status ?? "submitted"),
      exchange_order_id:
        typeof signerJson.exchange_order_id === "string" ? signerJson.exchange_order_id : null,
      exchange_status:
        typeof signerJson.exchange_status === "string" ? signerJson.exchange_status : null,
      reject_reason: typeof signerJson.reject_reason === "string" ? signerJson.reject_reason : null,
      protections_attached: signerJson.protections_attached === true,
      built: {
        symbol: typeof built.symbol === "string" ? built.symbol : input.symbol,
        side: typeof built.side === "string" ? built.side : input.side,
        size: typeof built.size === "string" ? built.size : null,
        notional_usd: typeof built.notional_usd === "string" ? built.notional_usd : null,
        margin_usd: typeof built.margin_usd === "string" ? built.margin_usd : null,
        leverage: typeof built.leverage === "number" ? built.leverage : input.leverage,
      },
      correlation_id: req.id,
    };
  });

  // ---------- owner onboarding proxy ----------
  //
  // Browser-facing entry point to the private signer's /v1/onboard. The
  // caller must be authenticated (JWT verified above); ownership of the
  // exchange_connection is verified against Supabase as the caller, relying
  // on RLS (auth.uid() = user_id) so only the row-owner can pass. The
  // wallet's EIP-191 signature is treated as opaque credential material —
  // logged nowhere, redacted, and forwarded verbatim. The signer performs
  // its own recovery, derivation, and persistence.
  const OnboardSchema = z.object({
    connection_id: z.string().uuid(),
    wallet_address: z.string().regex(/^0x[a-fA-F0-9]{40}$/),
    environment: z.enum(["mainnet", "testnet"]),
    signature: z.string().min(10).max(200),
  });

  app.post("/v1/onboard", async (req: FastifyRequest, reply: FastifyReply) => {
    const identity = await verifyBearer(req.headers.authorization);
    const parsed = OnboardSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: "INVALID_ONBOARD", correlation_id: req.id });
    }
    const body = parsed.data;

    if (!env.APEX_MAINNET_SIGNER_ENABLED) {
      return reply.status(403).send({ error: "SIGNER_DISABLED", correlation_id: req.id });
    }

    // Ownership + venue check (RLS enforces auth.uid() = user_id).
    const sb = supabaseAsCaller(req.headers.authorization as string);
    const { data: conn } = await sb
      .from("exchange_connections")
      .select("id, user_id, exchange, environment, status")
      .eq("id", body.connection_id)
      .maybeSingle();
    if (!conn || conn.user_id !== identity.sub) {
      return reply.status(404).send({ error: "CONNECTION_NOT_FOUND", correlation_id: req.id });
    }

    if (conn.exchange !== "apex_omni") {
      return reply.status(400).send({ error: "VENUE_MISMATCH", correlation_id: req.id });
    }
    const connectionEnvironment = normalizeApexEnvironment(conn.environment);
    if (!connectionEnvironment || connectionEnvironment !== body.environment) {
      return reply.status(400).send({ error: "ENVIRONMENT_MISMATCH", correlation_id: req.id });
    }

    // Delegate to signer over HMAC. Forward the caller's Supabase JWT
    // inside the HMAC-covered body so the signer can write
    // apex_execution_credentials as the caller (RLS enforced); this
    // removes the SUPABASE_SERVICE_ROLE_KEY requirement on the signer host.
    const authHeader = (req.headers.authorization ?? "") as string;
    const callerJwt = authHeader.toLowerCase().startsWith("bearer ")
      ? authHeader.slice(7).trim()
      : authHeader.trim();
    const path = "/v1/onboard";
    const bodyStr = JSON.stringify({
      user_id: identity.sub,
      exchange_connection_id: body.connection_id,
      wallet_address: body.wallet_address,
      environment: body.environment,
      signature: body.signature,
      caller_jwt: callerJwt,
    });
    const ts = Math.floor(Date.now() / 1000).toString();
    const nonce = randomBytes(16).toString("hex");
    const sig = computeHmac(env.SIGNER_SHARED_SECRET, ts, nonce, path, bodyStr);

    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), env.SIGNER_TIMEOUT_MS);
    let signerRes: Response;
    try {
      signerRes = await fetch(`${env.SIGNER_BASE_URL.replace(/\/$/, "")}${path}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-signer-timestamp": ts,
          "x-signer-nonce": nonce,
          "x-signer-signature": sig,
        },
        body: bodyStr,
        signal: controller.signal,
      });
    } catch {
      return reply.status(503).send({ error: "SIGNER_UNREACHABLE", correlation_id: req.id });
    } finally {
      clearTimeout(t);
    }

    const respBody = await signerRes.text();
    if (!signerRes.ok) {
      // Forward the signer's structured detail code (already sanitized) so
      // the UI can render a concrete error. Never forward stack traces.
      let detail = "SIGNER_ERROR";
      try {
        const parsed = JSON.parse(respBody);
        if (typeof parsed?.detail === "string") detail = parsed.detail;
      } catch {
        /* keep default */
      }
      return reply.status(signerRes.status).send({ error: detail, correlation_id: req.id });
    }
    let parsedBody: unknown = null;
    try {
      parsedBody = JSON.parse(respBody);
    } catch {
      parsedBody = null;
    }
    return { ok: true, data: parsedBody };
  });

  return app;
}

async function main() {
  const app = await build();
  const port = Number(process.env.PORT ?? "8080");
  await app.listen({ host: "0.0.0.0", port });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch((err) => {
  console.error(JSON.stringify({ level: "fatal", msg: "boot_failed", err: String(err) }));
  process.exit(1);
});
