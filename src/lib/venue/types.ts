/**
 * Venue Capability Registry — public types.
 *
 * A capability record describes what a specific (exchange, adapter version,
 * environment, market/product, position mode, symbol?) is allowed to do at
 * a specific verification snapshot in time. Unknown/unverified values fail
 * closed at preflight time; there are no silent coercions.
 */

export type MarginMode = "cross" | "isolated";
export type PositionMode = "one_way" | "hedge" | "unknown";
export type MarketType = "spot" | "futures" | "margin" | "unknown";
export type CapabilitySource =
  | "adapter_static"
  | "handshake"
  | "account_info"
  | "product_metadata";
export type VerificationStatus =
  | "verified"
  | "unverified"
  | "stale"
  | "degraded"
  | "rejected";

/** The immutable identity of a capability lookup scope. */
export interface CapabilityKey {
  exchange: string;
  adapter_version: string;
  environment: string; // "test" | "prod" | vendor tag
  market_type: MarketType;
  position_mode: PositionMode;
  /** null = product-wide; otherwise the exchange's canonical symbol. */
  symbol: string | null;
}

/** The declared/observed capabilities for that scope. */
export interface Capabilities {
  allowed_margin_modes: MarginMode[];
  hedge_supported: boolean;
  reduce_only: boolean;
  order_types: string[];
  leverage_range: { min: number; max: number };
  tick_size?: number;
  qty_step?: number;
  min_qty?: number;
  min_notional?: number;
  rate_limits?: { orders_per_sec?: number; window_ms?: number };
  requires_runtime_confirmation?: boolean;
  note?: string;
}

export interface CapabilityRecord {
  key: CapabilityKey;
  capabilities: Capabilities;
  source: CapabilitySource;
  verification_status: VerificationStatus;
  retrieved_at: string; // ISO
  expires_at: string | null;
  exchange_response_code: string | null;
  adapter_version: string;
}

// ─── Preflight ────────────────────────────────────────────────────────

export type PreflightRejectionCode =
  | "MARGIN_MODE_UNSUPPORTED"
  | "MARGIN_MODE_MISSING"
  | "POSITION_MODE_UNSUPPORTED"
  | "HEDGE_MODE_UNSUPPORTED"
  | "SYMBOL_UNSUPPORTED"
  | "LEVERAGE_OUT_OF_RANGE"
  | "ORDER_TYPE_UNSUPPORTED"
  | "REDUCE_ONLY_UNSUPPORTED"
  | "TICK_SIZE_MISMATCH"
  | "QTY_STEP_MISMATCH"
  | "MIN_QTY_NOT_MET"
  | "MIN_NOTIONAL_NOT_MET"
  | "CAPABILITY_STALE"
  | "CAPABILITY_MISSING"
  | "CAPABILITY_UNVERIFIED_FOR_EXECUTION"
  | "CAPABILITY_REJECTED"
  | "VENUE_UNKNOWN";

export interface PreflightIntent {
  exchange: string;
  adapter_version?: string;
  environment?: string;
  market_type: MarketType;
  position_mode?: PositionMode;
  symbol: string;
  direction: "long" | "short";
  margin_mode: MarginMode | string | null | undefined;
  leverage: number;
  order_type: string;
  qty?: number;
  price?: number;
  reduce_only?: boolean;
  /**
   * Require verified capability rows for execution. Preview/UI lookups can
   * pass false to inspect static declarations.
   */
  require_verified?: boolean;
  /** Explicitly opting into hedge (opposite-side simultaneous position). */
  requests_hedge?: boolean;
}

export interface PreflightPass {
  ok: true;
  capability: CapabilityRecord;
  resolved_margin_mode: MarginMode;
}

export interface PreflightFail {
  ok: false;
  code: PreflightRejectionCode;
  message: string;
  capability: CapabilityRecord | null;
}

export type PreflightResult = PreflightPass | PreflightFail;
