// TurtleBot Trust Center — the canonical exchange surface.
//
// This page answers exactly one question: "can I trust TurtleBot with my
// money right now?" Five sections, in the order a person actually asks:
//
//   1. System status      is anything broken?
//   2. Connections        is my exchange connected, and can I control it?
//   3. Trust monitor      is anything actually happening?
//   4. Safety center      can I stop it, and what are my limits?
//   5. Account health     what is my money doing?
//
// UNIFIED PHANTOM SHELL: CinematicHero + SurfaceCard, tokens --accent /
// --positive / --negative. Unchanged from the previous Exchange hub.
//
// EVERY PRE-EXISTING CAPABILITY IS PRESERVED: the connections query, the
// ApeX detail panel (LiveTradingToggle, ProofOfLifeButton, ApexFundingCard,
// ApexActivateSigning), wallets, the API-key sheet, and the guarantees.
//
// HONESTY RULES: no figure is invented, missing data renders as an em dash
// rather than a zero, and no control is shown as available when it is not.

import { createFileRoute, redirect } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { exchangeWalletIdentitiesQuery } from "@/hooks/exchangeWalletIdentities";
import { connectedWallets } from "@/lib/wallet/accountIdentity";
import { AlertTriangle, KeyRound, ShieldAlert, ShieldCheck } from "lucide-react";

import { CinematicHero } from "@/components/shell/CinematicHero";
import { ProfileAvatar } from "@/components/shell/ProfileAvatar";
import { SurfaceCard } from "@/components/phantom/SurfaceCard";
import { ExchangeConnectionsSheet } from "@/components/turtle/ExchangeConnectionsSheet";
import { AddWalletModal } from "@/components/wallet/AddWalletModal";
import { WalletsSection } from "@/components/wallet/WalletsSection";
import { ApexActivateSigning } from "@/components/exchanges/ApexActivateSigning";
import { ApexFundingCard } from "@/components/exchanges/ApexFundingCard";
import { LiveTradingToggle } from "@/components/exchanges/LiveTradingToggle";
import { ProofOfLifeButton } from "@/components/exchanges/ProofOfLifeButton";
import { QUORUMARK_MVP_SURFACES_ONLY } from "@/lib/live-trading-policy";
import { SystemStatusPanel } from "@/components/exchanges/trust/SystemStatusPanel";
import { TrustMonitorPanel } from "@/components/exchanges/trust/TrustMonitorPanel";
import { SafetyCenterPanel } from "@/components/exchanges/trust/SafetyCenterPanel";
import {
  AccountHealthPanel,
  useAccountSummary,
} from "@/components/exchanges/trust/AccountHealthPanel";
import { ExchangeGroups, type TrustExchangeRow } from "@/components/exchanges/trust/ExchangeGroups";
import { VenueReadinessPanel } from "@/components/exchanges/trust/VenueReadinessPanel";
import { SynFuturesSdkPanel } from "@/components/exchanges/trust/SynFuturesSdkPanel";
import { BlockchainNetworks } from "@/components/exchanges/trust/BlockchainNetworks";
import {
  SectionHeading,
  StatusDot,
  fmtUsd,
  relTime,
} from "@/components/exchanges/trust/primitives";
import commandHero from "@/assets/command-hero.png.asset.json";

import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { useIsOwner } from "@/hooks/useIsOwner";
import { useWalletList } from "@/hooks/useWalletList";
import { useTrustCenter } from "@/hooks/useTrustCenter";
import { venueLabel } from "@/lib/venue-logos";

export const Route = createFileRoute("/_authenticated/exchanges")({
  beforeLoad: () => {
    if (QUORUMARK_MVP_SURFACES_ONLY) throw redirect({ to: "/home" });
  },
  validateSearch: (search: Record<string, unknown>): { activation?: "synfutures" } =>
    search.activation === "synfutures" ? { activation: "synfutures" } : {},
  component: TrustCenterPage,
  head: () => ({
    meta: [
      { title: "Trust Center — TurtleBot" },
      {
        name: "description",
        content:
          "Live system status, exchange connections, execution heartbeat, safety controls and account health — everything you need before letting TurtleBot trade.",
      },
    ],
  }),
});

type ExchangeRow = TrustExchangeRow & {
  signer_testnet_active: boolean;
  signer_fingerprint: string | null;
};

/** Coerce a nullable numeric column. Anything unusable stays null, never 0. */
function num(v: unknown): number | null {
  const n = typeof v === "string" ? Number(v) : v;
  return typeof n === "number" && Number.isFinite(n) ? n : null;
}

function TrustCenterPage() {
  const { activation } = Route.useSearch();
  const { user } = useAuth();
  const { isOwner } = useIsOwner();
  const wallets = useWalletList();
  const [manageOpen, setManageOpen] = useState(false);
  const [manageVenue, setManageVenue] = useState<string | undefined>();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [addWalletOpen, setAddWalletOpen] = useState(false);
  const userId = user?.id;

  // UNCHANGED from the previous page — same query key, same columns, same
  // signer-status join. Anything reading `exchange-connections-full`
  // elsewhere keeps working.
  const connectionsQ = useQuery({
    queryKey: ["exchange-connections-full", userId],
    enabled: Boolean(userId),
    refetchInterval: 30_000,
    queryFn: async (): Promise<ExchangeRow[]> => {
      if (!userId) return [];
      const { data, error } = await supabase
        .from("exchange_connections")
        .select(
          "id, exchange, display_name, environment, status, permission_read, permission_trade, permissions_verified, withdrawals_disabled, is_live, last_verified_at, last_health_check_at, last_error, last_error_code, last_error_message, created_at",
        )
        .eq("user_id", userId)
        .neq("status", "disconnected")
        .order("created_at", { ascending: false });
      if (error) throw error;

      const rows = data ?? [];
      const ids = rows.map((row) => row.id).filter((id): id is string => typeof id === "string");
      const { data: signerRows, error: signerError } = ids.length
        ? await supabase
            .from("apex_execution_credentials_status")
            .select(
              "exchange_connection_id, environment, active, revoked_at, credential_fingerprint",
            )
            .eq("user_id", userId)
            .in("exchange_connection_id", ids)
        : { data: [], error: null };
      if (signerError) throw signerError;

      return rows.map((row) => {
        const activeSignerRows = (signerRows ?? []).filter(
          (s) => s.exchange_connection_id === row.id && s.active === true && !s.revoked_at,
        );
        const mainnetSigner = activeSignerRows.find((s) => s.environment === "mainnet");
        const testnetSigner = activeSignerRows.find((s) => s.environment === "testnet");
        return {
          ...row,
          signer_mainnet_active: Boolean(mainnetSigner),
          signer_testnet_active: Boolean(testnetSigner),
          signer_fingerprint: mainnetSigner?.credential_fingerprint ?? null,
        };
      }) as ExchangeRow[];
    },
  });

  const rows = useMemo(() => connectionsQ.data ?? [], [connectionsQ.data]);
  const trust = useTrustCenter(rows);
  const walletIdentities = useQuery(exchangeWalletIdentitiesQuery(userId));
  const walletsByConnection = useMemo(
    () =>
      new Map(
        rows.map((row) => [
          row.id,
          connectedWallets(
            wallets.items.map((wallet) => wallet.row),
            row.id,
            walletIdentities.data ?? [],
          ),
        ]),
      ),
    [rows, wallets.items, walletIdentities.data],
  );

  const walletCounts = useMemo(() => {
    const map = new Map<string, number>();
    for (const [id, linked] of walletsByConnection) map.set(id, linked.length);
    return map;
  }, [walletsByConnection]);

  // The connection the account panels read from: the live mainnet ApeX
  // connection when one exists, else whatever the owner selected.
  const preferredApexRow =
    rows.find(
      (r) =>
        r.exchange.toLowerCase().startsWith("apex") &&
        (r.environment === "mainnet" || r.environment === "production") &&
        r.status === "verified",
    ) ?? rows.find((r) => r.exchange.toLowerCase().startsWith("apex"));
  const defaultRow = preferredApexRow ?? rows[0] ?? null;
  const selectedRow = rows.find((r) => r.id === selectedId) ?? defaultRow;

  const liveConnectionIds = rows.filter((r) => r.is_live).map((r) => r.id);
  const safetyConnectionIds = rows
    .filter(
      (r) =>
        r.exchange === "apex_omni" &&
        (r.environment === "mainnet" || r.environment === "production") &&
        r.status === "verified" &&
        r.permission_trade === true &&
        r.permissions_verified === true,
    )
    .map((r) => r.id);

  // The owner's own configured limits, from the same table the Safety
  // Controls panel writes. Absent row = no limit configured, which renders
  // as a blank rather than an invented ceiling.
  const limitsQ = useQuery({
    queryKey: ["user-trading-limits", userId],
    enabled: Boolean(userId),
    queryFn: async () => {
      const { data, error } = await supabase
        .from("user_trading_limits")
        .select("max_leverage, max_total_exposure_usd, daily_loss_limit_usd")
        .eq("user_id", userId!)
        .maybeSingle();
      if (error) throw error;
      return data;
    },
  });
  const summaryQ = useAccountSummary(selectedRow?.id ?? null);
  const summary = summaryQ.data?.summary ?? null;
  const liveVenueCount = rows.filter(
    (row) => row.is_live && row.permission_trade && row.permissions_verified,
  ).length;

  const apexUnverified = rows.filter(
    (r) =>
      r.exchange.toLowerCase().startsWith("apex") &&
      r.permission_trade &&
      (!r.permissions_verified ||
        ((r.environment === "mainnet" || r.environment === "production") &&
          !r.signer_mainnet_active)),
  ).length;

  const risk = {
    // Realised loss since UTC midnight, from the live book. Reported as a
    // POSITIVE loss figure so it reads against the limit; a profitable day
    // is 0 loss, and an unreadable day stays blank rather than showing $0.
    dailyLossUsd: trust.todayRealisedUsd === null ? null : Math.max(0, -trust.todayRealisedUsd),
    dailyLossLimitUsd: num(limitsQ.data?.daily_loss_limit_usd),
    exposureUsd:
      typeof summary?.inTrades === "number" && Number.isFinite(summary.inTrades)
        ? summary.inTrades
        : null,
    exposureLimitUsd: num(limitsQ.data?.max_total_exposure_usd),
    // Matches the server-side fallback when the owner has not saved a row yet.
    maxLeverage: num(limitsQ.data?.max_leverage) ?? 5,
    marginUsedUsd:
      typeof summary?.inTrades === "number" && Number.isFinite(summary.inTrades)
        ? summary.inTrades
        : null,
  };

  const apexBanner = apexUnverified > 0 && (
    <SurfaceCard className="flex items-start gap-2.5 bg-amber-500/[0.08] p-3.5">
      <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-amber-300" />
      <div>
        <p className="text-[12.5px] font-semibold text-amber-100">
          ApeX trading permission is not yet verified
        </p>
        <p className="mt-1 text-[11.5px] leading-relaxed text-amber-100/85">
          The signer proof has not completed. TurtleBot is intentionally blocked from placing any
          order on ApeX until a mainnet signer proof exists.
        </p>
      </div>
    </SurfaceCard>
  );

  const guarantees = (
    <SurfaceCard>
      <SectionHeading title="Guarantees" subtitle="Enforced in code, not policy." />
      <ul className="grid gap-2">
        <Guarantee text="Withdrawals blocked. Withdrawal permission is never requested on any API key." />
        <Guarantee text="Seed phrases and owner-wallet private keys are never requested. Venue-scoped signing credentials are encrypted immediately and never displayed again." />
        <Guarantee
          text={
            isOwner
              ? "Internal live execution is restricted to the owner account and remains gated by signer, canary, margin and risk checks."
              : "Customer live execution remains blocked pending jurisdiction and licensing approval."
          }
        />
        <Guarantee text="Encrypted secrets. API keys are stored encrypted and only ever shown obfuscated." />
        <Guarantee text="Standard strategies require protective stops. Owner-only canary entries are explicitly capped and labeled when their exit is managed separately." />
      </ul>
    </SurfaceCard>
  );

  const manageButton = (
    <button
      type="button"
      onClick={() => { setManageVenue(undefined); setManageOpen(true); }}
      className="flex w-full items-center gap-3 rounded-2xl bg-white/[0.04] p-3.5 text-left transition hover:bg-white/[0.08]"
    >
      <div
        className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl"
        style={{ background: "rgba(153,69,255,0.15)", color: "var(--accent)" }}
      >
        <KeyRound className="h-5 w-5" />
      </div>
      <div className="min-w-0 flex-1">
        <p className="text-[13.5px] font-semibold text-white">Manage API keys</p>
        <p className="text-[11.5px] text-white/55">Add, rotate, or revoke exchange credentials</p>
      </div>
    </button>
  );

  const detail = selectedRow ? (
    <ConnectionDetail row={selectedRow} linkedWallets={walletCounts.get(selectedRow.id) ?? 0} />
  ) : null;

  const connections = (
    <ExchangeGroups
      rows={rows}
      walletCounts={walletCounts}
      walletsByConnection={walletsByConnection}
      selectedId={selectedRow?.id ?? null}
      onSelect={setSelectedId}
      onConnect={(venue) => { setManageVenue(venue); setManageOpen(true); }}
    />
  );

  const monitor = <TrustMonitorPanel data={trust} />;
  const safety = (
    <SafetyCenterPanel
      risk={risk}
      halted={trust.halted}
      liveConnectionIds={liveConnectionIds}
      safetyConnectionIds={safetyConnectionIds}
    />
  );
  const account = (
    <AccountHealthPanel
      connection={selectedRow}
      openPnlUsd={selectedRow ? trust.openPnlUsd : null}
      closedPnlUsd={trust.closedPnlUsd}
      feesPaidUsd={trust.feesPaidUsd}
      lastSuccessfulTradeAt={trust.lastSuccessfulTradeAt}
      lastLoginAt={user?.last_sign_in_at ?? null}
    />
  );

  if (activation === "synfutures") return (
    <div className="mx-auto min-h-[100dvh] max-w-3xl space-y-4 bg-black px-4 py-6 text-white">
      <a href="/exchanges" className="text-sm text-cyan-200 underline">Back to exchanges</a>
      <h1 className="text-2xl font-semibold">SynFutures trading activation</h1>
      {isOwner ? <SynFuturesSdkPanel activationFirst /> : <p role="status">Sign in with your owner account to open trading activation.</p>}
    </div>
  );

  return (
    <div className="min-h-[100dvh] bg-black text-white">
      {/* MOBILE + TABLET — single column, sections stacked in question order. */}
      <div className="lg:hidden">
        <CinematicHero
          image={commandHero.url}
          className="tb-hard-surface-hero h-[230px] md:h-[290px]"
          eyebrow="Operations · Trust Center"
          title="Trust Center"
          subtitle="Everything you need to know before letting TurtleBot trade."
          chrome={
            <div className="flex items-center justify-end px-4 pt-4">
              <ProfileAvatar />
            </div>
          }
        />
        <div className="mx-auto max-w-[720px] space-y-4 px-4 pb-4 pt-4 md:max-w-[900px] md:px-6">
          <SystemStatusPanel data={trust} />
          {apexBanner}
          {isOwner && <VenueReadinessPanel />}
          {isOwner && <SynFuturesSdkPanel />}
          {connections}
          <BlockchainNetworks
            wallets={wallets.items.map((wallet) => wallet.row)}
            isLoading={wallets.isLoading}
            isError={wallets.isError}
          />
          {monitor}
          {safety}
          {account}
          {detail}
          <WalletsSection />
          {manageButton}
          {guarantees}
        </div>
      </div>

      {/* DESKTOP — a dense execution desk. Mobile keeps the guided, stacked
          trust flow above; the desktop prioritises trading controls and live
          operational facts without the policy/readiness material. */}
      <div className="tb-trading-desk hidden lg:block">
        <div className="mx-auto max-w-[1600px] px-5 py-5 xl:px-7">
          <header className="mb-4 flex min-w-0 items-center justify-between gap-4">
            <div className="min-w-0">
              <p className="text-[10px] font-semibold uppercase tracking-[0.2em] text-white/40">
                Live operations
              </p>
              <h1 className="mt-0.5 text-[24px] font-bold tracking-[-0.02em] text-white">
                Exchange Desk
              </h1>
            </div>
            <button
              type="button"
              onClick={() => { setManageVenue(undefined); setManageOpen(true); }}
              className="inline-flex min-h-10 shrink-0 items-center gap-2 rounded-xl bg-[color:var(--accent)] px-4 py-2 text-[12px] font-semibold text-white shadow-[0_10px_30px_rgba(153,69,255,0.24)]"
            >
              <KeyRound className="h-4 w-4" />
              Manage connections
            </button>
          </header>

          <div className="space-y-4">
            <SurfaceCard className="p-0">
              <div className="grid grid-cols-5 divide-x divide-white/[0.06]">
                <DeskMetric
                  label="System"
                  value={trust.overall.state}
                  tone={trust.overall.tone}
                  hint={`Checked ${relTime(trust.lastHealthCheckAt)}`}
                />
                <DeskMetric
                  label="Live venues"
                  value={`${liveVenueCount} / ${rows.length}`}
                  tone={liveVenueCount > 0 ? "ok" : "warn"}
                  hint="Verified + enabled"
                />
                <DeskMetric
                  label="Total equity"
                  value={fmtUsd(summary?.totalEquity)}
                  hint="Venue account"
                />
                <DeskMetric
                  label="Available margin"
                  value={fmtUsd(summary?.availableBalance)}
                  hint="Deployable capital"
                />
                <DeskMetric
                  label="Open positions"
                  value={trust.openPositions === null ? "—" : String(trust.openPositions)}
                  hint={`Queue ${trust.queueSize === null ? "—" : trust.queueSize}`}
                />
              </div>
            </SurfaceCard>

            {apexBanner}

            <BlockchainNetworks
              wallets={wallets.items.map((wallet) => wallet.row)}
              isLoading={wallets.isLoading}
              isError={wallets.isError}
            />

            <div className="grid min-w-0 grid-cols-12 items-start gap-4">
              <section className="col-span-4 min-w-0 space-y-4 xl:col-span-3">
                {connections}
                <WalletsSection compact />
              </section>

              <section className="col-span-8 min-w-0 space-y-4 xl:col-span-6">
                {detail ?? (
                  <SurfaceCard>
                    <SectionHeading
                      title="Venue controls"
                      subtitle="Select a connected venue to manage execution."
                    />
                  </SurfaceCard>
                )}
                {isOwner && <SynFuturesSdkPanel />}
              </section>

              <section className="col-span-12 min-w-0 space-y-4 xl:col-span-3">{account}</section>

              <section className="col-span-6 min-w-0">{monitor}</section>
              <section className="col-span-6 min-w-0">{safety}</section>
            </div>
          </div>
        </div>
      </div>

      <ExchangeConnectionsSheet open={manageOpen} onOpenChange={setManageOpen} initialExchange={manageVenue} />
      <AddWalletModal
        open={addWalletOpen}
        onOpenChange={setAddWalletOpen}
        onAdded={() => {
          setAddWalletOpen(false);
          wallets.refetchAll();
        }}
      />
    </div>
  );
}

function DeskMetric({
  label,
  value,
  hint,
  tone,
}: {
  label: string;
  value: string;
  hint: string;
  tone?: "ok" | "warn" | "down" | "idle" | "unknown";
}) {
  return (
    <div className="min-w-0 px-4 py-3.5">
      <div className="flex items-center gap-2">
        {tone && <StatusDot tone={tone} />}
        <p className="text-[9.5px] font-semibold uppercase tracking-[0.16em] text-white/40">
          {label}
        </p>
      </div>
      <p className="mt-1 break-words text-[15px] font-semibold tabular-nums text-white [overflow-wrap:anywhere]">
        {value}
      </p>
      <p className="mt-0.5 break-words text-[10px] text-white/35">{hint}</p>
    </div>
  );
}

/**
 * The ApeX-specific controls, unchanged in behaviour from the previous
 * detail panel. Kept as its own section so the venue cards above stay
 * uniform across DEX and CEX.
 */
function ConnectionDetail({ row, linkedWallets }: { row: ExchangeRow; linkedWallets: number }) {
  if (row.exchange === "synfutures") return (
    <SurfaceCard><SectionHeading title="SynFutures connected" subtitle={row.is_live && row.permission_trade && row.permissions_verified ? "Account reads enabled · trading enabled" : "Account reads enabled · trading off"} />
      <p className="text-xs text-white/65">Use the SynFutures account panel to refresh Base balances, positions and activation requirements.</p>
      <a href="/exchanges?activation=synfutures" className="mt-3 inline-flex rounded-xl bg-cyan-900/60 px-4 py-2 text-sm text-cyan-200">Open trading activation</a>
    </SurfaceCard>
  );
  const isApex = row.exchange.toLowerCase().startsWith("apex");
  const env: "mainnet" | "testnet" =
    row.environment === "mainnet" || row.environment === "production" ? "mainnet" : "testnet";
  const label = row.display_name ?? venueLabel(row.exchange);

  return (
    <div className="space-y-4">
      <SurfaceCard>
        <SectionHeading
          title={`${label} controls`}
          subtitle={`${linkedWallets} wallet${linkedWallets === 1 ? "" : "s"} linked · verified ${relTime(row.last_verified_at)}`}
        />
        {!row.permission_read && (
          <div className="mb-3 flex items-start gap-2 rounded-xl bg-amber-500/[0.08] p-2.5 text-[11px] text-amber-100">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span>
              Read permission missing. TurtleBot cannot pull balances or positions until the
              connection is repaired.
            </span>
          </div>
        )}
        <div className="space-y-3">
          <LiveTradingToggle
            connectionId={row.id}
            isLive={row.is_live}
            environment={row.environment}
            permissionTrade={row.permission_trade}
            permissionsVerified={row.permissions_verified}
          />
          <ProofOfLifeButton
            connectionId={row.id}
            environment={row.environment}
            isLive={row.is_live}
            permissionTrade={row.permission_trade}
            permissionsVerified={row.permissions_verified}
            connectionStatus={row.status}
          />
        </div>
      </SurfaceCard>

      {isApex && (
        <>
          <ApexFundingCard connectionId={row.id} environment={env} />
          <ApexActivateSigning
            connectionId={row.id}
            environment={env}
            currentFingerprint={row.signer_fingerprint}
            hasMainnetSigner={row.signer_mainnet_active}
            hasTestnetSigner={row.signer_testnet_active}
          />
        </>
      )}
    </div>
  );
}

function Guarantee({ text }: { text: string }) {
  return (
    <li className="flex items-start gap-2 rounded-xl bg-white/[0.03] p-2.5 text-[11.5px] leading-relaxed text-white/80">
      <ShieldCheck className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-300" />
      <span>{text}</span>
    </li>
  );
}
