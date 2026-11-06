import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import { ArrowRight, Check, CircleAlert, ExternalLink, LockKeyhole, Menu, Pause, Play, ShieldCheck, Wallet, X } from "lucide-react";
import { toast } from "sonner";
import { PUBLIC_PYTHON_BACKEND_URL } from "@/lib/public-env";
import { evaluateSignal, loadExchangeState, recomputePerformance, saveExchangeState, type Metrics, type RiskPolicy, type Strategy } from "@/lib/strategy-exchange";

export type ExchangeView = "marketplace" | "detail" | "studio" | "follower" | "subscriptions" | "verification";
const fmt = (n: number) => n.toLocaleString(undefined, { maximumFractionDigits: 2 });
function buildFixtureCandles() {
  const end = Date.now();
  return Array.from({ length: 48 }, (_, index) => {
    const close = 68_000 * (1 + Math.sin(index * 0.71) * 0.012 + index * 0.001);
    return { timestamp: new Date(end - (47 - index) * 60 * 60 * 1000).toISOString(), open: close * 0.999, high: close * 1.004, low: close * 0.996, close, volume: 1_000, source: "quorumark_fixture", complete: true };
  });
}

function Shell({ children, wallet, onWallet }: { children: ReactNode; wallet?: string; onWallet: () => void }) {
  const [open, setOpen] = useState(false);
  return <div className="q-exchange"><header className="q-exchange-header"><Link to="/marketplace" className="q-exchange-brand"><span className="q-mark">Q</span><span>Quorumark <small>strategy exchange</small></span></Link><nav className={open ? "q-mobile-open" : ""}><Link to="/marketplace" onClick={() => setOpen(false)}>Marketplace</Link><Link to="/studio" onClick={() => setOpen(false)}>Strategy Studio</Link><Link to="/follower" onClick={() => setOpen(false)}>Follower Desk</Link><Link to="/verification" onClick={() => setOpen(false)}>Verification</Link></nav><div className="q-header-actions"><button className="q-wallet-button" onClick={onWallet}><Wallet size={16}/>{wallet ? `${wallet.slice(0, 6)}…${wallet.slice(-4)}` : "Connect wallet"}</button><button className="q-menu-button" aria-label={open ? "Close navigation" : "Open navigation"} onClick={() => setOpen(!open)}>{open ? <X size={19} /> : <Menu size={19} />}</button></div></header><main className="q-exchange-main">{children}</main></div>;
}

function Metric({ label, value, tone = "" }: { label: string; value: string; tone?: string }) { return <div className="q-metric"><span>{label}</span><strong className={tone}>{value}</strong></div>; }
function Chart({ values }: { values: number[] }) { const min = Math.min(...values); const max = Math.max(...values); const points = values.map((v, i) => `${(i / Math.max(values.length - 1, 1)) * 100},${96 - ((v - min) / Math.max(max - min, 1)) * 76}`).join(" "); return <svg className="q-chart" viewBox="0 0 100 100" preserveAspectRatio="none" aria-label="Equity curve"><polyline points={points} fill="none" stroke="currentColor" strokeWidth="2" vectorEffect="non-scaling-stroke"/></svg>; }

export function StrategyExchangeApp({ view, slug }: { view: ExchangeView; slug?: string }) {
  const navigate = useNavigate();
  const [state, setState] = useState(loadExchangeState);
  const [query, setQuery] = useState("");
  const strategy = state.strategies.find((item) => item.slug === slug) ?? state.strategies[0];
  const [providerBusy, setProviderBusy] = useState(false);
  const [ledgerError, setLedgerError] = useState<string | null>(null);
  const update = (next: typeof state) => { setState(next); saveExchangeState(next); };
  useEffect(() => {
    if (view !== "verification" || !PUBLIC_PYTHON_BACKEND_URL) return;
    const follower = state.wallet ?? "demo-follower";
    fetch(`${PUBLIC_PYTHON_BACKEND_URL.replace(/\/$/, "")}/v1/paper/executions/${encodeURIComponent(follower)}`)
      .then(async (response) => { if (!response.ok) throw new Error(`Paper ledger returned HTTP ${response.status}`); return response.json(); })
      .then((records: Array<{ execution?: { price: number; realized_pnl: number; fee: number; timestamp: string; side: string; notional: number }; execution_id?: string }>) => {
        const executions = records.filter((record) => record.execution).map((record) => ({ id: record.execution_id ?? "backend-paper", signalId: "backend", follower, asset: strategy.signals[0].asset, side: record.execution!.side, notional: record.execution!.notional, entry: strategy.signals[0].entry, exit: record.execution!.price, pnl: record.execution!.realized_pnl + record.execution!.fee, fee: record.execution!.fee, environment: "paper" as const, createdAt: record.execution!.timestamp }));
        setState((current) => ({ ...current, executions }));
        setLedgerError(null);
      })
      .catch((error) => setLedgerError(error instanceof Error ? error.message : "The paper ledger could not be loaded"));
  }, [state.wallet, strategy.signals, view]);
  function connectWallet() { navigate({ to: "/connect-wallet" }); }
  const filtered = useMemo(() => state.strategies.filter((item) => `${item.name} ${item.creator} ${item.market}`.toLowerCase().includes(query.toLowerCase())), [query, state.strategies]);
  function subscribe() { update({ ...state, subscription: { strategyId: strategy.id, status: "active", receipt: `sandbox-receipt-${Date.now()}` } }); toast.success("Sandbox entitlement active"); navigate({ to: "/follower" }); }
  async function runSignal() {
    if (!PUBLIC_PYTHON_BACKEND_URL) { toast.error("Python paper engine is not configured"); return; }
    const candles = buildFixtureCandles();
    const sourceSignal = strategy.signals[0];
    const signal = { ...sourceSignal, createdAt: candles[0].timestamp, strategyVersion: strategy.version };
    const fallbackDecision = evaluateSignal(sourceSignal, state.policy, state.wallet ?? "demo-follower");
    const existing = state.decisions.some((item) => item.id === fallbackDecision.id);
    if (existing) { toast.message("This signal is already accounted for"); return; }
    try {
      const response = await fetch(`${PUBLIC_PYTHON_BACKEND_URL.replace(/\/$/, "")}/v1/paper/executions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ follower_id: state.wallet ?? "demo-follower", signal: { id: signal.id, strategy_id: signal.strategyId, strategy_version: signal.strategyVersion, asset: signal.asset, side: signal.side, entry: signal.entry, stop: signal.stop, target: signal.target, size_pct: signal.sizePct, created_at: signal.createdAt }, policy: { capital: state.policy.capital, max_trade: state.policy.maxTrade, max_position: state.policy.maxPosition, max_loss: state.policy.maxLoss ?? 250, max_data_age_seconds: 86_400, fee_bps: 10, quantity_step: 0.000001, min_order_size: 0.000001, approved_assets: state.policy.approvedAssets, paused: state.policy.paused }, candles, source: "quorumark_fixture" }) });
      if (!response.ok) throw new Error(`Python engine returned HTTP ${response.status}`);
      const result = await response.json();
      const decision = { id: `decision-${signal.id}-${state.wallet ?? "demo-follower"}`, signalId: signal.id, follower: state.wallet ?? "demo-follower", status: result.decision.status, reason: `${result.decision.reason_code}: ${result.decision.reason}`, notional: result.decision.notional, executionId: result.execution_id ?? undefined, at: new Date().toISOString() } as const;
      const execution = result.execution ? { id: result.execution_id, signalId: signal.id, follower: state.wallet ?? "demo-follower", asset: signal.asset, side: signal.side, notional: result.execution.notional, entry: signal.entry, exit: result.execution.price, pnl: result.execution.realized_pnl + result.execution.fee, fee: result.execution.fee, environment: "paper" as const, createdAt: result.execution.timestamp } : null;
      update({ ...state, decisions: [...state.decisions, decision], executions: execution ? [...state.executions, execution] : state.executions });
      toast.success(result.decision.status === "accepted" ? "Backend policy approved paper execution" : "Backend policy rejected the signal");
    } catch (error) { toast.error(error instanceof Error ? error.message : "The Python paper engine could not be reached"); }
  }
  return <Shell wallet={state.wallet} onWallet={connectWallet}>{view === "marketplace" && <section><div className="q-page-heading"><div><p className="q-kicker">The strategy exchange</p><h1>Find a method you can inspect</h1><p>Private signals, public evidence, and risk rules that stay with the follower.</p></div><Link className="q-primary" to="/studio">Create a strategy <ArrowRight size={16}/></Link></div><div className="q-search-row"><input aria-label="Search strategies" placeholder="Search strategies, creators, markets" value={query} onChange={(event) => setQuery(event.target.value)}/><span>{filtered.length} published strategy{filtered.length === 1 ? "" : "ies"}</span></div><div className="q-strategy-grid">{filtered.map((item) => <article className="q-strategy-card" key={item.id}><div className="q-card-top"><span className="q-status"><i/> Paper verified</span><span>{item.version}</span></div><h2>{item.name}</h2><p>{item.thesis}</p><div className="q-card-meta"><span>{item.creator}</span><span>{item.market}</span><span>{item.risk} risk</span></div><div className="q-card-stats"><Metric label="Return" value={`+${item.metrics.returnPct}%`} tone="positive"/><Metric label="Drawdown" value={`${item.metrics.drawdownPct}%`}/><Metric label="Access" value={`$${item.price}/mo`}/></div><Link to="/marketplace/$slug" params={{ slug: item.slug }} className="q-card-link">Inspect strategy <ArrowRight size={15}/></Link></article>)}</div></section>}
  {view === "detail" && <section><Link className="q-back" to="/marketplace">← Back to exchange</Link><div className="q-detail-grid"><div><p className="q-kicker">{strategy.market} · {strategy.version}</p><h1>{strategy.name}</h1><p className="q-lede">{strategy.thesis}</p><div className="q-chart-card"><div className="q-card-top"><span>Paper traded equity curve</span><span className="q-status"><i/> {strategy.evidence.replace("_", " ")}</span></div><Chart values={strategy.metrics.equity}/><div className="q-chart-labels"><span>Start $10,000</span><span>Latest ${fmt(strategy.metrics.equity.at(-1) ?? 0)}</span></div></div></div><aside className="q-side-card"><span className="q-avatar">MO</span><h2>{strategy.creator}</h2><p>Creator wallet <code>{strategy.creatorAddress}</code></p><hr/><Metric label="Monthly access" value={`$${strategy.price}`} /><Metric label="Version" value={strategy.version}/><button className="q-primary q-full" onClick={subscribe}>Subscribe in sandbox <ArrowRight size={16}/></button><small className="q-muted"><LockKeyhole size={13}/> Source code stays private. Signals are delivered to your account only.</small></aside></div><div className="q-detail-panels"><div className="q-panel"><h3>What the rules do</h3><p>Confirmed range breaks only. Position size is expressed as a percentage of your own sandbox capital, then checked against your policy before any paper fill.</p></div><div className="q-panel"><h3>Evidence, not promises</h3><p>This result is labeled paper traded. The verification page recomputes metrics from immutable execution records. It is not a live verified return.</p><Link to="/verification" className="q-text-link">Open verification <ExternalLink size={14}/></Link></div></div></section>}
  {view === "studio" && <Studio strategy={strategy} onBack={() => navigate({ to: "/marketplace" })}/>}
  {view === "follower" && <section><div className="q-page-heading"><div><p className="q-kicker">Follower desk</p><h1>Signals meet your risk policy</h1><p>Every follower receives an independent decision. The creator never controls your capital.</p></div><button className="q-secondary" onClick={() => update({ ...state, policy: { ...state.policy, paused: !state.policy.paused } })}>{state.policy.paused ? <Play size={16}/> : <Pause size={16}/>} {state.policy.paused ? "Resume execution" : "Pause execution"}</button></div>{!state.subscription && <div className="q-notice"><CircleAlert size={18}/><span>Subscribe to a strategy before processing private signals</span><Link to="/marketplace">Browse strategies</Link></div>}<div className="q-follower-grid"><div className="q-panel"><div className="q-card-top"><h2>My risk policy</h2><span className="q-status"><i/> Enforced server side</span></div><div className="q-policy-grid"><Metric label="Sandbox capital" value={`$${fmt(state.policy.capital)}`}/><Metric label="Max trade" value={`$${fmt(state.policy.maxTrade)}`}/><Metric label="Max position" value={`$${fmt(state.policy.maxPosition)}`}/><Metric label="Approved assets" value={state.policy.approvedAssets.join(", ")}/></div><p className="q-muted">Change these limits in your account policy. A signal is never auto accepted because a subscription is active.</p></div><div className="q-panel"><div className="q-card-top"><h2>Latest private signal</h2><span>Deduplicated by signal id</span></div><div className="q-signal"><strong>{strategy.signals[0].asset} · {strategy.signals[0].side}</strong><span>Entry ${fmt(strategy.signals[0].entry)} · target ${fmt(strategy.signals[0].target)}</span><button className="q-primary" disabled={!state.subscription || providerBusy} onClick={runSignal}><ShieldCheck size={16}/> Evaluate and paper execute</button></div></div></div><div className="q-panel"><h2>Decision audit</h2>{state.decisions.length === 0 ? <div className="q-empty">No decisions yet. The next signal will show the exact rule that accepted or rejected it.</div> : state.decisions.map((decision) => <div className="q-audit-row" key={decision.id}><span className={decision.status === "accepted" ? "q-dot-positive" : "q-dot-negative"}/><div><strong>{decision.status === "accepted" ? "Accepted" : "Rejected"} · {strategy.signals[0].asset}</strong><p>{decision.reason}</p></div><code>{decision.executionId ? "paper fill" : "policy stop"}</code></div>)}</div></section>}
  {view === "subscriptions" && <section><p className="q-kicker">Subscriptions</p><h1>Access and receipts</h1><div className="q-panel q-subscription-row"><div><h2>{state.subscription ? strategy.name : "No active entitlements"}</h2><p>{state.subscription ? "Sandbox subscription · renews manually" : "Choose a strategy to receive private signals"}</p></div>{state.subscription ? <span className="q-status"><i/> Active</span> : <Link className="q-primary" to="/marketplace">Discover strategies</Link>}</div></section>}
  {view === "verification" && <section><p className="q-kicker">Verification</p><h1>Recompute the record</h1><p className="q-lede">Metrics below come from paper execution records, with fees separated from strategy P&L.</p><div className="q-verification-grid"><div className="q-panel"><div className="q-card-top"><h2>Follower execution ledger</h2><span>{state.executions.length} record{state.executions.length === 1 ? "" : "s"}</span></div>{state.executions.length ? state.executions.map((execution) => <div className="q-audit-row" key={execution.id}><span className="q-dot-positive"/><div><strong>{execution.asset} {execution.side}</strong><p>Paper receipt {execution.id}</p></div><b>+${fmt(execution.pnl - execution.fee)}</b></div>) : <div className="q-empty">Execute a subscribed signal from the follower desk to create the first verifiable record.</div>}</div><div className="q-panel"><h2>Recomputed performance</h2>{(() => { const metrics = recomputePerformance(state.executions, state.policy.capital); return <div className="q-metric-stack"><Metric label="Net return" value={`${metrics.returnPct >= 0 ? "+" : ""}${metrics.returnPct}%`} tone="positive"/><Metric label="Win rate" value={`${metrics.winRate}%`}/><Metric label="Execution costs" value={`$${fmt(metrics.costs)}`}/><Metric label="Evidence class" value="Paper traded"/></div>; })()}<p className="q-muted"><Check size={14}/> Deterministic recomputation from the ledger. No hash is presented as proof of settlement.</p></div></div></section>}
  </Shell>;
}

function Studio({ strategy, onBack }: { strategy: Strategy; onBack: () => void }) {
  const [metrics, setMetrics] = useState<Metrics | null>(null);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function runBacktest() {
    if (!PUBLIC_PYTHON_BACKEND_URL) {
      setError("Python strategy engine is not configured. Set VITE_PYTHON_BACKEND_URL and start the backend.");
      return;
    }
    setBusy(true);
    setError(null);
    const candles = Array.from({ length: 48 }, (_, index) => {
      const close = 68_000 * (1 + Math.sin(index * 0.71) * 0.012 + index * 0.001);
      return { timestamp: new Date(Date.now() - (47 - index) * 60 * 60 * 1000).toISOString(), open: close * 0.999, high: close * 1.004, low: close * 0.996, close, source: "quorumark_fixture", complete: true };
    });
    try {
      const response = await fetch(`${PUBLIC_PYTHON_BACKEND_URL.replace(/\/$/, "")}/v1/backtests/reference`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ candles, strategy: { fast_window: 3, slow_window: 8, initial_cash: 10_000, allocation_pct: 25, fee_bps: 10 } }),
      });
      if (!response.ok) throw new Error(`Python engine returned HTTP ${response.status}`);
      const result = await response.json();
      setMetrics({ returnPct: result.performance.return_pct, winRate: result.performance.win_rate_pct, drawdownPct: result.performance.max_drawdown_pct, trades: result.performance.trade_count, costs: result.performance.fees, equity: result.equity_curve });
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "The Python strategy engine could not be reached.");
    } finally {
      setBusy(false);
    }
  }

  const displayedMetrics = metrics ?? strategy.metrics;
  return <section><button className="q-back" onClick={onBack}>← Back to marketplace</button><div className="q-page-heading"><div><p className="q-kicker">Strategy Studio</p><h1>Turn a method into something you can inspect</h1><p>Describe your approach, choose the market it watches, then study a paper simulation before publishing a version.</p></div><span className="q-status"><i/> Paper only</span></div><div className="q-studio-grid"><div className="q-panel q-form"><label>Strategy name<input value={name} onChange={(e) => setName(e.target.value)} placeholder="For example, Atlas range break"/></label><label>Describe your strategy<textarea defaultValue="A rules based strategy with confirmed entries, explicit exits, and a defined risk budget."/></label><div className="q-form-row"><label>Markets<input defaultValue="BTC, ETH"/></label><label>Review cadence<input defaultValue="Every 4 hours"/></label></div><button className="q-primary" disabled={busy} onClick={runBacktest}>{busy ? "Testing your strategy…" : "Test my strategy"} <Play size={16}/></button>{error && <div className="q-notice q-notice-error">{error}</div>}</div><div className="q-panel q-studio-results"><div className="q-card-top"><h2>{metrics ? "Your simulation" : "Your results"}</h2><span>{metrics ? "Historical paper simulation" : "Run a test to see your curve"}</span></div><Chart values={displayedMetrics.equity}/><div className="q-metric-grid"><Metric label="Return" value={`${displayedMetrics.returnPct >= 0 ? "+" : ""}${displayedMetrics.returnPct}%`} tone="positive"/><Metric label="Drawdown" value={`${displayedMetrics.drawdownPct}%`}/><Metric label="Trades" value={String(displayedMetrics.trades)}/><Metric label="Costs" value={`$${fmt(displayedMetrics.costs)}`}/></div><div className="q-notice"><ShieldCheck size={16}/> {metrics ? "Calculated from the paper simulation and labeled backtested." : "Results appear here after a real simulation."}</div></div></div></section>;
}
