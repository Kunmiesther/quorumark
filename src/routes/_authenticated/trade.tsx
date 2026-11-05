/**
 * Trade Command Center — route wrapper.
 *
 * The desk itself is a SHARED component (see src/components/trade/TradeDesk.tsx)
 * that renders identically for both `paper` and `live` books. The route owns
 * URL search state and mounts the shared desk with the current book.
 *
 * Ruling #7 — the mode is a safety control. The route MUST NOT default to
 * either book when `?book=` is absent. Instead it renders an explicit chooser
 * (UNRESOLVED state) that forces the operator to pick paper or live before
 * any positions, prices, or order actions are shown. This prevents the two
 * failure modes the ruling calls out:
 *   • defaulting to LIVE and showing real-money surfaces unintentionally
 *   • defaulting to PAPER and letting a real-mode operator think they are
 *     looking at live data because the surfaces are visually identical
 */
import { createFileRoute, redirect, useNavigate, type ErrorComponentProps } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";

import { SurfaceCard } from "@/components/phantom/SurfaceCard";
import { TradeDesk } from "@/components/trade/TradeDesk";
import { getMyAccess } from "@/lib/community/access.functions";
import { QUORUMARK_MVP_SURFACES_ONLY } from "@/lib/live-trading-policy";

type Book = "paper" | "live";
const TRADE_SYMBOLS = new Set(["BTC-USDT", "ETH-USDT", "SOL-USDT", "XRP-USDT"]);
type TradeSearch = { book?: Book; candidate?: string; symbol?: string };

export const Route = createFileRoute("/_authenticated/trade")({
  beforeLoad: () => {
    if (QUORUMARK_MVP_SURFACES_ONLY) throw redirect({ to: "/home" });
  },
  component: TradePage,
  validateSearch: (raw: Record<string, unknown>): TradeSearch => {
    const b = raw.book;
    const c = typeof raw.candidate === "string" ? raw.candidate.slice(0, 128) : undefined;
    const requestedSymbol =
      typeof raw.symbol === "string" ? raw.symbol.trim().toUpperCase() : undefined;
    return {
      book: b === "live" || b === "paper" ? b : undefined,
      candidate: c || undefined,
      symbol: requestedSymbol && TRADE_SYMBOLS.has(requestedSymbol) ? requestedSymbol : undefined,
    };
  },
  head: () => ({
    meta: [
      { title: "Trade Command Center — TurtleBot" },
      {
        name: "description",
        content:
          "Chart-first mainnet trade command. Balances, live Arbiter signal, open position, and recent activity — trading stays locked until authorization completes.",
      },
      { property: "og:title", content: "Trade Command Center — TurtleBot" },
      {
        property: "og:description",
        content:
          "Unified paper + live desk. Chart, structure, performance, and open positions in one shared surface.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  errorComponent: TradeError,
  pendingComponent: TradePending,
});

function TradePage() {
  const { book: searchBook, candidate, symbol } = Route.useSearch();
  const navigate = useNavigate();
  const fetchAccess = useServerFn(getMyAccess);
  const access = useQuery({
    queryKey: ["access", "me"],
    queryFn: () => fetchAccess(),
  });
  const setBook = (b: Book) => {
    navigate({
      to: "/trade",
      search: (prev: TradeSearch) => ({ ...prev, book: b }),
      replace: true,
    });
  };

  if (access.isLoading) return <TradePending />;
  if (access.isError || !access.data) {
    return (
      <TradeAccessError message="We couldn't verify your trading access. No trading surface was opened." />
    );
  }

  if (searchBook !== "paper" && searchBook !== "live") {
    return <ModeChooser onPick={setBook} canPaper={access.data.paper} canLive={access.data.live} />;
  }
  if (searchBook === "live" && !access.data.live) {
    return <TradeAccessDenied book="live" onOpenPaper={() => setBook("paper")} />;
  }
  if (searchBook === "paper" && !access.data.paper) {
    return <TradeAccessDenied book="paper" />;
  }
  return (
    <TradeDesk
      book={searchBook}
      onChangeBook={setBook}
      candidateId={candidate ?? null}
      initialSymbol={symbol ?? null}
    />
  );
}

/**
 * Explicit mode chooser — rendered when `?book=` is not one of paper/live.
 * This is the UNRESOLVED state required by Ruling #7 STEP 3: never guess,
 * never default. No positions, prices, or order actions are mounted here.
 */
function ModeChooser({
  onPick,
  canPaper,
  canLive,
}: {
  onPick: (b: Book) => void;
  canPaper: boolean;
  canLive: boolean;
}) {
  return (
    <div className="min-h-[100dvh] bg-black text-white">
      <div className="mx-auto flex min-h-[100dvh] max-w-[720px] flex-col items-center justify-center px-4 py-10">
        <div
          className="mb-4 inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-[11px] font-bold uppercase tracking-[0.16em]"
          style={{
            borderColor: "color-mix(in oklab, var(--warning) 40%, transparent)",
            background: "color-mix(in oklab, var(--warning) 10%, transparent)",
            color: "var(--warning)",
          }}
          data-testid="trade-mode-unresolved"
        >
          <span className="h-2 w-2 rounded-full" style={{ background: "var(--warning)" }} />
          Mode unresolved
        </div>
        <h1 className="mb-2 text-center text-[22px] font-bold tracking-tight">
          Choose a book before the desk opens
        </h1>
        <p className="mb-6 max-w-md text-center text-[13px] text-white/60">
          Paper and live look identical on purpose. Pick one explicitly — no silent default, no
          auto-fallback.
        </p>
        <div className="grid w-full grid-cols-1 gap-3 sm:grid-cols-2">
          <button
            onClick={() => onPick("paper")}
            disabled={!canPaper}
            data-testid="trade-mode-pick-paper"
            className="rounded-2xl border border-[color:var(--onixus-purple)]/40 bg-[color:var(--onixus-purple)]/10 px-5 py-6 text-left hover:bg-[color:var(--onixus-purple)]/20 disabled:cursor-not-allowed disabled:opacity-45"
          >
            <div className="text-[10.5px] font-bold uppercase tracking-[0.16em] text-[color:var(--onixus-purple)]">
              Paper
            </div>
            <div className="mt-1 text-[15px] font-semibold text-white">
              Sandbox — simulated fills
            </div>
            <div className="mt-1 text-[11.5px] text-white/60">
              {canPaper
                ? "Simulated fills only. No real orders."
                : "A paper-testing seat is required."}
            </div>
          </button>
          <button
            onClick={() => onPick("live")}
            disabled={!canLive}
            data-testid="trade-mode-pick-live"
            className="rounded-2xl border border-[color:var(--onixus-teal)]/40 bg-[color:var(--onixus-teal)]/10 px-5 py-6 text-left hover:bg-[color:var(--onixus-teal)]/20 disabled:cursor-not-allowed disabled:opacity-45"
          >
            <div className="text-[10.5px] font-bold uppercase tracking-[0.16em] text-[color:var(--onixus-teal)]">
              Live
            </div>
            <div className="mt-1 text-[15px] font-semibold text-white">Mainnet — real money</div>
            <div className="mt-1 text-[11.5px] text-white/60">
              {canLive
                ? "Owner-only mainnet control. Real-money execution remains independently gated."
                : "Restricted to the owner/admin test account."}
            </div>
          </button>
        </div>
      </div>
    </div>
  );
}

function TradeAccessDenied({ book, onOpenPaper }: { book: Book; onOpenPaper?: () => void }) {
  const live = book === "live";
  return (
    <div className="min-h-[100dvh] bg-black text-white">
      <div className="mx-auto flex min-h-[100dvh] max-w-[720px] items-center justify-center px-4 py-10">
        <SurfaceCard className="w-full max-w-lg p-6 text-center">
          <p className="text-[11px] font-bold uppercase tracking-[0.16em] text-[color:var(--onixus-purple)]">
            {live ? "Owner-only live pilot" : "Paper seat required"}
          </p>
          <h1 className="mt-2 text-xl font-semibold">
            {live ? "Live trading is restricted" : "Paper trading is not active for this account"}
          </h1>
          <p className="mt-2 text-sm text-white/60">
            {live
              ? "Community testing runs on simulated funds. Only the designated owner/admin account can open the live book."
              : "Ask an administrator for a community paper-testing seat."}
          </p>
          {live && onOpenPaper ? (
            <button
              type="button"
              onClick={onOpenPaper}
              className="mt-5 rounded-xl bg-[color:var(--onixus-purple)] px-5 py-3 text-sm font-semibold text-white"
            >
              Open paper trading
            </button>
          ) : null}
        </SurfaceCard>
      </div>
    </div>
  );
}

function TradeAccessError({ message }: { message: string }) {
  return (
    <div className="min-h-[100dvh] bg-black">
      <div className="mx-auto max-w-[720px] px-4 pt-16">
        <SurfaceCard>
          <p className="text-[13px] font-semibold text-[color:var(--negative)]">
            Access check failed
          </p>
          <p className="mt-1 text-[13px] text-white/60">{message}</p>
        </SurfaceCard>
      </div>
    </div>
  );
}

function TradePending() {
  return (
    <div className="min-h-[100dvh] bg-black">
      <div className="h-[280px] animate-pulse bg-white/[0.04] md:h-[340px] lg:h-[400px]" />
      <div className="mx-auto max-w-[1440px] space-y-4 px-4 pt-6 sm:px-6 lg:px-8">
        <div className="h-40 animate-pulse rounded-3xl bg-white/[0.04]" />
        <div className="h-64 animate-pulse rounded-3xl bg-white/[0.04]" />
      </div>
    </div>
  );
}

function TradeError({ error }: ErrorComponentProps) {
  return (
    <div className="min-h-[100dvh] bg-black">
      <div className="mx-auto max-w-[1440px] px-4 pt-16 sm:px-6 lg:px-8">
        <SurfaceCard>
          <p className="text-[13px] font-semibold text-[color:var(--negative)]">
            Couldn't load Trade
          </p>
          <p className="mt-1 text-[13px] text-white/60">{error instanceof Error ? error.message : String(error)}</p>
        </SurfaceCard>
      </div>
    </div>
  );
}
