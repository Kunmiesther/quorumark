import { useMemo } from "react";
import { loadPaperPositionPerformance } from "@/lib/trade/paperPositionPerformance";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import type { SupabaseClient } from "@supabase/supabase-js";
import { useAuth } from "@/hooks/useAuth";
import { supabase } from "@/integrations/supabase/client";
import { getShortlistCycle } from "@/lib/ai/shortlist.functions";
import { analyzeClosedTrades, type IntelligenceTrade } from "@/lib/trade/tradeIntelligence";
import { Activity, Compass, Layers3, ShieldAlert, Target } from "lucide-react";
import { PairBadge } from "./PairBadge";
import { resultTone, RESULT_TONES, type ResultTone } from "@/lib/trade/resultTone";

type Book = "paper" | "live";
const SAMPLE_LIMIT = 200;
const MIN_SYMBOL_SAMPLE = 5;
const ledgerClient = supabase as unknown as SupabaseClient;

type OutcomeRow = {
  opportunity_id: string;
  window_key: string;
  status: string;
  net_pct: number | null;
  mfe_pct: number | null;
  mae_pct: number | null;
};
type OpportunityRow = {
  id: string;
  symbol: string;
  direction: string;
  decision_at: string;
  reference_price: number;
  rejection_reason: string | null;
};

function money(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "—";
  return `${value < 0 ? "−" : value > 0 ? "+" : ""}$${Math.abs(value).toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

function Metric({
  label,
  value,
  detail,
  tone = "neutral",
}: {
  label: string;
  value: string;
  detail?: string;
  tone?: ResultTone;
}) {
  return (
    <div
      data-intelligence-tone={tone}
      className={`min-w-0 rounded-2xl border bg-black/25 px-3 py-2.5 shadow-[inset_2px_2px_6px_rgba(0,0,0,0.35),2px_2px_8px_rgba(0,0,0,0.2)] ${RESULT_TONES[tone].surface}`}
    >
      <dt className="text-[10px] font-semibold uppercase tracking-[0.13em] text-white/45">
        {label}
      </dt>
      <dd
        className={`mt-1 break-words font-mono text-[16px] font-semibold tabular-nums ${RESULT_TONES[tone].text}`}
      >
        {value}
      </dd>
      {detail ? <p className="mt-1 text-[10px] leading-4 text-white/40">{detail}</p> : null}
    </div>
  );
}

export function TradeIntelligencePanel({ book }: { book: Book }) {
  const { user } = useAuth();
  const fetchCycle = useServerFn(getShortlistCycle);
  const history = useQuery({
    queryKey: ["trade-intelligence", book, user?.id],
    enabled: !!user?.id,
    refetchInterval: 60_000,
    queryFn: async (): Promise<IntelligenceTrade[]> => {
      if (book === "paper") {
        return loadPaperPositionPerformance(ledgerClient, user!.id, SAMPLE_LIMIT);
      }
      const { data, error } = await supabase
        .from("trades")
        .select("pair, realized_pnl, closed_at, strategy_id")
        .eq("user_id", user!.id)
        .not("closed_at", "is", null)
        .order("closed_at", { ascending: false })
        .limit(SAMPLE_LIMIT);
      if (error) throw error;
      const strategyIds = [
        ...new Set((data ?? []).map((row) => row.strategy_id).filter(Boolean)),
      ] as string[];
      const strategies = new Map<string, string>();
      if (strategyIds.length) {
        const catalog = await supabase.from("strategies").select("id, name").in("id", strategyIds);
        if (catalog.error) throw catalog.error;
        for (const strategy of catalog.data ?? []) strategies.set(strategy.id, strategy.name);
      }
      return (data ?? []).map((row) => ({
        symbol: String(row.pair ?? ""),
        strategy: strategies.get(String(row.strategy_id ?? "")) ?? null,
        pnl: row.realized_pnl == null ? Number.NaN : Number(row.realized_pnl),
        closedAt: String(row.closed_at ?? ""),
      }));
    },
  });
  const shortlist = useQuery({
    queryKey: ["trade-intelligence-shortlist", book, user?.id],
    enabled: !!user?.id,
    queryFn: () => fetchCycle({ data: { book } }),
    refetchInterval: 60_000,
  });
  const feedback = useQuery({
    queryKey: ["missed-opportunity-feedback", book, user?.id],
    enabled: !!user?.id,
    refetchInterval: 60_000,
    queryFn: async () => {
      const opportunities = await ledgerClient
        .from("missed_opportunities")
        .select("id, symbol, direction, decision_at, reference_price, rejection_reason")
        .eq("user_id", user!.id)
        .eq("book", book)
        .order("decision_at", { ascending: false })
        .limit(60);
      if (opportunities.error) throw opportunities.error;
      const rows = (opportunities.data ?? []) as OpportunityRow[];
      if (!rows.length) return { rows, outcomes: [] as OutcomeRow[] };
      const outcomes = await ledgerClient
        .from("missed_opportunity_outcomes")
        .select("opportunity_id, window_key, status, net_pct, mfe_pct, mae_pct")
        .in(
          "opportunity_id",
          rows.map((row) => row.id),
        );
      if (outcomes.error) throw outcomes.error;
      return { rows, outcomes: (outcomes.data ?? []) as OutcomeRow[] };
    },
  });
  const summary = useMemo(() => analyzeClosedTrades(history.data ?? []), [history.data]);
  const observedSymbols = summary.bySymbol.filter((row) => row.count >= MIN_SYMBOL_SAMPLE);
  const missed = (shortlist.data?.rows ?? []).filter((row) => !row.selected);
  const losingSymbols = observedSymbols.filter((row) => row.netPnl < 0);
  const outcomeById = new Map(
    (feedback.data?.outcomes ?? []).map((row) => [`${row.opportunity_id}|${row.window_key}`, row]),
  );
  const evaluated24h = (feedback.data?.outcomes ?? []).filter(
    (row) => row.window_key === "24h" && row.status === "complete" && row.net_pct !== null,
  );
  const favorable24h = evaluated24h.filter((row) => Number(row.net_pct) > 0).length;

  return (
    <section
      className="trade-intelligence trade-manual-tools min-w-0 rounded-[24px] p-3 sm:p-4"
      data-testid={`trade-intelligence-${book}`}
    >
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-[10px] font-bold uppercase tracking-[0.24em] text-[color:var(--onixus-purple)]">
            Trade intelligence
          </p>
          <h2 className="mt-1 text-base font-semibold text-white">
            Performance, risk & missed setups
          </h2>
        </div>
        <span className="rounded-full border border-white/15 px-2.5 py-1 font-mono text-[10px] uppercase tracking-widest text-white/65">
          {book} book only
        </span>
      </header>
      <p className="mt-1.5 max-w-4xl text-xs leading-5 text-white/45">
        Observed results from the latest {SAMPLE_LIMIT} closed trades with reported P&amp;L; no
        paper/live blending.
        {book === "live"
          ? " Live P&L is venue-reported; verify fee treatment with the exchange."
          : " Paper results count completed positions, including all partial exits."}
      </p>

      {history.isLoading ? (
        <p className="mt-5 text-sm text-white/45">Loading recorded trades…</p>
      ) : history.isError ? (
        <p className="mt-5 text-sm text-amber-300">
          Trade results could not be loaded. No performance conclusion is available.
        </p>
      ) : summary.count === 0 ? (
        <p className="mt-5 rounded-xl border border-white/[0.07] bg-black/20 p-4 text-sm text-white/55">
          No closed trades with reported P&amp;L in this {book} book yet. Open positions are shown
          above, but they are not counted as realized wins.
        </p>
      ) : (
        <>
          <dl className="mt-4 grid grid-cols-2 gap-2 lg:grid-cols-4 xl:grid-cols-7">
            <Metric
              label="Closed sample"
              tone="info"
              value={String(summary.count)}
              detail={`Latest ${SAMPLE_LIMIT} maximum`}
            />
            <Metric
              label="Win rate"
              tone="info"
              value={`${(summary.winRate! * 100).toFixed(1)}%`}
              detail={`${summary.wins} wins · ${summary.losses} losses · ${summary.breakeven} flat`}
            />
            <Metric
              label="Reported P&L"
              tone={resultTone(summary.netPnl)}
              value={money(summary.netPnl)}
              detail="Closed trades only"
            />
            <Metric
              label="Profit factor"
              value={summary.profitFactor == null ? "—" : summary.profitFactor.toFixed(2)}
              detail={summary.losses ? "Gross wins ÷ gross losses" : "No losses in sample"}
            />
            <Metric
              label="Average win"
              tone={resultTone(summary.averageWin)}
              value={money(summary.averageWin)}
            />
            <Metric
              label="Average loss"
              tone={resultTone(summary.averageLoss)}
              value={money(summary.averageLoss)}
            />
            <Metric
              label="Per-trade average"
              tone={resultTone(summary.expectancy)}
              value={money(summary.expectancy)}
              detail="Historical, not a forecast"
            />
          </dl>
          <div className="mt-3 grid gap-3 lg:grid-cols-2">
            <div data-intelligence-tone="risk" className="tb-neu-panel rounded-2xl p-3">
              <h3 className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-amber-200">
                <ShieldAlert aria-hidden="true" className="h-4 w-4" />
                Risk review
              </h3>
              <dl className="mt-2 grid grid-cols-3 gap-2 text-[11px]">
                <div>
                  <dt className="text-white/55">Largest loss</dt>
                  <dd
                    className={`mt-1 font-mono tabular-nums ${RESULT_TONES[resultTone(summary.largestLoss)].text}`}
                  >
                    {money(summary.largestLoss)}
                  </dd>
                </div>
                <div>
                  <dt className="text-white/55">Loss streak</dt>
                  <dd className="mt-1 font-mono tabular-nums text-amber-200">
                    {summary.longestLossStreak}
                  </dd>
                </div>
                <div>
                  <dt className="text-white/55">Closed-trade drawdown</dt>
                  <dd
                    className={`mt-1 font-mono tabular-nums ${RESULT_TONES[resultTone(-summary.maxClosedTradeDrawdown)].text}`}
                  >
                    {money(-summary.maxClosedTradeDrawdown)}
                  </dd>
                </div>
              </dl>
              <p className="mt-2 text-[10px] leading-4 text-white/40">
                Drawdown is based on this closed-trade P&amp;L sample, not account equity or
                unrealized exposure.
              </p>
              {losingSymbols.length ? (
                <p className="mt-2 text-xs leading-5 text-amber-200/80">
                  Review sizing and entry rules for{" "}
                  {losingSymbols.map((row) => row.symbol).join(", ")}; each has at least{" "}
                  {MIN_SYMBOL_SAMPLE} trades and negative observed P&amp;L.
                </p>
              ) : null}
            </div>
            <div data-intelligence-tone="info" className="tb-neu-panel rounded-2xl p-3">
              <h3 className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-cyan-200">
                <Activity aria-hidden="true" className="h-4 w-4" />
                Assets by observed result
              </h3>
              {observedSymbols.length ? (
                <div className="mt-2 space-y-1.5">
                  {observedSymbols.slice(0, 6).map((row) => (
                    <div
                      key={row.symbol}
                      className="flex flex-wrap items-center justify-between gap-x-3 gap-y-0.5 border-t border-white/[0.05] pt-1.5 text-xs first:border-0 first:pt-0"
                    >
                      <span className="font-semibold text-white/85">
                        <PairBadge symbol={row.symbol} size={20} />
                      </span>
                      <span className="font-mono tabular-nums text-white/60">
                        n={row.count} · {(row.winRate * 100).toFixed(0)}% wins
                      </span>
                      <span
                        className={`font-mono tabular-nums ${RESULT_TONES[resultTone(row.netPnl)].text}`}
                      >
                        {money(row.netPnl)}
                      </span>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="mt-2 text-xs leading-5 text-white/45">
                  No symbol has {MIN_SYMBOL_SAMPLE} closed trades yet; ranking an asset now would be
                  misleading.
                </p>
              )}
              <p className="mt-2 text-[10px] leading-4 text-white/40">
                Historical ranking only, not a recommendation or prediction.
              </p>
            </div>
          </div>
          <div data-intelligence-tone="strategy" className="tb-neu-panel mt-3 rounded-2xl p-3">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <h3 className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-violet-200">
                <Layers3 aria-hidden="true" className="h-4 w-4" />
                Results by strategy
              </h3>
              <span className="text-[10px] text-white/40">
                Same closed-trade sample · no cross-book totals
              </span>
            </div>
            <div className="mt-2 grid gap-2 sm:grid-cols-2">
              {summary.byStrategy.map((row) => (
                <div
                  key={row.symbol}
                  className="min-w-0 rounded-xl border border-white/[0.06] bg-white/[0.02] px-3 py-2.5"
                >
                  <p className="break-words text-xs font-semibold text-white/85">{row.symbol}</p>
                  <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 font-mono text-[11px] tabular-nums text-white/65">
                    <span>{row.count} trades</span>
                    <span>{(row.winRate * 100).toFixed(1)}% wins</span>
                    <span className={RESULT_TONES[resultTone(row.netPnl)].text}>
                      {money(row.netPnl)}
                    </span>
                    <span>PF {row.profitFactor == null ? "—" : row.profitFactor.toFixed(2)}</span>
                  </div>
                  <div
                    className="mt-2 h-1.5 overflow-hidden rounded-full bg-black/40"
                    role="meter"
                    aria-label={`${row.symbol} observed win rate`}
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-valuenow={Number((row.winRate * 100).toFixed(1))}
                  >
                    <div
                      className="h-full rounded-full bg-gradient-to-r from-violet-400 to-cyan-300"
                      style={{ width: `${row.winRate * 100}%` }}
                    />
                  </div>
                  <p className="mt-1 text-[10px] leading-4 text-white/40">
                    {row.symbol === "Unattributed"
                      ? "No reliable strategy link was recorded for these trades."
                      : row.count < MIN_SYMBOL_SAMPLE
                        ? `Below ${MIN_SYMBOL_SAMPLE}-trade comparison minimum.`
                        : "Observed results, not a forward guarantee."}
                  </p>
                </div>
              ))}
            </div>
            <p className="mt-2 text-[10px] leading-4 text-white/40">
              Strategy attribution comes from the paper position or the live trade’s recorded
              strategy ID. Manual or legacy trades without that link remain unattributed; they are
              not assigned by symbol or wallet guesswork.
            </p>
          </div>
        </>
      )}

      <div data-intelligence-tone="risk" className="tb-neu-panel mt-3 rounded-2xl p-3">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h3 className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-amber-200">
            <Target aria-hidden="true" className="h-4 w-4" />
            Missed-opportunity audit
          </h3>
          <span className="font-mono text-[10px] text-white/40">Latest {book} Council cycle</span>
        </div>
        {shortlist.isLoading ? (
          <p className="mt-2 text-xs text-white/45">Loading candidate decisions…</p>
        ) : shortlist.isError ? (
          <p className="mt-2 text-xs text-amber-300">Candidate decisions unavailable.</p>
        ) : missed.length ? (
          <div className="mt-2 grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
            {missed.slice(0, 8).map((row) => (
              <div
                key={row.id}
                className="min-w-0 rounded-xl border border-white/[0.06] bg-white/[0.02] px-3 py-2"
              >
                <p className="font-mono text-xs font-semibold text-white/80">
                  {row.symbol} · {row.direction ?? "no side"}
                </p>
                <p className="mt-1 break-words text-[11px] leading-4 text-white/45">
                  {(row.rejectionReason ?? row.state).replaceAll("_", " ")}
                </p>
                <p className="mt-1 font-mono text-[10px] text-white/30">Outcome not linked</p>
              </div>
            ))}
          </div>
        ) : (
          <p className="mt-2 text-xs text-white/45">
            No unselected candidates recorded in this book’s latest Council cycle.
          </p>
        )}
        <p className="mt-2 text-[10px] leading-4 text-white/40">
          Rejected setups are decisions, not lost profit. The forward review below measures
          direction from the recorded decision close, not a fillable entry or trade P&amp;L.
        </p>
      </div>

      <div data-intelligence-tone="info" className="tb-neu-panel mt-3 rounded-2xl p-3">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h3 className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-cyan-200">
            <Compass aria-hidden="true" className="h-4 w-4" />
            Forward decision review
          </h3>
          <span className="font-mono text-[10px] text-white/40">
            1h / 4h / 24h · completed candles
          </span>
        </div>
        {feedback.isLoading ? (
          <p className="mt-2 text-xs text-white/45">Loading outcome ledger…</p>
        ) : feedback.isError ? (
          <p className="mt-2 text-xs text-amber-300">
            Outcome ledger unavailable; database migration or review worker may still need
            deployment.
          </p>
        ) : !feedback.data?.rows.length ? (
          <p className="mt-2 text-xs text-white/45">
            No rejected candidates have been recorded in the durable ledger for this {book} book
            yet.
          </p>
        ) : (
          <>
            <p className="mt-2 text-xs leading-5 text-white/60">
              {feedback.data.rows.length} recent decisions · {evaluated24h.length} completed 24h
              reviews
              {evaluated24h.length >= 10
                ? ` · ${favorable24h}/${evaluated24h.length} moved in the proposed direction`
                : " · at least 10 completed reviews needed before a directional rate is shown"}
              .
            </p>
            <div className="mt-2 grid gap-1.5 sm:grid-cols-2 xl:grid-cols-4">
              {feedback.data.rows.slice(0, 8).map((row) => {
                const results = (["1h", "4h", "24h"] as const).map((window) => {
                  const result = outcomeById.get(`${row.id}|${window}`);
                  return `${window} ${
                    result?.status === "complete" && result.net_pct !== null
                      ? `${(Number(result.net_pct) * 100).toFixed(2)}%`
                      : result?.status === "insufficient_data"
                        ? "no data"
                        : "pending"
                  }`;
                });
                return (
                  <div
                    key={row.id}
                    className="min-w-0 rounded-xl border border-white/[0.06] bg-white/[0.02] px-3 py-2"
                  >
                    <p className="font-mono text-xs font-semibold text-white/80">
                      {row.symbol} · {row.direction}
                    </p>
                    <p className="mt-1 break-words text-[10px] leading-4 text-white/45">
                      {(row.rejection_reason ?? "not selected").replaceAll("_", " ")}
                    </p>
                    <p className="mt-1 font-mono text-[10px] tabular-nums text-white/65">
                      {results.join(" · ")}
                    </p>
                  </div>
                );
              })}
            </div>
            <p className="mt-2 text-[10px] leading-4 text-white/40">
              These ex-post directional moves exclude spreads, fees, slippage, fills, exposure
              limits, and the path ordering of highs/lows. They identify decisions worth reviewing;
              they do not authorize a rule change or live order.
            </p>
          </>
        )}
      </div>
    </section>
  );
}
