/**
 * Static adapter capability declarations — the compile-time source of truth
 * that mirrors the seeded `venue_capabilities` rows for `source =
 * 'adapter_static'`. Runtime handshake/account-info calls must confirm
 * these before execution; static rows alone are `unverified` and are not
 * sufficient to submit orders.
 *
 * No exchange inherits assumptions. Adding a new exchange requires an
 * explicit entry here AND a matching migration seed row.
 */
import type { CapabilityRecord, Capabilities, MarketType, PositionMode } from "./types";

interface StaticDecl {
  exchange: string;
  adapter_version: string;
  environments: string[];
  market_type: MarketType;
  position_mode: PositionMode;
  capabilities: Capabilities;
}

const STATIC_DECLARATIONS: StaticDecl[] = [
  {
    exchange: "apex_omni",
    adapter_version: "v1",
    environments: ["test", "prod"],
    market_type: "futures",
    position_mode: "one_way",
    capabilities: {
      allowed_margin_modes: ["cross"],
      hedge_supported: false,
      reduce_only: true,
      order_types: ["limit", "market", "limit_maker"],
      leverage_range: { min: 1, max: 100 },
      note: "ApeX Omni USDT perpetuals — cross margin only.",
    },
  },
  {
    exchange: "bydfi",
    adapter_version: "v1",
    environments: ["test", "prod"],
    market_type: "futures",
    position_mode: "one_way",
    capabilities: {
      allowed_margin_modes: ["cross", "isolated"],
      hedge_supported: true,
      reduce_only: true,
      order_types: ["limit", "market"],
      leverage_range: { min: 1, max: 125 },
      requires_runtime_confirmation: true,
    },
  },
  {
    exchange: "btcc",
    adapter_version: "v1",
    environments: ["test", "prod"],
    market_type: "futures",
    position_mode: "one_way",
    capabilities: {
      allowed_margin_modes: ["cross", "isolated"],
      hedge_supported: true,
      reduce_only: true,
      order_types: ["limit", "market"],
      leverage_range: { min: 1, max: 150 },
      requires_runtime_confirmation: true,
    },
  },
];

/** All static declarations, flattened per environment. Pure, safe to cache. */
export function listStaticCapabilities(): CapabilityRecord[] {
  const now = new Date().toISOString();
  return STATIC_DECLARATIONS.flatMap((d) =>
    d.environments.map<CapabilityRecord>((env) => ({
      key: {
        exchange: d.exchange,
        adapter_version: d.adapter_version,
        environment: env,
        market_type: d.market_type,
        position_mode: d.position_mode,
        symbol: null,
      },
      capabilities: d.capabilities,
      source: "adapter_static",
      verification_status: "unverified",
      retrieved_at: now,
      expires_at: null,
      exchange_response_code: null,
      adapter_version: d.adapter_version,
    })),
  );
}

export function findStaticCapability(params: {
  exchange: string;
  environment: string;
  market_type: MarketType;
  position_mode?: PositionMode;
  adapter_version?: string;
}): CapabilityRecord | null {
  const exchange = params.exchange.toLowerCase();
  const environment = params.environment;
  const market_type = params.market_type;
  const position_mode = params.position_mode ?? "one_way";
  const adapter_version = params.adapter_version ?? "v1";
  const rec = listStaticCapabilities().find(
    (r) =>
      r.key.exchange === exchange &&
      r.key.environment === environment &&
      r.key.market_type === market_type &&
      r.key.position_mode === position_mode &&
      r.key.adapter_version === adapter_version,
  );
  return rec ?? null;
}

/** UI helper — the margin modes to show the user before runtime confirmation. */
export function staticAllowedMarginModes(exchange: string): {
  known: boolean;
  modes: readonly ("cross" | "isolated")[];
  locked: boolean;
  reason: string | null;
} {
  const recs = listStaticCapabilities().filter(
    (r) => r.key.exchange === exchange.toLowerCase(),
  );
  if (recs.length === 0) {
    return { known: false, modes: [], locked: true, reason: "VENUE_UNKNOWN" };
  }
  const modes = recs[0]!.capabilities.allowed_margin_modes;
  return {
    known: true,
    modes,
    locked: modes.length === 1,
    reason: modes.length === 1 ? `Required by ${exchange}` : null,
  };
}
