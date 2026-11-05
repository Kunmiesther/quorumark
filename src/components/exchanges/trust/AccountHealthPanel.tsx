/**
 * Section 5 — Account Health.
 *
 * Balances come from the venue's own account summary via the existing
 * `exchange-credentials?action=summary` read — the same source the funding
 * card uses, so the two can never disagree.
 *
 * Every figure that has no source renders as an em dash with a stated
 * reason. A fabricated $0 on a funded account is the single most damaging
 * thing this panel could show.
 */
import { useQuery } from "@tanstack/react-query";
import { KeyRound } from "lucide-react";

import { SurfaceCard } from "@/components/phantom/SurfaceCard";
import {
  Metric,
  SectionHeading,
  fmtSignedUsd,
  fmtUsd,
  relTime,
} from "@/components/exchanges/trust/primitives";
import { invokeWithRetry } from "@/lib/edge/invokeWithRetry";
import { cn } from "@/lib/utils";

export interface AccountHealthConnection {
  id: string;
  created_at: string;
  permission_read: boolean;
  permission_trade: boolean;
  permissions_verified: boolean;
  withdrawals_disabled: boolean;
}

type Summary = {
  totalEquity?: number;
  availableBalance?: number;
  inTrades?: number;
};

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

export function useAccountSummary(connectionId: string | null) {
  return useQuery({
    queryKey: ["trust-account-summary", connectionId],
    enabled: Boolean(connectionId),
    refetchInterval: 60_000,
    queryFn: async (): Promise<{ summary: Summary | null; message: string | null }> => {
      const { data, error } = await invokeWithRetry("exchange-credentials", {
        action: "summary",
        connection_id: connectionId,
      });
      if (error) return { summary: null, message: "Balance read failed" };
      const payload = data as { summary?: Summary; message?: string } | null;
      return {
        summary: payload?.summary ?? null,
        message: payload?.message ?? null,
      };
    },
  });
}

export function AccountHealthPanel({
  connection,
  openPnlUsd,
  closedPnlUsd,
  feesPaidUsd,
  lastSuccessfulTradeAt,
  lastLoginAt,
}: {
  connection: AccountHealthConnection | null;
  openPnlUsd: number | null;
  /** Realised PnL across every CLOSED live trade. Null = not readable. */
  closedPnlUsd: number | null;
  feesPaidUsd: number | null;
  lastSuccessfulTradeAt: string | null;
  lastLoginAt: string | null;
}) {
  const summaryQ = useAccountSummary(connection?.id ?? null);
  const summary = summaryQ.data?.summary ?? null;

  const equity = num(summary?.totalEquity);
  const available = num(summary?.availableBalance);
  const inTrades = num(summary?.inTrades);
  const openPnl = fmtSignedUsd(openPnlUsd);
  const closedPnl = fmtSignedUsd(closedPnlUsd);

  const noSource = !connection
    ? "No connection selected"
    : summaryQ.isLoading
      ? "Reading…"
      : summary === null
        ? (summaryQ.data?.message ?? "Venue did not return an account summary")
        : null;

  return (
    <SurfaceCard>
      <SectionHeading
        title="Account health"
        subtitle="Read live from the venue account. Blank means not reported — never zero."
      />

      {noSource && (
        <p className="mb-3 rounded-xl bg-white/[0.03] px-3 py-2 text-[11px] text-white/45">
          {noSource}
        </p>
      )}

      <div className="grid grid-cols-2 gap-x-4 gap-y-4 sm:grid-cols-3">
        <Metric label="Wallet balance" value={fmtUsd(equity)} />
        <Metric label="Available margin" value={fmtUsd(available)} />
        <Metric label="Margin used" value={fmtUsd(inTrades)} />
        <Metric
          label="Open PnL"
          value={openPnl.text}
          tone={openPnlUsd === null ? undefined : openPnl.tone}
        />
        <Metric
          label="Closed PnL"
          value={closedPnl.text}
          tone={closedPnlUsd === null ? undefined : closedPnl.tone}
          hint={closedPnlUsd === null ? "Not readable" : "Realised, live book"}
        />
        <Metric
          label="Fees paid"
          value={fmtUsd(feesPaidUsd)}
          hint={feesPaidUsd === null ? "Not readable" : "Live book, all time"}
        />
      </div>

      <div className="mt-5 grid grid-cols-2 gap-x-4 gap-y-4 border-t border-white/[0.06] pt-4 sm:grid-cols-3">
        <Metric
          label="Connection age"
          value={connection ? relTime(connection.created_at).replace(" ago", "") : "—"}
        />
        <Metric label="Last login" value={relTime(lastLoginAt)} />
        <Metric
          label="Last successful trade"
          value={lastSuccessfulTradeAt ? relTime(lastSuccessfulTradeAt) : "None yet"}
        />
      </div>

      <div className="mt-5 border-t border-white/[0.06] pt-4">
        <div className="flex items-center gap-1.5">
          <KeyRound className="h-3 w-3 text-white/40" />
          <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-white/40">
            API permissions
          </p>
        </div>
        <div className="mt-2 flex flex-wrap gap-1.5">
          <PermTag label="Read" ok={connection?.permission_read ?? false} />
          <PermTag label="Trade" ok={connection?.permission_trade ?? false} />
          <PermTag label="Verified" ok={connection?.permissions_verified ?? false} />
          <PermTag label="Withdrawals disabled" ok={connection?.withdrawals_disabled ?? false} />
        </div>
        <p className="mt-2.5 text-[10.5px] leading-relaxed text-white/35">
          TurtleBot never requests withdrawal permission, a seed phrase, or an
          owner-wallet private key. Venue-scoped signing credentials are encrypted.
        </p>
      </div>
    </SurfaceCard>
  );
}

function PermTag({ label, ok }: { label: string; ok: boolean }) {
  return (
    <span
      className={cn(
        "rounded-md px-2 py-1 text-[10px] font-semibold uppercase tracking-wider",
        ok ? "bg-emerald-500/12 text-emerald-200" : "bg-white/[0.05] text-white/45",
      )}
    >
      {label}
    </span>
  );
}
