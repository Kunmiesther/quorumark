import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import {
  ArrowRight,
  Check,
  CircleAlert,
  ExternalLink,
  Filter,
  LockKeyhole,
  Menu,
  Pause,
  Play,
  Search,
  ShieldCheck,
  Wallet,
  X,
} from "lucide-react";
import { toast } from "sonner";
import { PUBLIC_PYTHON_BACKEND_URL } from "@/lib/public-env";
import {
  evaluateSignal,
  loadExchangeState,
  recomputePerformance,
  saveExchangeState,
  type Metrics,
  type Strategy,
} from "@/lib/strategy-exchange";
import { getWalletSession, quorumarkApi } from "@/lib/quorumark-api";
import { WalletAccountMenu } from "@/components/wallet/WalletAccountMenu";

export type ExchangeView =
  "marketplace" | "detail" | "studio" | "follower" | "subscriptions" | "verification";
const fmt = (n: number) => n.toLocaleString(undefined, { maximumFractionDigits: 2 });

function buildFixtureCandles() {
  const end = Date.now();
  return Array.from({ length: 48 }, (_, index) => {
    const close = 68_000 * (1 + Math.sin(index * 0.71) * 0.012 + index * 0.001);
    return {
      timestamp: new Date(end - (47 - index) * 60 * 60 * 1000).toISOString(),
      open: close * 0.999,
      high: close * 1.004,
      low: close * 0.996,
      close,
      volume: 1_000,
      source: "quorumark_fixture",
      complete: true,
    };
  });
}

function Shell({
  children,
  wallet,
  onWallet,
}: {
  children: ReactNode;
  wallet?: string;
  onWallet: () => void;
}) {
  const [open, setOpen] = useState(false);
  const close = () => setOpen(false);
  return (
    <div className="q-exchange">
      <header className="q-exchange-header">
        <Link to="/marketplace" className="q-exchange-brand">
          <span className="q-mark">Q</span>
          <span>
            Quorumark <small>strategy exchange</small>
          </span>
        </Link>
        <nav className={open ? "q-mobile-open" : ""}>
          <Link to="/marketplace" onClick={close}>
            Marketplace
          </Link>
          <Link to="/studio" onClick={close}>
            Strategy Studio
          </Link>
          <Link to="/follower" onClick={close}>
            Follower Desk
          </Link>
          <Link to="/subscriptions" onClick={close}>
            Subscriptions
          </Link>
          <Link to="/verification" onClick={close}>
            Verification
          </Link>
        </nav>
        <div className="q-header-actions">
          <WalletAccountMenu />
          {/* WalletAccountMenu owns the connected state and session actions. */}
          <button className="q-wallet-button q-wallet-legacy-hidden" onClick={onWallet}>
            <Wallet size={16} />
            {wallet ? `${wallet.slice(0, 6)}…${wallet.slice(-4)}` : "Connect wallet"}
          </button>
          <button
            className="q-menu-button"
            aria-label={open ? "Close navigation" : "Open navigation"}
            onClick={() => setOpen(!open)}
          >
            {open ? <X size={19} /> : <Menu size={19} />}
          </button>
        </div>
      </header>
      <main className="q-exchange-main">{children}</main>
    </div>
  );
}

function Metric({ label, value, tone = "" }: { label: string; value: string; tone?: string }) {
  return (
    <div className="q-metric">
      <span>{label}</span>
      <strong className={tone}>{value}</strong>
    </div>
  );
}
function Chart({ values, label = "Equity curve" }: { values: number[]; label?: string }) {
  const min = Math.min(...values);
  const max = Math.max(...values);
  const points = values
    .map(
      (value, index) =>
        `${(index / Math.max(values.length - 1, 1)) * 100},${96 - ((value - min) / Math.max(max - min, 1)) * 76}`,
    )
    .join(" ");
  return (
    <svg
      className="q-chart"
      viewBox="0 0 100 100"
      preserveAspectRatio="none"
      role="img"
      aria-label={label}
    >
      <polyline
        points={points}
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}

type BackendStrategyRecord = {
  id: string;
  slug: string;
  name: string;
  thesis: string;
  market: string;
  supported_assets?: string[];
  risk_class: Strategy["risk"];
  cadence: string;
  monthly_price?: number;
  status: Strategy["status"];
  current_version: string;
  evidence_class: Strategy["evidence"];
  created_at: string;
};

type StrategyProposal = {
  name: string;
  description: string;
  thesis: string;
  instruments: string[];
  timeframe: string;
  indicators: { name: string; parameters: Record<string, number | string>; purpose: string }[];
  entry_conditions: string[];
  exit_conditions: string[];
  stop_loss: string;
  take_profit: string;
  position_sizing: string;
  risk_constraints: string[];
  unsupported_assumptions: string[];
  rationale: string;
};

export function StrategyExchangeApp({ view, slug }: { view: ExchangeView; slug?: string }) {
  const navigate = useNavigate();
  const [state, setState] = useState(loadExchangeState);
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("All strategies");
  const [providerBusy, setProviderBusy] = useState(false);
  const [ledgerError, setLedgerError] = useState<string | null>(null);
  const strategy = state.strategies.find((item) => item.slug === slug) ?? state.strategies[0];
  const update = (next: typeof state) => {
    setState(next);
    saveExchangeState(next);
  };

  useEffect(() => {
    const syncWallet = () => {
      const session = getWalletSession();
      setState((current) => ({ ...current, wallet: session?.address ?? null }));
    };
    syncWallet();
    window.addEventListener("quorumark-wallet-session", syncWallet);
    return () => window.removeEventListener("quorumark-wallet-session", syncWallet);
  }, []);

  useEffect(() => {
    if (view !== "marketplace") return;
    quorumarkApi<BackendStrategyRecord[]>("/v1/strategies")
      .then((records) => {
        const published = records.map((record) => ({
          id: String(record.id),
          slug: String(record.slug),
          name: String(record.name),
          creator: "Verified creator",
          creatorAddress: "wallet identity protected",
          thesis: String(record.thesis),
          market: String(record.market),
          assets: Array.isArray(record.supported_assets) ? record.supported_assets : [],
          risk: record.risk_class as Strategy["risk"],
          cadence: String(record.cadence),
          price: Number(record.monthly_price ?? 0),
          status: record.status as Strategy["status"],
          version: String(record.current_version),
          evidence: record.evidence_class as Strategy["evidence"],
          sample: false,
          metrics: {
            returnPct: 0,
            winRate: 0,
            drawdownPct: 0,
            trades: 0,
            costs: 0,
            equity: [10_000],
          },
          signals: [
            {
              id: `signal-${record.id}`,
              strategyId: String(record.id),
              asset: record.supported_assets?.[0] ?? "BTC",
              side: "long" as const,
              entry: 1,
              stop: 0.98,
              target: 1.04,
              sizePct: 10,
              createdAt: String(record.created_at),
            },
          ],
        }));
        if (published.length)
          setState((current) => ({
            ...current,
            strategies: [...published, ...current.strategies.filter((item) => item.sample)],
          }));
      })
      .catch(() => {
        // Public discovery remains usable with the clearly-labelled illustrative sample.
      });
  }, [view]);

  useEffect(() => {
    if (view !== "verification" || !PUBLIC_PYTHON_BACKEND_URL) return;
    const follower = state.wallet ?? "demo-follower";
    quorumarkApi<Array<{
      execution?: { price: number; realized_pnl: number; fee: number; timestamp: string; side: string; notional: number };
      execution_id?: string;
    }>>("/v1/paper/executions")
      .then(
        (records) => {
          const executions = records
            .filter((record) => record.execution)
            .map((record) => ({
              id: record.execution_id ?? "backend-paper",
              signalId: "backend",
              follower,
              asset: strategy.signals[0].asset,
              side: record.execution!.side,
              notional: record.execution!.notional,
              entry: strategy.signals[0].entry,
              exit: record.execution!.price,
              pnl: record.execution!.realized_pnl + record.execution!.fee,
              fee: record.execution!.fee,
              environment: "paper" as const,
              createdAt: record.execution!.timestamp,
            }));
          setState((current) => ({ ...current, executions }));
          setLedgerError(null);
        },
      )
      .catch((error) =>
        setLedgerError(
          error instanceof Error ? error.message : "The activity record could not be loaded",
        ),
      );
  }, [state.wallet, strategy.signals, view]);

  function connectWallet() {
    navigate({ to: "/connect-wallet" });
  }
  const categories = ["All strategies", ...new Set(state.strategies.map((item) => item.market))];
  const filtered = useMemo(
    () =>
      state.strategies
        .filter((item) => category === "All strategies" || item.market === category)
        .filter((item) =>
          `${item.name} ${item.creator} ${item.market} ${item.thesis}`
            .toLowerCase()
            .includes(query.toLowerCase()),
        ),
    [category, query, state.strategies],
  );
  async function subscribe() {
    if (strategy.sample) {
      toast.message("This is an illustrative sample; subscription is unavailable.");
      return;
    }
    if (!state.wallet) {
      toast.error("Authenticate a wallet before subscribing.");
      navigate({ to: "/connect-wallet" });
      return;
    }
    try {
      const result = await quorumarkApi<{ id: string; status: string }>("/v1/subscriptions", {
        method: "POST",
        body: JSON.stringify({ strategy_id: strategy.id, environment: "sandbox" }),
      });
      update({
        ...state,
        subscription: { strategyId: strategy.id, status: "active", receipt: result.id },
      });
      toast.success("Your practice subscription is active");
      navigate({ to: "/follower" });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Subscription could not be created");
    }
  }
  async function togglePause() {
    const nextPaused = !state.policy.paused;
    try {
      await quorumarkApi("/v1/follower/policy", {
        method: "PUT",
        body: JSON.stringify({
          capital: state.policy.capital,
          max_trade: state.policy.maxTrade,
          max_position: state.policy.maxPosition,
          max_loss: state.policy.maxLoss ?? 250,
          max_slippage_bps: state.policy.maxSlippage,
          approved_assets: state.policy.approvedAssets,
          paused: nextPaused,
        }),
      });
      update({ ...state, policy: { ...state.policy, paused: nextPaused } });
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Your following controls could not be saved",
      );
    }
  }
  async function runSignal() {
    if (!PUBLIC_PYTHON_BACKEND_URL) {
      toast.error("Paper following is not configured");
      return;
    }
    const candles = buildFixtureCandles();
    const sourceSignal = strategy.signals[0];
    const signal = {
      ...sourceSignal,
      createdAt: candles[0].timestamp,
      strategyVersion: strategy.version,
    };
    const fallbackDecision = evaluateSignal(
      sourceSignal,
      state.policy,
      state.wallet ?? "demo-follower",
    );
    if (state.decisions.some((item) => item.id === fallbackDecision.id)) {
      toast.message("This signal has already been reviewed");
      return;
    }
    setProviderBusy(true);
    try {
      const result = await quorumarkApi<any>("/v1/paper/executions", {
          method: "POST",
          body: JSON.stringify({
            follower_id: state.wallet ?? "demo-follower",
            signal: {
              id: signal.id,
              strategy_id: signal.strategyId,
              strategy_version: signal.strategyVersion,
              asset: signal.asset,
              side: signal.side,
              entry: signal.entry,
              stop: signal.stop,
              target: signal.target,
              size_pct: signal.sizePct,
              created_at: signal.createdAt,
            },
            policy: {
              capital: state.policy.capital,
              max_trade: state.policy.maxTrade,
              max_position: state.policy.maxPosition,
              max_loss: state.policy.maxLoss ?? 250,
              max_data_age_seconds: 86_400,
              fee_bps: 10,
              slippage_bps: 5,
              quantity_step: 0.000001,
              min_order_size: 0.000001,
              approved_assets: state.policy.approvedAssets,
              paused: state.policy.paused,
            },
            candles,
            source: "quorumark_fixture",
          }),
        });
      const decision = {
        id: `decision-${signal.id}-${state.wallet ?? "demo-follower"}`,
        signalId: signal.id,
        follower: state.wallet ?? "demo-follower",
        status: result.decision.status,
        reason: `${result.decision.reason_code}: ${result.decision.reason}`,
        notional: result.decision.notional,
        executionId: result.execution_id ?? undefined,
        at: new Date().toISOString(),
      } as const;
      const execution = result.execution
        ? {
            id: result.execution_id,
            signalId: signal.id,
            follower: state.wallet ?? "demo-follower",
            asset: signal.asset,
            side: signal.side,
            notional: result.execution.notional,
            entry: signal.entry,
            exit: result.execution.price,
            pnl: result.execution.realized_pnl + result.execution.fee,
            fee: result.execution.fee,
            environment: "paper" as const,
            createdAt: result.execution.timestamp,
          }
        : null;
      update({
        ...state,
        decisions: [...state.decisions, decision],
        executions: execution ? [...state.executions, execution] : state.executions,
      });
      toast.success(
        result.decision.status === "accepted"
          ? "Signal accepted for paper following"
          : "Signal rejected by your limits",
      );
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "The paper decision could not be completed",
      );
    } finally {
      setProviderBusy(false);
    }
  }

  return (
    <Shell wallet={state.wallet} onWallet={connectWallet}>
      {view === "marketplace" && (
        <Marketplace
          filtered={filtered}
          categories={categories}
          category={category}
          query={query}
          onCategory={setCategory}
          onQuery={setQuery}
        />
      )}
      {view === "detail" && <Detail strategy={strategy} onSubscribe={subscribe} />}
      {view === "studio" && (
        <Studio strategy={strategy} onBack={() => navigate({ to: "/marketplace" })} />
      )}
      {view === "follower" && (
        <Follower
          state={state}
          strategy={strategy}
          providerBusy={providerBusy}
          onPause={togglePause}
          onRun={runSignal}
        />
      )}
      {view === "subscriptions" && <Subscriptions state={state} />}
      {view === "verification" && (
        <Verification state={state} strategy={strategy} error={ledgerError} />
      )}
    </Shell>
  );
}

function Marketplace({
  filtered,
  categories,
  category,
  query,
  onCategory,
  onQuery,
}: {
  filtered: Strategy[];
  categories: string[];
  category: string;
  query: string;
  onCategory: (value: string) => void;
  onQuery: (value: string) => void;
}) {
  return (
    <section>
      <div className="q-market-hero">
        <div>
          <p className="q-kicker">The strategy exchange</p>
          <h1>Find a method you can inspect</h1>
          <p>
            Discover private strategies, compare their risk, and choose what deserves a closer look.
          </p>
        </div>
        <div className="q-market-signal">
          <span>Exchange status</span>
          <strong>Paper environment</strong>
          <i />
        </div>
      </div>
      <div className="q-market-toolbar">
        <label className="q-search-field">
          <Search size={16} />
          <input
            aria-label="Search strategies"
            placeholder="Search strategies or markets"
            value={query}
            onChange={(event) => onQuery(event.target.value)}
          />
        </label>
        <span className="q-result-count">
          {filtered.length} listed method{filtered.length === 1 ? "" : "s"}
        </span>
        <div className="q-filter-icon">
          <Filter size={15} /> Filter
        </div>
      </div>
      <div className="q-category-row">
        {categories.map((item) => (
          <button
            key={item}
            className={category === item ? "q-category-active" : ""}
            onClick={() => onCategory(item)}
          >
            {item}
          </button>
        ))}
      </div>
      {filtered.length ? (
        <div className="q-strategy-grid">
          {filtered.map((item) => (
            <article className="q-strategy-card" key={item.id}>
              <div className="q-card-agent">
                <span className="q-agent-orbit" />
                <span>{item.sample ? "Illustrative strategy" : "Published strategy"}</span>
                <small>{item.version}</small>
              </div>
              <div className="q-card-top">
                <span className="q-status">
                  <i /> {item.evidence.replace("_", " ")}
                </span>
                <span>{item.risk} risk</span>
              </div>
              <h2>{item.name}</h2>
              <p>{item.thesis}</p>
              <div className="q-card-meta">
                <span>{item.creator}</span>
                <span>{item.market}</span>
                <span>{item.cadence}</span>
              </div>
              <div className="q-card-stats">
                <Metric
                  label="Performance"
                  value={item.sample ? "Illustrative" : `${item.metrics.returnPct}%`}
                  tone={item.sample ? "" : "positive"}
                />
                <Metric
                  label="Drawdown"
                  value={item.sample ? "See record" : `${item.metrics.drawdownPct}%`}
                />
                <Metric label="Access" value={`$${item.price}/mo`} />
              </div>
              <Link to="/marketplace/$slug" params={{ slug: item.slug }} className="q-card-link">
                Inspect method <ArrowRight size={15} />
              </Link>
            </article>
          ))}
        </div>
      ) : (
        <div className="q-empty q-market-empty">
          <h2>No methods match that search</h2>
          <p>Try another market or clear the filter to see available strategies.</p>
        </div>
      )}
    </section>
  );
}

function Detail({ strategy, onSubscribe }: { strategy: Strategy; onSubscribe: () => void }) {
  const illustrative = strategy.sample;
  return (
    <section>
      <Link className="q-back" to="/marketplace">
        ← Back to marketplace
      </Link>
      <div className="q-detail-grid">
        <div>
          <div className="q-detail-kicker">
            <span className="q-kicker">
              {strategy.market} · {strategy.version}
            </span>
            <span className="q-status">
              <i /> {illustrative ? "Illustrative sample" : strategy.evidence.replace("_", " ")}
            </span>
          </div>
          <h1>{strategy.name}</h1>
          <p className="q-lede">{strategy.thesis}</p>
          <div className="q-chart-card q-detail-evidence">
            <div className="q-card-top">
              <span>{illustrative ? "Illustrative curve" : "Verified strategy curve"}</span>
              <span className="q-mono-label">{illustrative ? "Example only" : "From records"}</span>
            </div>
            <Chart values={strategy.metrics.equity} label="Strategy performance curve" />
            <div className="q-chart-labels">
              <span>{illustrative ? "Sample data" : "Starting equity"}</span>
              <span>
                {illustrative
                  ? "Not a return claim"
                  : `Latest $${fmt(strategy.metrics.equity.at(-1) ?? 0)}`}
              </span>
            </div>
          </div>
        </div>
        <aside className="q-side-card q-detail-aside">
          <span className="q-avatar">MO</span>
          <h2>{strategy.creator}</h2>
          <p>Creator identity</p>
          <code>{strategy.creatorAddress}</code>
          <hr />
          <Metric label="Subscription" value={`$${strategy.price} / month`} />
          <Metric label="Market" value={strategy.market} />
          <Metric label="Review cadence" value={strategy.cadence} />
          <button className="q-primary q-full" onClick={onSubscribe}>
            Follow this strategy <ArrowRight size={16} />
          </button>
          <small className="q-muted">
            <LockKeyhole size={13} /> Source logic stays private
          </small>
        </aside>
      </div>
      <div className="q-detail-panels">
        <div className="q-panel">
          <h3>How it behaves</h3>
          <p>
            Confirmed range breaks only. Position size starts from the follower's own sandbox
            capital and is checked against their policy before any paper decision.
          </p>
        </div>
        <div className="q-panel">
          <h3>Read the record</h3>
          <p>
            {illustrative
              ? "This is an illustrative sample for the marketplace interface. It is not a real creator or performance claim."
              : "The verification view recomputes performance from execution records and keeps paper evidence separate from live settlement."}
          </p>
          <Link to="/verification" className="q-text-link">
            Open verification <ExternalLink size={14} />
          </Link>
        </div>
      </div>
    </section>
  );
}

function Studio({ strategy, onBack }: { strategy: Strategy; onBack: () => void }) {
  const [metrics, setMetrics] = useState<Metrics | null>(null);
  const [name, setName] = useState("");
  const [prompt, setPrompt] = useState("");
  const [proposal, setProposal] = useState<StrategyProposal | null>(null);
  const [aiBusy, setAiBusy] = useState(false);
  const [dataSource, setDataSource] = useState<"fixture" | "historical">("fixture");
  const [dataSourceLabel, setDataSourceLabel] = useState("quorumark_fixture");
  const [backtestId, setBacktestId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedStrategyId, setSavedStrategyId] = useState<string | null>(null);
  const [savedVersionId, setSavedVersionId] = useState<string | null>(null);
  const [published, setPublished] = useState(false);
  const [anchoring, setAnchoring] = useState(false);
  const [publicationEvidence, setPublicationEvidence] = useState<{ status: string; transaction_hash?: string } | null>(null);
  const [publishing, setPublishing] = useState(false);
  async function generateProposal() {
    const wallet = getWalletSession();
    if (!wallet) {
      setError("Authenticate a NEAR wallet before asking the strategy agent for a proposal.");
      return;
    }
    if (!prompt.trim()) {
      setError("Describe the strategy you want the agent to shape.");
      return;
    }
    setAiBusy(true);
    setError(null);
    try {
      const result = await quorumarkApi<{ proposal: StrategyProposal }>("/v1/ai/strategy-proposals", {
        method: "POST",
        body: JSON.stringify({ prompt, current_proposal: proposal }),
      });
      setProposal(result.proposal);
      setName(result.proposal.name);
      toast.success(proposal ? "Strategy proposal refined" : "Strategy proposal ready for review");
    } catch (aiError) {
      setError(aiError instanceof Error ? aiError.message : "AI strategy assistance is unavailable");
    } finally {
      setAiBusy(false);
    }
  }
  async function runBacktest() {
    if (!PUBLIC_PYTHON_BACKEND_URL) {
      setError("Strategy testing is not configured. Start the local paper engine first.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      let candles = buildFixtureCandles();
      let source = "quorumark_fixture";
      if (dataSource === "historical") {
        const historical = await quorumarkApi<{ candles: typeof candles; provenance: { source: string } }>(
          "/v1/market-data/historical?symbol=BTCUSDT&interval=1h&limit=200",
        );
        candles = historical.candles;
        source = historical.provenance.source;
      }
      setDataSourceLabel(source);
      const response = await fetch(
        `${PUBLIC_PYTHON_BACKEND_URL.replace(/\/$/, "")}/v1/backtests/reference`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            candles,
            source,
            strategy: {
              fast_window: 3,
              slow_window: 8,
              initial_cash: 10_000,
              allocation_pct: 25,
              fee_bps: 10,
            },
          }),
        },
      );
      if (!response.ok) throw new Error(`Strategy testing returned HTTP ${response.status}`);
      const result = await response.json();
      setBacktestId(result.backtest_id ?? null);
      setMetrics({
        returnPct: result.performance.return_pct,
        winRate: result.performance.win_rate_pct,
        drawdownPct: result.performance.max_drawdown_pct,
        trades: result.performance.trade_count,
        costs: result.performance.fees,
        equity: result.equity_curve,
      });
    } catch (requestError) {
      setError(
        requestError instanceof Error
          ? requestError.message
          : "Strategy testing could not be completed",
      );
    } finally {
      setBusy(false);
    }
  }
  async function saveDraft(publish = false) {
    const wallet = getWalletSession();
    if (!wallet) {
      setError("Authenticate a wallet before saving a strategy draft.");
      return;
    }
    if (!name.trim()) {
      setError("Give your strategy a name before saving it.");
      return;
    }
    if (!metrics) {
      setError("Test the strategy first so its version has real performance evidence.");
      return;
    }
    setPublishing(true);
    setError(null);
    try {
      const created = savedStrategyId
        ? { id: savedStrategyId }
        : await quorumarkApi<{ id: string }>("/v1/strategies", {
            method: "POST",
            body: JSON.stringify({
              name,
              thesis: proposal?.thesis ?? "A creator-defined strategy tested against labeled market data.",
              market: "Crypto spot",
              supported_assets: proposal?.instruments ?? ["BTC", "ETH"],
              risk_class: "medium",
              cadence: "Every 4 hours",
              monthly_price: 0,
              definition: { type: "compiled_strategy_proposal", source: dataSourceLabel, proposal },
            }),
          });
      setSavedStrategyId(created.id);
      const version = await quorumarkApi<{ id: string }>(`/v1/strategies/${created.id}/versions`, {
        method: "POST",
        body: JSON.stringify({
          version: "v1.0",
          definition: { type: "compiled_strategy_proposal", source: dataSourceLabel, proposal },
          backtest_id: backtestId,
          backtest_metrics: metrics,
        }),
      });
      setSavedVersionId(version.id);
      if (publish) {
        await quorumarkApi(`/v1/strategies/${created.id}/publish`, { method: "POST" });
        setPublished(true);
        toast.success("Strategy published to the local paper marketplace");
      } else {
        toast.success("Strategy draft saved");
      }
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "The strategy could not be saved");
    } finally {
      setPublishing(false);
    }
  }
  async function anchorPublishedVersion() {
    if (!savedStrategyId || !savedVersionId) {
      setError("Publish this version before anchoring its evidence.");
      return;
    }
    setAnchoring(true);
    setError(null);
    try {
      const prepared = await quorumarkApi<{ version_id: string; commitment: string; creator_near_account: string; network: "near:testnet" }>(
        `/v1/strategies/${savedStrategyId}/publication-evidence`,
        { method: "POST", body: JSON.stringify({ version: "v1.0" }) },
      );
      const { ensureBrowserPolyfills } = await import("@/lib/browser-polyfills");
      await ensureBrowserPolyfills();
      const { anchorPublication } = await import("@/lib/near-publication-evidence");
      const submitted = await anchorPublication({
        strategy_id: savedStrategyId,
        version_id: prepared.version_id,
        creator_near_account: prepared.creator_near_account,
        network: prepared.network,
      }, prepared.commitment);
      const confirmed = await quorumarkApi<{ status: string; transaction_hash?: string }>(
        `/v1/strategies/${savedStrategyId}/publication-evidence/${prepared.version_id}/confirm`,
        { method: "POST", body: JSON.stringify({ transaction_hash: submitted.transaction_hash }) },
      );
      setPublicationEvidence(confirmed);
      toast.success("NEAR testnet publication evidence confirmed");
    } catch (anchorError) {
      setError(anchorError instanceof Error ? anchorError.message : "NEAR testnet evidence could not be confirmed");
    } finally {
      setAnchoring(false);
    }
  }
  return (
    <section>
      <button className="q-back" onClick={onBack}>
        ← Back to marketplace
      </button>
      <div className="q-page-heading">
        <div>
          <p className="q-kicker">Strategy Studio</p>
          <h1>Turn a method into something you can inspect</h1>
          <p>
            Describe your approach, choose its market, then study a paper simulation before
            publishing a version.
          </p>
        </div>
        <span className="q-status">
          <i /> Paper only
        </span>
      </div>
      <div className="q-studio-grid">
        <div className="q-panel q-form">
          <div className="q-form-step">
            <span>01</span>
            <div>
              <b>Describe the method</b>
              <small>What should the strategy watch for?</small>
            </div>
          </div>
          <label>
            Strategy name
            <input
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="For example, Atlas range break"
            />
          </label>
          <label>
            Strategy description
            <textarea
              value={prompt}
              onChange={(event) => setPrompt(event.target.value)}
              placeholder="Build a BTC momentum strategy that follows the medium-term trend, avoids high-volatility conditions, and uses conservative position sizing."
            />
          </label>
          <div className="q-form-row">
            <label>
              Markets
              <input defaultValue="BTC, ETH" />
            </label>
            <label>
              Review cadence
              <input defaultValue="Every 4 hours" />
            </label>
          </div>
          <div className="q-studio-agent-actions">
            <button className="q-primary" disabled={aiBusy} onClick={generateProposal}>
              {aiBusy ? "Thinking through the method…" : proposal ? "Refine with the strategy agent" : "Shape this with AI"} <ArrowRight size={16} />
            </button>
            <span>AI proposal only · review before it becomes a version</span>
          </div>
          <label>
            Backtest source
            <select value={dataSource} onChange={(event) => setDataSource(event.target.value as "fixture" | "historical")}>
              <option value="fixture">Sample market data · repeatable test</option>
              <option value="historical">Public historical market data · BTCUSDT hourly</option>
            </select>
          </label>
          {proposal && (
            <div className="q-notice q-ai-proposal">
              <ShieldCheck size={16} />
              <div>
                <strong>{proposal.name}</strong>
                <p>{proposal.thesis}</p>
                <small>{proposal.timeframe} · {proposal.indicators.map((item) => item.name).join(", ") || "No indicators specified"}</small>
              </div>
            </div>
          )}
          <button className="q-primary" disabled={busy} onClick={runBacktest}>
            {busy ? "Running the deterministic engine…" : "Run backtest"} <Play size={16} />
          </button>
          {error && (
            <div className="q-notice q-notice-error">
              <CircleAlert size={16} /> {error}
            </div>
          )}
        </div>
        <div className={`q-panel q-studio-results ${metrics ? "q-result-ready" : ""}`}>
          <div className="q-result-heading">
            <div>
              <p className="q-kicker">Your results</p>
              <h2>{metrics ? "Simulation complete" : "The result will appear here"}</h2>
            </div>
            <span className="q-result-state">
              <i /> {metrics ? "Backtested" : "Waiting for a test"}
            </span>
          </div>
          {metrics ? (
            <>
              <Chart values={metrics.equity} label="Backtest equity curve" />
              <div className="q-metric-grid">
                <Metric
                  label="Return"
                  value={`${metrics.returnPct >= 0 ? "+" : ""}${metrics.returnPct}%`}
                  tone="positive"
                />
                <Metric label="Drawdown" value={`${metrics.drawdownPct}%`} />
                <Metric label="Trades" value={String(metrics.trades)} />
                <Metric label="Costs" value={`$${fmt(metrics.costs)}`} />
              </div>
              <div className="q-notice">
                <ShieldCheck size={16} /> Calculated by the deterministic engine · {dataSourceLabel}
              </div>
              <div className="q-studio-actions">
                <button className="q-secondary" onClick={() => saveDraft()} disabled={publishing}>
                  {publishing ? "Saving…" : "Save draft"}
                </button>
                <button className="q-primary" onClick={() => saveDraft(true)} disabled={publishing}>
                  Publish version <ArrowRight size={15} />
                </button>
              </div>
              {published && !publicationEvidence && (
                <div className="q-notice">
                  <ShieldCheck size={16} />
                  <span>Hosted publication is complete. You can optionally anchor this version on NEAR testnet.</span>
                  <button className="q-secondary" onClick={anchorPublishedVersion} disabled={anchoring}>
                    {anchoring ? "Waiting for wallet…" : "Anchor on NEAR testnet"}
                  </button>
                </div>
              )}
              {publicationEvidence?.transaction_hash && (
                <div className="q-notice q-notice-success">
                  <Check size={16} /> NEAR testnet evidence confirmed · {publicationEvidence.transaction_hash}
                </div>
              )}
            </>
          ) : (
            <div className="q-result-empty">
              <div className="q-result-glyph">↗</div>
              <p>
                Run a test to see the actual equity curve, trade count, drawdown, and execution
                costs returned by the strategy engine.
              </p>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

function Follower({
  state,
  strategy,
  providerBusy,
  onPause,
  onRun,
}: {
  state: ReturnType<typeof loadExchangeState>;
  strategy: Strategy;
  providerBusy: boolean;
  onPause: () => void;
  onRun: () => void;
}) {
  return (
    <section>
      <div className="q-page-heading">
        <div>
          <p className="q-kicker">Follower Desk</p>
          <h1>Follow a method on your terms</h1>
          <p>Every signal meets your limits first. The creator never controls your capital.</p>
        </div>
        <button className="q-secondary" onClick={onPause}>
          {state.policy.paused ? <Play size={16} /> : <Pause size={16} />}
          {state.policy.paused ? "Resume following" : "Pause following"}
        </button>
      </div>
      {!state.subscription && (
        <div className="q-notice">
          <CircleAlert size={18} />
          <span>Choose a strategy before reviewing private signals</span>
          <Link to="/marketplace">Browse strategies</Link>
        </div>
      )}
      <div className="q-follower-grid">
        <div className="q-panel q-policy-panel">
          <div className="q-card-top">
            <h2>Your risk limits</h2>
            <span className="q-status">
              <i /> Checked by the engine
            </span>
          </div>
          <div className="q-policy-grid">
            <Metric label="Sandbox capital" value={`$${fmt(state.policy.capital)}`} />
            <Metric label="Max trade" value={`$${fmt(state.policy.maxTrade)}`} />
            <Metric label="Max position" value={`$${fmt(state.policy.maxPosition)}`} />
            <Metric label="Approved assets" value={state.policy.approvedAssets.join(", ")} />
          </div>
          <p className="q-muted">
            These limits belong to you. A subscription never overrides them.
          </p>
        </div>
        <div className="q-panel q-signal-panel">
          <div className="q-card-top">
            <h2>Latest private signal</h2>
            <span>One decision at a time</span>
          </div>
          <div className="q-signal-route">
            <span className="q-route-step">Signal</span>
            <i />
            <span className="q-route-step">Your rules</span>
            <i />
            <span className="q-route-step">Paper record</span>
          </div>
          <div className="q-signal">
            <strong>
              {strategy.signals[0].asset} · {strategy.signals[0].side}
            </strong>
            <span>
              Entry ${fmt(strategy.signals[0].entry)} · target ${fmt(strategy.signals[0].target)}
            </span>
            <button
              className="q-primary"
              disabled={!state.subscription || providerBusy}
              onClick={onRun}
            >
              <ShieldCheck size={16} /> {providerBusy ? "Reviewing signal…" : "Review signal"}
            </button>
          </div>
        </div>
      </div>
      <div className="q-panel q-audit-panel">
        <div className="q-card-top">
          <h2>Decision activity</h2>
          <span>{state.decisions.length} reviewed</span>
        </div>
        {state.decisions.length === 0 ? (
          <div className="q-empty">
            Your first signal decision will appear here with the exact rule that accepted or
            rejected it.
          </div>
        ) : (
          state.decisions.map((decision) => (
            <div className="q-audit-row" key={decision.id}>
              <span
                className={decision.status === "accepted" ? "q-dot-positive" : "q-dot-negative"}
              />
              <div>
                <strong>
                  {decision.status === "accepted" ? "Accepted" : "Rejected"} ·{" "}
                  {strategy.signals[0].asset}
                </strong>
                <p>{decision.reason}</p>
              </div>
              <code>{decision.executionId ? "Paper record" : "Policy stop"}</code>
            </div>
          ))
        )}
      </div>
    </section>
  );
}

function Subscriptions({ state }: { state: ReturnType<typeof loadExchangeState> }) {
  return (
    <section>
      <p className="q-kicker">Your access</p>
      <h1>Subscriptions</h1>
      <p className="q-lede">Manage the strategies you have chosen to follow.</p>
      <div className="q-panel q-subscription-row">
        <div>
          <span className="q-status">
            <i /> {state.subscription ? "Practice subscription active" : "No active subscription"}
          </span>
          <h2>{state.subscription ? "Aurora Breakout" : "Discover a strategy"}</h2>
          <p>
            {state.subscription
              ? "Private signals are available in your Follower Desk."
              : "Compare methods and choose one to review."}
          </p>
        </div>
        {state.subscription ? (
          <Link className="q-primary" to="/follower">
            Open Follower Desk <ArrowRight size={16} />
          </Link>
        ) : (
          <Link className="q-primary" to="/marketplace">
            Explore strategies <ArrowRight size={16} />
          </Link>
        )}
      </div>
    </section>
  );
}

function Verification({
  state,
  strategy,
  error,
}: {
  state: ReturnType<typeof loadExchangeState>;
  strategy: Strategy;
  error: string | null;
}) {
  const metrics = recomputePerformance(state.executions, state.policy.capital);
  return (
    <section>
      {error && (
        <div className="q-notice q-notice-error">
          <CircleAlert size={16} /> {error}
        </div>
      )}
      <p className="q-kicker">Evidence record</p>
      <h1>See what the record supports</h1>
      <p className="q-lede">
        Verification recomputes the ledger and keeps simulation evidence separate from blockchain
        settlement.
      </p>
      <div className="q-verification-grid">
        <div className="q-panel q-ledger-panel">
          <div className="q-card-top">
            <div>
              <h2>Follower activity</h2>
              <span className="q-mono-label">
                {strategy.name} · {strategy.version}
              </span>
            </div>
            <span>
              {state.executions.length} record{state.executions.length === 1 ? "" : "s"}
            </span>
          </div>
          {state.executions.length ? (
            state.executions.map((execution) => (
              <div className="q-audit-row" key={execution.id}>
                <span className="q-dot-positive" />
                <div>
                  <strong>
                    {execution.asset} {execution.side}
                  </strong>
                  <p>Paper record · {new Date(execution.createdAt).toLocaleString()}</p>
                </div>
                <b>${fmt(execution.pnl - execution.fee)}</b>
              </div>
            ))
          ) : (
            <div className="q-empty">
              No paper records yet. Review a signal in the Follower Desk to create one.
            </div>
          )}
        </div>
        <div className="q-panel q-verification-result">
          <p className="q-kicker">Recomputed locally</p>
          <h2>Performance summary</h2>
          <div className="q-metric-stack">
            <Metric
              label="Net return"
              value={`${metrics.returnPct >= 0 ? "+" : ""}${metrics.returnPct}%`}
              tone="positive"
            />
            <Metric label="Win rate" value={`${metrics.winRate}%`} />
            <Metric label="Drawdown" value={`${metrics.drawdownPct}%`} />
            <Metric label="Execution costs" value={`$${fmt(metrics.costs)}`} />
          </div>
          <div className="q-evidence-chain">
            <span>Strategy version</span>
            <i />
            <span>Risk decision</span>
            <i />
            <span>Paper record</span>
          </div>
          <p className="q-muted">
            <Check size={14} /> Recomputed from saved practice records. This is not a blockchain
            verified result.
          </p>
        </div>
      </div>
    </section>
  );
}
