// Pure, unit-testable guard logic for the execution-broker.
//
// POSTURE:
//   - Mainnet execution is gated by the owner-controlled APEX_MAINNET_*
//     flags (see _shared/mainnet-flags.ts). When `mainnetEnabled=false`
//     (default), any is_live=true intent / mainnet venue / mainnet
//     environment is rejected as MAINNET_DISABLED — identical to the
//     historical hard lock. When the owner flips the flags on,
//     `mainnetEnabled=true` is passed and live intents flow through.
//   - The proof path (testnet_proof against apex_omni_testnet) is
//     unchanged and continues to work with `mainnetEnabled` either way.
//   - This gate is one of several layers. The Railway broker and signer
//     still independently enforce APEX_MAINNET_SIGNER_ENABLED /
//     APEX_MAINNET_CANARY_ENABLED. A `true` here means "policy layer
//     allows this shape"; it does NOT mean any specific order is
//     guaranteed to execute.

export const PROOF_TEST_SYMBOL = "BTC-USDT";
export const PROOF_VENUE = "apex_omni_testnet";
export const PROOF_PURPOSE = "testnet_proof";

export interface ProofIntentInput {
  purpose?: string | null;
  venue: string;
  symbol: string;
  reduce_only: boolean;
  is_live: boolean;
  size: number;
  proof_token?: string | null;
  confirmation_token?: string | null;
}

export interface BrokerConfigInput {
  enabled: boolean;
  exchange_type: string | null;
  environment?: string | null;
  permission_trade: boolean;
  permissions_verified: boolean;
}

export type GateReject =
  | "INVALID_SIGNATURE"
  | "MAINNET_DISABLED"
  | "CONFIG_DISABLED"
  | "REJECT_NON_TESTNET_VENUE"
  | "REJECT_NON_TESTNET_CONNECTION"
  | "REJECT_SYMBOL_NOT_ALLOWED"
  | "REJECT_REDUCE_ONLY_FORBIDDEN"
  | "REJECT_LIVE_FORBIDDEN_FOR_PROOF"
  | "REJECT_TOKEN_INVALID"
  | "REJECT_MIN_SIZE_UNKNOWN"
  | "REJECT_SIZE_NOT_EXCHANGE_MIN";

export type GateDecision =
  | { ok: true; path: "proof"; requiresTokenConsume: true }
  | { ok: true; path: "enabled"; requiresTokenConsume: false }
  | { ok: true; path: "live"; requiresTokenConsume: false }
  | { ok: false; reason: GateReject };

export function isProofIntent(purpose: string | null | undefined): boolean {
  return purpose === PROOF_PURPOSE;
}

/**
 * Pure gate decision. Does NOT consume tokens or call the DB; the broker must
 * perform the atomic consume AFTER receiving `{ ok: true, path: "proof" }`.
 *
 * `mainnetEnabled` reflects the current APEX_MAINNET_* flag posture at the
 * broker (owner-controlled). When false, behavior matches the historical
 * hard lock. When true, live/mainnet intents are permitted through this
 * layer; downstream signer/adapter gates still apply.
 */
export function evaluateGate(input: {
  intent: ProofIntentInput;
  cfg: BrokerConfigInput;
  signatureValid: boolean;
  minOrderSize: number | null;
  mainnetEnabled?: boolean;
}): GateDecision {
  const { intent, cfg, signatureValid, minOrderSize } = input;
  const mainnetEnabled = input.mainnetEnabled === true;

  if (!signatureValid) return { ok: false, reason: "INVALID_SIGNATURE" };

  const intentIsMainnet =
    intent.is_live === true ||
    intent.purpose === "live_proof" ||
    (intent.venue !== PROOF_VENUE) ||
    (cfg.exchange_type !== null && cfg.exchange_type !== PROOF_VENUE) ||
    (!!cfg.environment && cfg.environment.toLowerCase() !== "testnet");

  if (intentIsMainnet) {
    if (!mainnetEnabled) return { ok: false, reason: "MAINNET_DISABLED" };
    // Owner has enabled the mainnet flags. Require the caller cfg to actually
    // be provisioned for trading (permissions_verified + permission_trade are
    // already checked upstream in the broker). We route as `live`; the broker
    // is responsible for further downstream authorization.
    if (!cfg.enabled) return { ok: false, reason: "CONFIG_DISABLED" };
    return { ok: true, path: "live", requiresTokenConsume: false };
  }

  const proof = isProofIntent(intent.purpose);

  if (!proof) {
    // Non-testnet_proof intents against a testnet connection: allow only when
    // enabled=true.
    if (!cfg.enabled) return { ok: false, reason: "CONFIG_DISABLED" };
    return { ok: true, path: "enabled", requiresTokenConsume: false };
  }

  // testnet_proof — apply every proof constraint.
  if (intent.symbol !== PROOF_TEST_SYMBOL) {
    return { ok: false, reason: "REJECT_SYMBOL_NOT_ALLOWED" };
  }
  if (intent.reduce_only) {
    return { ok: false, reason: "REJECT_REDUCE_ONLY_FORBIDDEN" };
  }
  const token = (intent.proof_token ?? "").trim();
  if (!token) return { ok: false, reason: "REJECT_TOKEN_INVALID" };

  if (minOrderSize === null || !Number.isFinite(minOrderSize) || minOrderSize <= 0) {
    return { ok: false, reason: "REJECT_MIN_SIZE_UNKNOWN" };
  }
  const eps = Math.max(1e-12, minOrderSize * 1e-9);
  if (Math.abs(intent.size - minOrderSize) > eps) {
    return { ok: false, reason: "REJECT_SIZE_NOT_EXCHANGE_MIN" };
  }

  return { ok: true, path: "proof", requiresTokenConsume: true };
}


/**
 * Parse the ApeX Omni `/api/v3/symbols` payload and extract the minimum order
 * size (base units) for the given symbol. Returns null if absent/malformed —
 * caller MUST reject with REJECT_MIN_SIZE_UNKNOWN, never guess a size.
 */
export function extractMinOrderSize(symbolsBody: unknown, symbol: string): number | null {
  if (!symbolsBody || typeof symbolsBody !== "object") return null;
  const root = symbolsBody as Record<string, unknown>;
  const data = (root["data"] ?? root) as Record<string, unknown>;

  const candidates: Array<Record<string, unknown>> = [];
  const push = (v: unknown) => {
    if (Array.isArray(v)) for (const it of v) if (it && typeof it === "object") candidates.push(it as Record<string, unknown>);
  };
  push((data as Record<string, unknown>)["perpetualContract"]);
  push((data as Record<string, unknown>)["contractConfig"]);
  const cc = (data as Record<string, unknown>)["contractConfig"];
  if (cc && typeof cc === "object") push((cc as Record<string, unknown>)["perpetualContract"]);
  push(data);

  const match = candidates.find(
    (c) => String((c as Record<string, unknown>)["symbol"] ?? "").toUpperCase() === symbol.toUpperCase(),
  );
  if (!match) return null;
  const raw =
    (match["minOrderSize"] as unknown) ??
    (match["minOrderQty"] as unknown) ??
    (match["minSize"] as unknown) ??
    (match["stepSize"] as unknown);
  if (raw === undefined || raw === null || raw === "") return null;
  const n = typeof raw === "number" ? raw : Number(String(raw));
  return Number.isFinite(n) && n > 0 ? n : null;
}
