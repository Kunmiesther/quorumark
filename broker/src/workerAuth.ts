import { createHmac, timingSafeEqual } from "node:crypto";

export type WorkerAuthResult = { ok: true } | { ok: false; code: string };

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const row = value as Record<string, unknown>;
  return `{${Object.keys(row)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(row[key])}`)
    .join(",")}}`;
}

export function computeWorkerHmac(
  secret: string,
  timestamp: string,
  nonce: string,
  path: string,
  body: unknown,
): string {
  return createHmac("sha256", secret)
    .update(`${timestamp}\n${nonce}\n${path}\n${canonicalJson(body)}`)
    .digest("hex");
}

export function verifyWorkerRequest(input: {
  secret: string | null;
  timestamp: string;
  nonce: string;
  signature: string;
  path: string;
  body: unknown;
  signatureVersion?: string;
  rawBody?: string;
  nowSeconds: number;
  seenNonces: Map<string, number>;
  maxSkewSeconds?: number;
}): WorkerAuthResult {
  if (!input.secret) return { ok: false, code: "AUTOMATION_AUTH_NOT_CONFIGURED" };
  if (!input.timestamp || !input.nonce || !input.signature) {
    return { ok: false, code: "MISSING_AUTOMATION_AUTH" };
  }
  if (!/^[a-f0-9]{32,128}$/i.test(input.nonce)) {
    return { ok: false, code: "INVALID_AUTOMATION_NONCE" };
  }
  if (!/^[a-f0-9]{64}$/i.test(input.signature)) {
    return { ok: false, code: "INVALID_AUTOMATION_SIGNATURE" };
  }
  const timestamp = Number(input.timestamp);
  const maxSkew = input.maxSkewSeconds ?? 60;
  if (!Number.isInteger(timestamp) || Math.abs(input.nowSeconds - timestamp) > maxSkew) {
    return { ok: false, code: "AUTOMATION_TIMESTAMP_SKEW" };
  }
  for (const [nonce, observedAt] of input.seenNonces) {
    if (input.nowSeconds - observedAt > maxSkew * 2) input.seenNonces.delete(nonce);
  }
  if (input.seenNonces.has(input.nonce)) {
    return { ok: false, code: "AUTOMATION_REPLAY" };
  }
  const version = input.signatureVersion ?? "canonical-v1";
  if (version !== "canonical-v1" && version !== "raw-v1") {
    return { ok: false, code: "INVALID_AUTOMATION_SIGNATURE_VERSION" };
  }
  if (version === "raw-v1" && typeof input.rawBody !== "string") {
    return { ok: false, code: "MISSING_AUTOMATION_RAW_BODY" };
  }
  // Python JSON retains 2.0, exponent formatting and escaped Unicode. Verify
  // the transmitted bytes instead of reconstructing them with JS JSON.stringify.
  const expected =
    version === "raw-v1"
      ? createHmac("sha256", input.secret)
          .update(`${input.timestamp}\n${input.nonce}\n${input.path}\n${input.rawBody}`)
          .digest("hex")
      : computeWorkerHmac(input.secret, input.timestamp, input.nonce, input.path, input.body);
  const expectedBytes = Buffer.from(expected, "hex");
  const actualBytes = Buffer.from(input.signature, "hex");
  if (expectedBytes.length !== actualBytes.length || !timingSafeEqual(expectedBytes, actualBytes)) {
    return { ok: false, code: "INVALID_AUTOMATION_SIGNATURE" };
  }
  input.seenNonces.set(input.nonce, input.nowSeconds);
  return { ok: true };
}
