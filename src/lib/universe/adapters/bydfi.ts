/**
 * BYDFi universe adapter.
 *
 * Fails closed (empty universe, health='unverified') until the owner runs a
 * successful authenticated handshake for this exchange. Once verified, the
 * per-connection `bydfi_verified_universe` cache seeds the dynamic universe
 * pipeline with real venue metadata.
 *
 * IMPORTANT: this adapter does not accept credentials, sign requests, or
 * touch any order path. Handshake + persistence live in
 * `src/lib/exchanges/bydfi.functions.ts`.
 */
import type { UniverseAdapter, VerifiedInstrument, VerifiedUniverse } from "../types";

// Bumped once the runtime handshake landed; incrementing this invalidates
// any cached capability_version comparisons.
const ADAPTER_VERSION = 1;
const CAPABILITY_VERSION = 1;

export const bydfiAdapter: UniverseAdapter = {
  exchange: "bydfi",
  adapterVersion: ADAPTER_VERSION,
  async discover({ environment, marketType, now }) {
    const generatedAt = now ?? Date.now();
    let instruments: VerifiedInstrument[] = [];
    let health: VerifiedUniverse["health"] = "unverified";
    const detail: Record<string, string | number | boolean | null> = {
      note: "BYDFi universe is empty until the owner completes the read-only handshake.",
    };

    // Client-safe read: only server callers (with service role) will populate
    // this; RLS gates browser access to the caller's own connections.
    try {
      const { supabase } = await import("@/integrations/supabase/client");
      const query = (supabase as unknown as {
        from: (t: string) => {
          select: (c: string) => {
            eq: (k: string, v: unknown) => Promise<{ data: unknown; error: unknown }>;
          };
        };
      })
        .from("bydfi_verified_universe")
        .select("symbol,venue_symbol,base,quote,tradable,max_leverage,tick_size,min_qty,min_notional,volume_24h_usd,verified_at")
        .eq("tradable", true);

      // Connection discovery must never hang the universe pipeline. A slow or
      // unreachable cache is unverified, not healthy. Keep the timeout below
      // the worker's scan budget and fail closed with an exact reason.
      const q = await Promise.race([
        query,
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("bydfi_capability_query_timeout")), 1_500),
        ),
      ]);
      const rows = (q?.data as Array<Record<string, unknown>> | undefined) ?? [];
      if (rows.length > 0) {
        instruments = rows.map((r) => ({
          symbol: String(r.symbol),
          venueSymbol: String(r.venue_symbol),
          base: String(r.base),
          quote: String(r.quote),
          tradable: Boolean(r.tradable),
          maxLeverage: r.max_leverage == null ? null : Number(r.max_leverage),
          tickSize: r.tick_size == null ? null : Number(r.tick_size),
          minQty: r.min_qty == null ? null : Number(r.min_qty),
          minNotional: r.min_notional == null ? null : Number(r.min_notional),
          volume24hUsd: r.volume_24h_usd == null ? null : Number(r.volume_24h_usd),
          spreadBps: null,
          ageMs: 0,
        }));
        health = "healthy";
        detail.source = "bydfi_verified_universe";
      } else {
        detail.reason = "no_verified_connection";
      }
    } catch (e) {
      detail.reason = "adapter_query_failed";
      detail.error = (e as Error)?.message?.slice(0, 240) ?? "unknown";
    }

    return {
      exchange: "bydfi",
      environment,
      marketType,
      adapterVersion: ADAPTER_VERSION,
      capabilityVersion: CAPABILITY_VERSION,
      health,
      instruments,
      detail,
      generatedAt,
    };
  },
};
