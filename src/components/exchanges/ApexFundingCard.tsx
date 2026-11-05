// Apex funding step — surfaces the "your wallet balance is not your ApeX
// tradable balance" gap. Read-only: pulls the current ApeX account summary
// via exchange-credentials?action=summary and shows connected wallets
// side-by-side with the ApeX funding handoff.
//
// This exists because MetaMask holding USDT does NOT let ApeX open a
// position — funds must sit inside the ApeX margin account. When
// availableBalance = 0 the worker will correctly refuse to size, and
// this card explains why in-context. TurtleBot cannot custody funds or move
// wallet balances; the wallet must sign the funding transaction on ApeX.

import { useMemo, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import {
  ArrowLeftRight,
  ArrowUpRight,
  Wallet,
  Landmark,
  AlertTriangle,
  Loader2,
} from "lucide-react";

import { SurfaceCard } from "@/components/phantom/SurfaceCard";
import { invokeWithRetry } from "@/lib/edge/invokeWithRetry";
import { useWalletList } from "@/hooks/useWalletList";
import { cn } from "@/lib/utils";

type Props = {
  connectionId: string;
  environment: "mainnet" | "testnet";
};

type Summary = {
  totalEquity?: number;
  availableBalance?: number;
  inTrades?: number;
};

type SummaryResult = {
  summary: Summary | null;
  code: string | null;
  message: string | null;
};

type CapitalFlowResult = {
  ok?: boolean;
  status?: string;
  message?: string;
  next_action?: string | null;
  balances?: {
    funding?: { available?: string; total?: string };
    perps?: { available?: string; total?: string };
  };
};

function fmtUsd(n: number | undefined | null): string {
  if (n === undefined || n === null || !Number.isFinite(n)) return "—";
  return `$${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function fmtUsdt(value: string | undefined): string {
  const amount = Number(value);
  if (!Number.isFinite(amount)) return "—";
  if (Math.abs(amount) < 0.005) return "0.00";
  return amount.toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 6,
  });
}

function shortAddr(a: string): string {
  if (!a || a.length < 12) return a || "—";
  return `${a.slice(0, 6)}…${a.slice(-4)}`;
}

const APEX_DEPOSIT_URL = "https://omni.apex.exchange/portfolio";

export function ApexFundingCard({ connectionId, environment }: Props) {
  const wallets = useWalletList();
  const [capitalAmount, setCapitalAmount] = useState("");

  const fundingWallets = useMemo(() => {
    const list = wallets.items ?? [];
    // Any verified/apex-authorized wallet is a valid funding source.
    const eligible = list.filter((w) => w.row.status === "verified" || w.row.apex_authorized);
    // Default first, then apex-authorized, then highest balance.
    return eligible.sort((a, b) => {
      if (a.row.is_default !== b.row.is_default) return a.row.is_default ? -1 : 1;
      if (a.row.apex_authorized !== b.row.apex_authorized) return a.row.apex_authorized ? -1 : 1;
      return (b.usdTotal ?? 0) - (a.usdTotal ?? 0);
    });
  }, [wallets.items]);

  const summaryQ = useQuery({
    queryKey: ["apex-summary", connectionId],
    queryFn: async (): Promise<SummaryResult> => {
      try {
        const { data, error } = await invokeWithRetry<{
          ok?: boolean;
          code?: string;
          message?: string;
          summary?: Summary;
        }>("exchange-credentials", { action: "summary", connection_id: connectionId });
        if (error) {
          return {
            summary: null,
            code: "SUMMARY_REQUEST_FAILED",
            message: error.message || "Could not read ApeX balance.",
          };
        }
        if (!data?.ok) {
          return {
            summary: null,
            code: typeof data?.code === "string" ? data.code : "SUMMARY_UNAVAILABLE",
            message:
              typeof data?.message === "string" ? data.message : "Could not read ApeX balance.",
          };
        }
        return {
          summary: (data.summary ?? {}) as Summary,
          code: null,
          message: null,
        };
      } catch (e) {
        return {
          summary: null,
          code: "SUMMARY_REQUEST_FAILED",
          message: e instanceof Error ? e.message : "Could not read ApeX balance.",
        };
      }
    },
    refetchInterval: 30_000,
    staleTime: 15_000,
  });

  const capitalFlow = useMutation({
    mutationFn: async (action: "prepare" | "move_to_perps" | "return_to_funding") => {
      const requestId = crypto.randomUUID();
      const { data, error } = await invokeWithRetry<CapitalFlowResult>("apex-capital-flow", {
        action,
        connection_id: connectionId,
        amount: action === "prepare" ? undefined : capitalAmount,
        request_id: requestId,
      });
      if (error) throw new Error(error.message || "Capital workflow failed.");
      if (!data?.ok) throw new Error(data?.message || "Capital workflow failed.");
      return data;
    },
    onSuccess: () => summaryQ.refetch(),
  });

  const summary = summaryQ.data?.summary ?? null;
  const summaryErrorCode = summaryQ.data?.code ?? null;
  const summaryErrorMessage = summaryQ.data?.message ?? null;
  const available = summary?.availableBalance ?? 0;
  const equity = summary?.totalEquity ?? 0;
  const inTrades = summary?.inTrades ?? 0;
  const summaryUnavailable = !summaryQ.isLoading && !!summaryErrorCode;
  const needsFunding = !summaryQ.isLoading && !summaryUnavailable && available <= 0 && equity <= 0;

  const walletsTotal = fundingWallets.reduce((sum, w) => sum + (w.usdTotal ?? 0), 0);

  return (
    <SurfaceCard>
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-[10px] font-bold uppercase tracking-[0.16em] text-white/45">
            Wallet → ApeX funding
          </p>
          <h3 className="mt-0.5 text-[16px] font-semibold text-white">
            ApeX {environment === "mainnet" ? "mainnet" : "testnet"} tradable balance
          </h3>
        </div>
        {needsFunding && (
          <div className="inline-flex items-center gap-1 rounded-full bg-amber-500/15 px-2 py-1 text-[10px] font-semibold uppercase tracking-wider text-amber-200">
            <AlertTriangle className="h-3 w-3" />
            Zero balance
          </div>
        )}
      </div>

      {/* Side-by-side: All wallets total vs ApeX tradable */}
      <div className="mt-4 grid grid-cols-2 gap-2.5">
        <BalanceTile
          icon={<Wallet className="h-3.5 w-3.5" />}
          label={`Wallets (${fundingWallets.length})`}
          sub={fundingWallets.length === 0 ? "No wallets" : "combined USD"}
          value={fmtUsd(walletsTotal)}
          tone="neutral"
        />
        <BalanceTile
          icon={<Landmark className="h-3.5 w-3.5" />}
          label="ApeX margin"
          sub={
            summaryQ.isLoading
              ? "checking…"
              : summaryUnavailable
                ? "unavailable"
                : "available margin"
          }
          value={fmtUsd(available)}
          tone={needsFunding ? "warning" : available > 0 ? "positive" : "neutral"}
        />
      </div>

      {(equity > 0 || inTrades > 0) && (
        <div className="mt-2 grid grid-cols-2 gap-2.5 text-[11px] text-white/70">
          <div className="rounded-xl bg-white/[0.03] px-3 py-2">
            <div className="text-[9px] font-semibold uppercase tracking-widest text-white/45">
              Total equity
            </div>
            <div className="mt-0.5 tabular-nums text-white/90">{fmtUsd(equity)}</div>
          </div>
          <div className="rounded-xl bg-white/[0.03] px-3 py-2">
            <div className="text-[9px] font-semibold uppercase tracking-widest text-white/45">
              In open trades
            </div>
            <div className="mt-0.5 tabular-nums text-white/90">{fmtUsd(inTrades)}</div>
          </div>
        </div>
      )}

      <div className="tb-neu-inset mt-4 rounded-2xl p-3.5">
        <div className="flex items-start gap-2.5">
          <span className="tb-neu-raised grid h-9 w-9 shrink-0 place-items-center rounded-xl text-cyan-300">
            <ArrowLeftRight className="h-4 w-4" />
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-white/75">
              LangGraph capital flow
            </p>
            <p className="mt-1 text-[10.5px] leading-relaxed text-white/45">
              Wallet deposit requires your signature. TurtleBot can then allocate Funding → Perps,
              or return free Perps capital to Funding after every live position is closed.
            </p>
          </div>
        </div>

        <label className="mt-3 block">
          <span className="text-[9px] font-semibold uppercase tracking-[0.15em] text-white/40">
            USDT amount
          </span>
          <input
            inputMode="decimal"
            value={capitalAmount}
            onChange={(event) => setCapitalAmount(event.target.value.replace(/[^0-9.]/g, ""))}
            placeholder="0.00"
            className="tb-neu-inset mt-1.5 w-full rounded-xl border-0 bg-transparent px-3 py-2.5 text-[13px] tabular-nums text-white outline-none placeholder:text-white/25 focus:ring-1 focus:ring-cyan-300/50"
          />
        </label>

        <div className="mt-3 grid gap-2 sm:grid-cols-3">
          <button
            type="button"
            disabled={capitalFlow.isPending}
            onClick={() => capitalFlow.mutate("prepare")}
            className="tb-neu-raised rounded-xl px-3 py-2 text-[10.5px] font-semibold text-white/75 disabled:opacity-50"
          >
            Check Funding
          </button>
          <button
            type="button"
            disabled={capitalFlow.isPending || !capitalAmount || Number(capitalAmount) <= 0}
            onClick={() => capitalFlow.mutate("move_to_perps")}
            className="tb-neu-raised rounded-xl px-3 py-2 text-[10.5px] font-semibold text-cyan-200 disabled:opacity-40"
          >
            Move to Perps
          </button>
          <button
            type="button"
            disabled={capitalFlow.isPending || !capitalAmount || Number(capitalAmount) <= 0}
            onClick={() => capitalFlow.mutate("return_to_funding")}
            className="tb-neu-raised rounded-xl px-3 py-2 text-[10.5px] font-semibold text-violet-200 disabled:opacity-40"
          >
            Return to Funding
          </button>
        </div>

        {capitalFlow.isPending ? (
          <p
            className="mt-3 inline-flex items-center gap-2 text-[10.5px] text-white/55"
            role="status"
          >
            <Loader2 className="h-3.5 w-3.5 animate-spin" /> Coordinating ApeX ledgers…
          </p>
        ) : capitalFlow.error ? (
          <p className="mt-3 text-[10.5px] text-rose-300" role="alert">
            {capitalFlow.error.message}
          </p>
        ) : capitalFlow.data ? (
          <div className="mt-3 rounded-xl bg-black/30 px-3 py-2 text-[10.5px] text-white/65">
            <p>{capitalFlow.data.message}</p>
            {capitalFlow.data.balances ? (
              <p className="mt-1 tabular-nums text-white/45">
                Funding {fmtUsdt(capitalFlow.data.balances.funding?.available)} USDT · Perps{" "}
                {fmtUsdt(capitalFlow.data.balances.perps?.available)} USDT
              </p>
            ) : null}
          </div>
        ) : null}
      </div>

      {/* Per-wallet funding rows */}
      {fundingWallets.length > 0 && (
        <div className="mt-4 space-y-1.5">
          <div className="flex items-center justify-between px-1">
            <p className="text-[9.5px] font-bold uppercase tracking-[0.16em] text-white/45">
              Connected funding wallets
            </p>
            <p className="text-[9.5px] uppercase tracking-wider text-white/35">
              {available > 0 ? "ApeX margin funded" : "fund from ApeX portfolio"}
            </p>
          </div>
          {fundingWallets.map((w) => (
            <WalletFundRow
              key={w.row.id}
              address={w.row.public_address}
              label={w.row.label ?? w.row.provider}
              chain={w.row.chain}
              usd={w.usdTotal ?? 0}
              isDefault={w.row.is_default}
              apexAuthorized={w.row.apex_authorized}
            />
          ))}
        </div>
      )}

      {/* Explainer — only when zero */}
      {needsFunding && (
        <div className="mt-3 rounded-xl bg-amber-500/[0.06] p-3 text-[11.5px] leading-relaxed text-amber-100/90">
          The wallet toggle marks which wallets can fund ApeX; it does not move money. Open ApeX
          from a wallet row, connect that same wallet there, and sign the USDT deposit into ApeX
          margin to enable live sizing.
        </div>
      )}

      {/* CTA row */}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <a
          href={APEX_DEPOSIT_URL}
          target="_blank"
          rel="noreferrer noopener"
          className={cn(
            "inline-flex items-center gap-1.5 rounded-full px-3.5 py-1.5 text-[12px] font-semibold text-white",
            needsFunding
              ? "bg-amber-500/90 hover:bg-amber-500 text-black"
              : "bg-white/10 hover:bg-white/15",
          )}
        >
          <ArrowUpRight className="h-3.5 w-3.5" />
          {needsFunding ? "Open ApeX deposit" : "Open ApeX assets"}
        </a>
        <button
          type="button"
          onClick={() => summaryQ.refetch()}
          className="inline-flex items-center gap-1.5 rounded-full bg-white/[0.06] px-3 py-1.5 text-[11.5px] font-semibold text-white/80 hover:bg-white/[0.1]"
        >
          Refresh balance
        </button>
      </div>

      {summaryUnavailable && (
        <div className="mt-3 rounded-xl bg-red-500/[0.08] p-2.5 text-[11px] text-red-200">
          {summaryErrorCode === "DECRYPT_FAILED"
            ? "Stored ApeX API credentials cannot be decrypted. Align the credential key, then re-save the ApeX API key."
            : summaryErrorMessage || "Couldn’t read ApeX balance right now. Retry in a moment."}
        </div>
      )}
    </SurfaceCard>
  );
}

function BalanceTile({
  icon,
  label,
  sub,
  value,
  tone,
}: {
  icon: React.ReactNode;
  label: string;
  sub: string;
  value: string;
  tone: "neutral" | "positive" | "warning";
}) {
  const toneCls =
    tone === "positive"
      ? "bg-emerald-500/10 text-emerald-100"
      : tone === "warning"
        ? "bg-amber-500/10 text-amber-100"
        : "bg-white/[0.04] text-white/90";
  return (
    <div className={cn("rounded-2xl px-3 py-2.5", toneCls)}>
      <div className="flex items-center gap-1.5 text-[9.5px] font-bold uppercase tracking-widest opacity-80">
        {icon}
        {label}
      </div>
      <div className="mt-1 text-[18px] font-semibold tabular-nums">{value}</div>
      <div className="mt-0.5 truncate text-[10.5px] opacity-70">{sub}</div>
    </div>
  );
}

function WalletFundRow({
  address,
  label,
  chain,
  usd,
  isDefault,
  apexAuthorized,
}: {
  address: string;
  label: string;
  chain: string;
  usd: number;
  isDefault: boolean;
  apexAuthorized: boolean;
}) {
  async function copy() {
    try {
      await navigator.clipboard.writeText(address);
    } catch {
      /* ignore */
    }
  }
  return (
    <div className="flex items-center justify-between gap-2 rounded-xl bg-white/[0.03] px-3 py-2">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className="truncate text-[12px] font-semibold text-white/90">{label}</span>
          {isDefault && (
            <span className="rounded-full bg-white/10 px-1.5 py-0.5 text-[8.5px] font-bold uppercase tracking-wider text-white/70">
              Default
            </span>
          )}
          {apexAuthorized && (
            <span className="rounded-full bg-emerald-500/15 px-1.5 py-0.5 text-[8.5px] font-bold uppercase tracking-wider text-emerald-200">
              Funding
            </span>
          )}
        </div>
        <div className="mt-0.5 flex items-center gap-1.5 text-[10.5px] text-white/55">
          <span className="font-mono">{shortAddr(address)}</span>
          <span className="opacity-40">·</span>
          <span className="uppercase tracking-wider">{chain}</span>
        </div>
      </div>
      <div className="shrink-0 text-right">
        <div className="text-[12.5px] font-semibold tabular-nums text-white/90">{fmtUsd(usd)}</div>
        <div className="mt-0.5 flex items-center justify-end gap-1">
          <button
            type="button"
            onClick={copy}
            className="rounded-full bg-white/[0.06] px-2 py-0.5 text-[9.5px] font-semibold text-white/75 hover:bg-white/10"
          >
            Copy
          </button>
          <a
            href={APEX_DEPOSIT_URL}
            target="_blank"
            rel="noreferrer noopener"
            className="inline-flex items-center gap-0.5 rounded-full bg-amber-500/80 px-2 py-0.5 text-[9.5px] font-bold uppercase tracking-wider text-black hover:bg-amber-400"
          >
            Deposit
            <ArrowUpRight className="h-2.5 w-2.5" />
          </a>
        </div>
      </div>
    </div>
  );
}
