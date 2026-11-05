/**
 * Preflight the order intent against a resolved capability record.
 *
 * Pure — no I/O. Callers load a fresh `CapabilityRecord` from the DB (or
 * `findStaticCapability` for preview UIs) and pass it in. Any unknown or
 * stale/missing input rejects. Never coerces margin mode.
 */
import type {
  CapabilityRecord,
  MarginMode,
  PreflightIntent,
  PreflightRejectionCode,
  PreflightResult,
} from "./types";

const DEFAULT_MAX_AGE_MS = 60 * 60 * 1000; // 1h

function fail(
  code: PreflightRejectionCode,
  message: string,
  capability: CapabilityRecord | null = null,
): PreflightResult {
  return { ok: false, code, message, capability };
}

export function preflightOrder(
  intent: PreflightIntent,
  capability: CapabilityRecord | null,
  opts: { now?: Date; maxAgeMs?: number } = {},
): PreflightResult {
  const now = opts.now ?? new Date();
  const maxAge = opts.maxAgeMs ?? DEFAULT_MAX_AGE_MS;

  if (!capability) return fail("CAPABILITY_MISSING", `no capability for ${intent.exchange}`);
  if (capability.verification_status === "rejected")
    return fail("CAPABILITY_REJECTED", "exchange rejected last verification", capability);
  if (capability.verification_status === "stale")
    return fail("CAPABILITY_STALE", "capability marked stale", capability);

  const requireVerified = intent.require_verified ?? true;
  if (requireVerified && capability.verification_status !== "verified")
    return fail(
      "CAPABILITY_UNVERIFIED_FOR_EXECUTION",
      `capability status=${capability.verification_status}; execution requires verified`,
      capability,
    );

  // Freshness.
  const retrievedMs = Date.parse(capability.retrieved_at);
  if (!Number.isFinite(retrievedMs))
    return fail("CAPABILITY_STALE", "capability retrieved_at unparsable", capability);
  const ageMs = now.getTime() - retrievedMs;
  if (ageMs > maxAge)
    return fail("CAPABILITY_STALE", `capability age ${ageMs}ms > max ${maxAge}ms`, capability);
  if (capability.expires_at && Date.parse(capability.expires_at) < now.getTime())
    return fail("CAPABILITY_STALE", "capability expired", capability);

  // Venue known?
  if (capability.key.exchange.toLowerCase() !== intent.exchange.toLowerCase())
    return fail("VENUE_UNKNOWN", "exchange mismatch", capability);

  // Margin mode.
  const raw = intent.margin_mode;
  if (raw == null || raw === "")
    return fail("MARGIN_MODE_MISSING", "intent.margin_mode required", capability);
  if (raw !== "cross" && raw !== "isolated")
    return fail(
      "MARGIN_MODE_UNSUPPORTED",
      `unknown margin_mode=${String(raw)}`,
      capability,
    );
  const mode = raw as MarginMode;
  if (!capability.capabilities.allowed_margin_modes.includes(mode))
    return fail(
      "MARGIN_MODE_UNSUPPORTED",
      `${capability.key.exchange} does not allow ${mode}; allowed=${capability.capabilities.allowed_margin_modes.join(",")}`,
      capability,
    );

  // Position/hedge mode.
  if (intent.requests_hedge && !capability.capabilities.hedge_supported)
    return fail(
      "HEDGE_MODE_UNSUPPORTED",
      `${capability.key.exchange} does not support hedge mode`,
      capability,
    );
  if (intent.position_mode === "hedge" && !capability.capabilities.hedge_supported)
    return fail("POSITION_MODE_UNSUPPORTED", "hedge position mode not supported", capability);

  // Leverage.
  const { min, max } = capability.capabilities.leverage_range;
  if (!(intent.leverage >= min && intent.leverage <= max))
    return fail(
      "LEVERAGE_OUT_OF_RANGE",
      `leverage ${intent.leverage}x outside ${min}–${max}x`,
      capability,
    );

  // Order type.
  if (!capability.capabilities.order_types.includes(intent.order_type))
    return fail(
      "ORDER_TYPE_UNSUPPORTED",
      `order_type=${intent.order_type} not in ${capability.capabilities.order_types.join(",")}`,
      capability,
    );

  // Reduce-only.
  if (intent.reduce_only && !capability.capabilities.reduce_only)
    return fail("REDUCE_ONLY_UNSUPPORTED", "venue does not honor reduce_only", capability);

  // Tick / qty rules (only when the capability advertises them).
  const caps = capability.capabilities;
  if (caps.tick_size && intent.price != null) {
    const ratio = intent.price / caps.tick_size;
    if (Math.abs(ratio - Math.round(ratio)) > 1e-9)
      return fail("TICK_SIZE_MISMATCH", `price ${intent.price} not on tick ${caps.tick_size}`, capability);
  }
  if (caps.qty_step && intent.qty != null) {
    const ratio = intent.qty / caps.qty_step;
    if (Math.abs(ratio - Math.round(ratio)) > 1e-9)
      return fail("QTY_STEP_MISMATCH", `qty ${intent.qty} not on step ${caps.qty_step}`, capability);
  }
  if (caps.min_qty && intent.qty != null && intent.qty < caps.min_qty)
    return fail("MIN_QTY_NOT_MET", `qty ${intent.qty} < min ${caps.min_qty}`, capability);
  if (caps.min_notional && intent.qty != null && intent.price != null) {
    const notional = intent.qty * intent.price;
    if (notional < caps.min_notional)
      return fail("MIN_NOTIONAL_NOT_MET", `notional ${notional} < min ${caps.min_notional}`, capability);
  }

  return { ok: true, capability, resolved_margin_mode: mode };
}
