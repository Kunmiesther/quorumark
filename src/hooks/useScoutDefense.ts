/**
 * useScoutDefense — reads the Scout's DEFENSIVE watch tasks.
 *
 * Each row = one OPEN paper position the Scout is guarding. Surfaces the
 * protective structural swing level and whether structure has broken
 * (which triggers Onyx to exit via scout_bos).
 *
 * Also fetches recent ONYX_HANDOFF and SCOUT_BOS bot events so the panel
 * can show the Onyx↔Scout handshake.
 */
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";

export interface DefenseWatchTask {
  positionId: string;
  walletKey: string;
  symbol: string;
  direction: "long" | "short";
  strategy: string;
  entryPrice: number;
  markLastSeenMs: number | null;
  protectiveLevel: number | null;
  protectiveKind: string | null;
  structureBroken: boolean;
  brokenAtMs: number | null;
  brokenLevel: number | null;
  ageMinutes: number;
  rungCount: number;
}

export interface DefenseHandshake {
  handoffs24h: number;
  bosFlags24h: number;
  guarding: number;
  broken: number;
}

export interface ScoutDefenseData {
  watch: DefenseWatchTask[];
  handshake: DefenseHandshake;
}

export function useScoutDefense() {
  const { user } = useAuth();
  return useQuery<ScoutDefenseData>({
    queryKey: ["scout", "defense", user?.id],
    enabled: !!user,
    refetchInterval: 30_000,
    staleTime: 15_000,
    queryFn: async (): Promise<ScoutDefenseData> => {
      const since = new Date(Date.now() - 24 * 3_600_000).toISOString();
      const [posRes, evRes] = await Promise.all([
        supabase
          .from("paper_positions")
          .select("*")
          .eq("user_id", user!.id)
          .eq("status", "open"),
        supabase
          .from("bot_events")
          .select("event")
          .eq("user_id", user!.id)
          .in("event", ["ONYX_HANDOFF", "SCOUT_BOS"])
          .gte("created_at", since)
          .limit(500),
      ]);
      if (posRes.error) throw posRes.error;
      const rows = (posRes.data ?? []) as unknown as Array<Record<string, unknown>>;
      const now = Date.now();
      const watch: DefenseWatchTask[] = rows.map((r) => {
        const entryTs = String(r.entry_ts ?? "");
        const openedMs = entryTs ? new Date(entryTs).getTime() : now;
        return {
          positionId: String(r.id),
          walletKey: String(r.wallet_key ?? ""),
          symbol: String(r.symbol ?? ""),
          direction: (r.direction === "short" ? "short" : "long"),
          strategy: String(r.strategy ?? "accumulator"),
          entryPrice: Number(r.entry_price ?? 0),
          markLastSeenMs: r.last_seen_candle_ts_ms == null ? null : Number(r.last_seen_candle_ts_ms),
          protectiveLevel: r.protective_swing_level == null ? null : Number(r.protective_swing_level),
          protectiveKind: r.protective_swing_kind == null ? null : String(r.protective_swing_kind),
          structureBroken: Boolean(r.structure_broken),
          brokenAtMs: r.structure_broken_ts_ms == null ? null : Number(r.structure_broken_ts_ms),
          brokenLevel: r.structure_broken_level == null ? null : Number(r.structure_broken_level),
          ageMinutes: (now - openedMs) / 60_000,
          rungCount: Number(r.rung_count ?? 1),
        };
      });
      const events = (evRes.data ?? []) as Array<{ event: string }>;
      const handshake: DefenseHandshake = {
        handoffs24h: events.filter((e) => e.event === "ONYX_HANDOFF").length,
        bosFlags24h: events.filter((e) => e.event === "SCOUT_BOS").length,
        guarding: watch.filter((w) => !w.structureBroken).length,
        broken: watch.filter((w) => w.structureBroken).length,
      };
      return { watch, handshake };
    },
  });
}
