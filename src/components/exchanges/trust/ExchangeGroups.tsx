/**
 * Section 2 — Exchange Connections, grouped DEX / CEX.
 *
 * Every venue in the supported catalog is shown, connected or not, so the
 * absence of a connection is a visible fact rather than a missing row. A
 * venue with no connection renders as "Not connected" with a Connect action;
 * it never borrows another venue's status.
 *
 * Per-venue actions reuse the paths that already exist:
 *   Pause / Resume trading -> exchange_connections.is_live (same authority
 *                             as LiveTradingToggle)
 *   Reconnect              -> exchange-credentials { action: "test" }
 *   Disconnect             -> exchange-credentials { action: "disconnect" }
 *   View logs              -> the connection's own error + health record
 *
 * No action here signs, submits, closes, or cancels anything, and no seed
 * phrase or owner-wallet private key is ever requested or displayed.
 */
import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link2Off, Pause, Play, Plug, RefreshCw, ScrollText } from "lucide-react";
import { toast } from "sonner";

import { SurfaceCard } from "@/components/phantom/SurfaceCard";
import {
  ActionButton,
  Eyebrow,
  SectionHeading,
  StatusDot,
  TONE_TEXT,
  relTime,
  type Tone,
} from "@/components/exchanges/trust/primitives";
import { supabase } from "@/integrations/supabase/client";
import { venueLabel, venueLogo } from "@/lib/venue-logos";
import { AUTOMATION_VENUES } from "@/lib/automation/liveVenueReadiness";
import { canUseInternalLiveTrading, liveTradingAvailabilityCopy } from "@/lib/live-trading-policy";
import { useIsOwner } from "@/hooks/useIsOwner";
import { cn } from "@/lib/utils";
import {
  WalletIdentity,
  type WalletIdentityRecord,
} from "@/components/exchanges/ConnectionIdentity";

export interface TrustExchangeRow {
  id: string;
  exchange: string;
  display_name: string | null;
  environment: string;
  status: string;
  permission_read: boolean;
  permission_trade: boolean;
  permissions_verified: boolean;
  withdrawals_disabled: boolean;
  is_live: boolean;
  last_verified_at: string | null;
  last_health_check_at: string | null;
  last_error: string | null;
  last_error_code: string | null;
  last_error_message: string | null;
  created_at: string;
  signer_mainnet_active: boolean;
}

/** The catalog, in the owner-specified order. Shown whether connected or not. */
export const VENUE_GROUPS: { kind: "DEX" | "CEX"; venues: string[] }[] = [
  { kind: "DEX", venues: ["apex_omni", "aster", "synfutures"] },
  { kind: "CEX", venues: ["coinbase", "kraken"] },
];

function connectionTone(row: TrustExchangeRow): { tone: Tone; label: string } {
  if (row.last_error || row.status === "error") return { tone: "down", label: "Error" };
  if (row.status === "paused") return { tone: "warn", label: "Paused" };
  if (row.status !== "verified" && row.status !== "active") {
    return { tone: "warn", label: "Unverified" };
  }
  if (!row.permission_read) return { tone: "warn", label: "No read access" };
  return { tone: "ok", label: "Connected" };
}

function isMainnet(env: string): boolean {
  return env === "mainnet" || env === "production";
}

export function ExchangeGroups({
  rows,
  walletCounts,
  walletsByConnection,
  onSelect,
  selectedId,
  onConnect,
}: {
  rows: TrustExchangeRow[];
  walletCounts: Map<string, number>;
  walletsByConnection: Map<string, WalletIdentityRecord[]>;
  onSelect: (id: string) => void;
  selectedId: string | null;
  onConnect: (venue: string) => void;
}) {
  const byVenue = new Map<string, TrustExchangeRow[]>();
  for (const row of rows) {
    const key = row.exchange.toLowerCase().replace("_testnet", "");
    const list = byVenue.get(key) ?? [];
    list.push(row);
    byVenue.set(key, list);
  }
  // Anything connected that the catalog does not list still gets shown —
  // silently hiding a live connection would be the worst possible omission.
  const catalog = new Set(VENUE_GROUPS.flatMap((g) => g.venues));
  const uncatalogued = [...byVenue.keys()].filter((v) => !catalog.has(v));

  return (
    <div className="space-y-4">
      {VENUE_GROUPS.map((group) => (
        <SurfaceCard key={group.kind}>
          <SectionHeading
            title={group.kind === "DEX" ? "Decentralised venues" : "Centralised venues"}
            subtitle={
              group.kind === "DEX"
                ? "Self-custodied. TurtleBot signs orders; it never holds your keys."
                : "API-key venues. Withdrawal permission is never requested."
            }
            actions={<Eyebrow>{group.kind}</Eyebrow>}
          />
          <div className="grid gap-2.5">
            {group.venues.map((venue) => {
              const connections = byVenue.get(venue) ?? [];
              if (connections.length === 0) {
                return <UnconnectedVenue key={venue} venue={venue} onConnect={() => onConnect(venue)} />;
              }
              return connections.map((row) => (
                <VenueCard
                  key={row.id}
                  row={row}
                  linkedWallets={walletCounts.get(row.id) ?? 0}
                  wallets={walletsByConnection.get(row.id) ?? []}
                  selected={selectedId === row.id}
                  onSelect={() => row.exchange === "synfutures" ? onConnect("synfutures") : onSelect(row.id)}
                />
              ));
            })}
          </div>
        </SurfaceCard>
      ))}

      {uncatalogued.length > 0 && (
        <SurfaceCard>
          <SectionHeading
            title="Other connected venues"
            subtitle="Connected but outside the standard catalog."
          />
          <div className="grid gap-2.5">
            {uncatalogued.flatMap((venue) =>
              (byVenue.get(venue) ?? []).map((row) => (
                <VenueCard
                  key={row.id}
                  row={row}
                  linkedWallets={walletCounts.get(row.id) ?? 0}
                  wallets={walletsByConnection.get(row.id) ?? []}
                  selected={selectedId === row.id}
                  onSelect={() => onSelect(row.id)}
                />
              )),
            )}
          </div>
        </SurfaceCard>
      )}
    </div>
  );
}

function UnconnectedVenue({ venue, onConnect }: { venue: string; onConnect: () => void }) {
  const logo = venueLogo(venue);
  return (
    <div className="flex items-center gap-3 rounded-2xl bg-white/[0.02] p-3.5">
      <div className="flex h-10 w-10 shrink-0 items-center justify-center overflow-hidden rounded-xl bg-black/40 opacity-50">
        {logo ? (
          <img src={logo} alt="" className="h-7 w-7 object-contain" />
        ) : (
          <Plug className="h-4 w-4 text-white/40" />
        )}
      </div>
      <div className="min-w-0 flex-1">
        <p className="truncate text-[13px] font-medium text-white/55">{venueLabel(venue)}</p>
        <p className="mt-0.5 flex items-center gap-1.5 text-[11px] text-white/35">
          <StatusDot tone="idle" />
          Not connected
        </p>
      </div>
      <ActionButton label="Connect" onClick={onConnect} />
    </div>
  );
}

function VenueCard({
  row,
  linkedWallets,
  wallets,
  selected,
  onSelect,
}: {
  row: TrustExchangeRow;
  linkedWallets: number;
  wallets: WalletIdentityRecord[];
  selected: boolean;
  onSelect: () => void;
}) {
  const qc = useQueryClient();
  const [logsOpen, setLogsOpen] = useState(false);
  const { isOwner, isReady: ownerReady } = useIsOwner();
  const liveAvailable = canUseInternalLiveTrading(isOwner);
  const availabilityCopy = liveTradingAvailabilityCopy(isOwner);
  const { tone, label } = connectionTone(row);
  const logo = venueLogo(row.exchange);
  const name = row.display_name ?? venueLabel(row.exchange);
  const mainnet = isMainnet(row.environment);
  // A verified credential and an is_live preference do not prove that the
  // broker/worker has an order path for this venue. Reuse the supported-venue catalog.
  const orderRouteReady = AUTOMATION_VENUES.has(row.exchange);
  const effectiveLive =
    orderRouteReady && row.is_live && row.permission_trade && row.permissions_verified;

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["exchange-connections-full"] });
    qc.invalidateQueries({ queryKey: ["trust-center-feed"] });
  };

  const setLive = useMutation({
    mutationFn: async (next: boolean) => {
      if (next && !liveAvailable) {
        throw new Error(availabilityCopy);
      }
      const { error } = await supabase
        .from("exchange_connections")
        .update({ is_live: next })
        .eq("id", row.id);
      if (error) throw error;
      return next;
    },
    onSuccess: (next) => {
      toast.success(
        next
          ? orderRouteReady
            ? `${name} resumed live trading.`
            : `${name} live preference saved; order route unavailable.`
          : `${name} paused.`,
      );
      invalidate();
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Could not update."),
  });

  const reconnect = useMutation({
    mutationFn: async () => {
      const { data, error } = await supabase.functions.invoke("exchange-credentials", {
        body: { action: "test", connection_id: row.id },
      });
      if (error) throw new Error("Could not run the connection test.");
      return data as { ok?: boolean; message?: string } | null;
    },
    onSuccess: (payload) => {
      if (payload?.ok) toast.success(`${name} verified.`);
      else
        toast.message("Not verified", {
          description: payload?.message ?? "The venue did not confirm.",
        });
      invalidate();
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Test failed."),
  });

  const disconnect = useMutation({
    mutationFn: async () => {
      const { data, error } = await supabase.functions.invoke("exchange-credentials", {
        body: { action: "disconnect", connection_id: row.id },
      });
      const payload = data as { ok?: boolean; message?: string } | null;
      if (error || !payload?.ok) throw new Error(payload?.message ?? "Could not disconnect.");
    },
    onSuccess: () => {
      toast.success(`${name} disconnected.`);
      invalidate();
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Could not disconnect."),
  });

  return (
    <article
      className={cn(
        "rounded-2xl bg-white/[0.04] p-3.5 transition",
        selected && "bg-white/[0.08] ring-1 ring-[color:var(--accent)]/40",
      )}
    >
      <button type="button" onClick={onSelect} className="flex w-full items-start gap-3 text-left">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center overflow-hidden rounded-xl bg-black/40">
          {logo ? (
            <img src={logo} alt="" className="h-7 w-7 object-contain" />
          ) : (
            <Plug className="h-4 w-4 text-white/50" />
          )}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <h3 className="truncate text-[13.5px] font-semibold text-white">{name}</h3>
            <span
              className={cn("flex items-center gap-1.5 text-[11px] font-semibold", TONE_TEXT[tone])}
            >
              <StatusDot tone={tone} />
              {label}
            </span>
          </div>
          <p className="mt-1 font-mono text-[10px] text-white/45" title={row.id}>
            Account {row.id.slice(0, 8)}… · {venueLabel(row.exchange)}
          </p>
          <div className="mt-2 flex flex-wrap gap-x-4 gap-y-2">
            {wallets.length ? (
              wallets.map((wallet) => <WalletIdentity key={wallet.id} wallet={wallet} />)
            ) : (
              <WalletIdentity />
            )}
          </div>
          <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[10.5px] text-white/45">
            <span className={mainnet ? "text-amber-200/80" : ""}>
              {mainnet ? "Mainnet" : "Testnet"}
            </span>
            <span>
              {linkedWallets > 0
                ? `${linkedWallets} wallet${linkedWallets === 1 ? "" : "s"}`
                : "No wallet linked"}
            </span>
            <span>
              {row.permission_trade && row.permissions_verified
                ? "Trading authorized"
                : "Trading not authorized"}
            </span>
            <span>
              {row.permissions_verified ? "Permissions verified" : "Permissions unverified"}
            </span>
            <span className="tabular-nums">Health {relTime(row.last_health_check_at)}</span>
          </div>
        </div>
        {row.is_live && (
          <span
            className={cn(
              "shrink-0 rounded-md px-1.5 py-0.5 text-[9.5px] font-bold uppercase tracking-widest",
              effectiveLive
                ? "bg-emerald-500/15 text-emerald-200"
                : "bg-amber-500/15 text-amber-200",
            )}
          >
            {effectiveLive ? "Live" : orderRouteReady ? "Blocked" : "No order route"}
          </span>
        )}
      </button>

      <div className="mt-3 flex flex-wrap gap-1.5">
        {row.is_live ? (
          <ActionButton
            label="Pause trading"
            icon={<Pause className="h-3 w-3" />}
            pending={setLive.isPending}
            onClick={() => setLive.mutate(false)}
          />
        ) : (
          <ActionButton
            label="Resume trading"
            icon={<Play className="h-3 w-3" />}
            pending={setLive.isPending}
            disabled={
              !ownerReady ||
              !liveAvailable ||
              !mainnet ||
              !row.permissions_verified ||
              !row.permission_trade
            }
            disabledReason={
              !liveAvailable
                ? availabilityCopy
                : !mainnet
                  ? "Live routing applies to mainnet connections only."
                  : "Verify trading permission on this connection first."
            }
            onClick={() => setLive.mutate(true)}
          />
        )}
        <ActionButton
          label="Reconnect"
          icon={<RefreshCw className="h-3 w-3" />}
          pending={reconnect.isPending}
          onClick={() => row.exchange === "synfutures" ? onSelect() : reconnect.mutate()}
        />
        <ActionButton
          label="View logs"
          icon={<ScrollText className="h-3 w-3" />}
          onClick={() => setLogsOpen((v) => !v)}
        />
        <ActionButton
          label="Disconnect"
          icon={<Link2Off className="h-3 w-3" />}
          danger
          pending={disconnect.isPending}
          onClick={() => disconnect.mutate()}
        />
      </div>

      {logsOpen && (
        <div className="mt-3 space-y-1.5 rounded-xl bg-black/40 p-3 font-mono text-[10.5px] leading-relaxed text-white/60">
          <LogLine label="status" value={row.status} />
          <LogLine label="environment" value={row.environment} />
          <LogLine label="last_verified_at" value={row.last_verified_at ?? "never"} />
          <LogLine label="last_health_check_at" value={row.last_health_check_at ?? "never"} />
          <LogLine label="permissions_verified" value={String(row.permissions_verified)} />
          <LogLine label="withdrawals_disabled" value={String(row.withdrawals_disabled)} />
          {row.last_error_code && (
            <LogLine label="last_error_code" value={row.last_error_code} tone="down" />
          )}
          {(row.last_error_message ?? row.last_error) && (
            <LogLine
              label="last_error"
              value={row.last_error_message ?? row.last_error!}
              tone="down"
            />
          )}
          {!row.last_error && !row.last_error_code && (
            <p className="text-emerald-300/70">no errors recorded</p>
          )}
        </div>
      )}

      {(row.last_error_message ?? row.last_error) && !logsOpen && (
        <p className="mt-2 truncate rounded-xl bg-red-500/[0.08] px-2.5 py-1.5 text-[11px] text-red-200">
          {row.last_error_message ?? row.last_error}
        </p>
      )}
    </article>
  );
}

function LogLine({ label, value, tone }: { label: string; value: string; tone?: Tone }) {
  return (
    <p className="flex gap-2">
      <span className="shrink-0 text-white/35">{label}</span>
      <span className={cn("min-w-0 break-all", tone === "down" ? "text-red-300" : "text-white/75")}>
        {value}
      </span>
    </p>
  );
}
