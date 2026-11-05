import { useId, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Bot, Check, ChevronLeft, ChevronRight, Gauge, ShieldCheck, Target } from "lucide-react";
import { listBills } from "@/lib/bills/bills.functions";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { buildAutopilotProposal } from "@/lib/automation/autopilotGraph";
import { supportsLivePlan } from "../../../supabase/functions/_shared/live-plan-route-policy";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { toast } from "sonner";

type RiskMode = "conservative" | "moderate" | "aggressive";

interface PlannerStrategy {
  id: string;
  slug: string;
  suit_name: string;
  description: string;
}
type PlannerBill = {
  id: string;
  name: string;
  amount_usd: number;
  category: string | null;
  cadence: string;
};
type PlannerConnection = {
  id: string;
  exchange: string;
  display_name: string | null;
  status: string;
  permissions_verified: boolean;
  permission_read: boolean;
};
type PlannerWallet = {
  id: string;
  label: string | null;
  public_address: string;
  assigned_exchange_connection_id: string | null;
  status: string;
};

const SYMBOLS = ["BTC-USDT", "ETH-USDT", "SOL-USDT", "XRP-USDT"] as const;
const TURTLE_KEY: Record<string, string> = {
  dca: "accumulator",
  "break-retest": "vanguard",
  "rsi-divergence": "sniper",
  "liq-hunting": "hunter",
  "funding-arb": "arbiter",
};

interface AutopilotPlannerModalProps {
  setupBook?: "paper" | "live";
  strategy: PlannerStrategy;
  availableStrategies: PlannerStrategy[];
  onClose: () => void;
  onContinue: () => void;
}

const MODES: Array<{ id: RiskMode; label: string; description: string; tone: string }> = [
  {
    id: "conservative",
    label: "Conservative",
    description: "Fewer opportunities, smaller exposure, strongest pause limits.",
    tone: "#14F195",
  },
  {
    id: "moderate",
    label: "Moderate",
    description: "Balanced opportunity frequency and portfolio protection.",
    tone: "#4EA8FF",
  },
  {
    id: "aggressive",
    label: "Aggressive",
    description: "More exposure and opportunity, still inside platform limits.",
    tone: "#E4677A",
  },
];
const DAY_OPTIONS = [
  { value: 1, label: "M" },
  { value: 2, label: "T" },
  { value: 3, label: "W" },
  { value: 4, label: "T" },
  { value: 5, label: "F" },
  { value: 6, label: "S" },
  { value: 0, label: "S" },
] as const;

export function AutopilotPlannerModal({
  setupBook = "paper",
  strategy,
  availableStrategies,
  onClose,
  onContinue,
}: AutopilotPlannerModalProps) {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const fetchBills = useServerFn(listBills);
  const billsQ = useQuery({
    queryKey: ["bills"],
    queryFn: () => fetchBills(),
    staleTime: 10_000,
  });
  const bills = useMemo(() => (billsQ.data ?? []) as PlannerBill[], [billsQ.data]);
  const [step, setStep] = useState(0);
  const [name, setName] = useState(`${strategy.suit_name} daily plan`);
  const [goalId, setGoalId] = useState("growth");
  const [capital, setCapital] = useState("100");
  const [lossLimit, setLossLimit] = useState("25");
  const [leverage, setLeverage] = useState("");
  const [maxDailyEntries, setMaxDailyEntries] = useState("1");
  const [maxOpenPositions, setMaxOpenPositions] = useState("1");
  const [targetDays, setTargetDays] = useState("30");
  const [mode, setMode] = useState<RiskMode>("conservative");
  const [activeDays, setActiveDays] = useState<number[]>([0, 1, 2, 3, 4, 5, 6]);
  const [windowStart, setWindowStart] = useState("00:00");
  const [windowEnd, setWindowEnd] = useState("23:59");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const starterTurtle = TURTLE_KEY[strategy.slug] ?? "accumulator";
  const [connectionId, setConnectionId] = useState("");
  const [venueBySymbol, setVenueBySymbol] = useState<Record<string, string>>({});
  const [walletBySymbol, setWalletBySymbol] = useState<Record<string, string>>({});
  const [symbols, setSymbols] = useState<string[]>([...SYMBOLS]);
  const [enabledTurtles, setEnabledTurtles] = useState<string[]>([starterTurtle]);
  const connectionsQ = useQuery({
    queryKey: ["autopilot-verified-connections", user?.id, setupBook],
    enabled: Boolean(user),
    queryFn: async () => {
      const { data, error } = await supabase
        .from("exchange_connections")
        .select("id,exchange,display_name,status,environment,permissions_verified,permission_read,permission_trade")
        .eq("user_id", user!.id)
        .eq("status", "verified")
        .eq("permissions_verified", true)
        .eq("permission_read", true)
        .order("updated_at", { ascending: false });
      if (error) throw error;
      return (data ?? []).filter(connection => setupBook !== "live" || supportsLivePlan(connection)) as PlannerConnection[];
    },
  });
  const effectiveConnectionId = connectionId || connectionsQ.data?.[0]?.id || "";
  const walletsQ = useQuery({
    queryKey: ["autopilot-active-wallets", user?.id],
    enabled: Boolean(user),
    queryFn: async (): Promise<PlannerWallet[]> => {
      const { data, error } = await supabase
        .from("wallet_connections")
        .select("id,label,public_address,assigned_exchange_connection_id,status")
        .eq("user_id", user!.id)
        .eq("is_active", true);
      if (error) throw error;
      return data ?? [];
    },
  });
  const venueAssignments = symbols.map((symbol) => ({
    symbol,
    connectionId: venueBySymbol[symbol] || effectiveConnectionId,
    walletConnectionId: walletBySymbol[symbol] || null,
  }));

  const selectedBill = useMemo(() => bills.find((bill) => bill.id === goalId), [bills, goalId]);
  const selectedMode = MODES.find((item) => item.id === mode)!;
  const leverageMax = venueAssignments.some((assignment) =>
    connectionsQ.data?.some(
      (connection) =>
        connection.id === assignment.connectionId && connection.exchange === "apex_omni",
    ),
  )
    ? 100
    : 125;
  const leverageValid =
    Number.isInteger(Number(leverage)) && Number(leverage) >= 1 && Number(leverage) <= leverageMax;
  const canContinue =
    step !== 1 ||
    (name.trim().length > 0 &&
      Number(capital) > 0 &&
      Number(lossLimit) > 0 &&
      Number(lossLimit) <= Number(capital) &&
      Number(targetDays) > 0 &&
      activeDays.length > 0 &&
      effectiveConnectionId.length > 0 &&
      symbols.length > 0 &&
      (setupBook !== "live" || leverageValid) &&
      Number.isInteger(Number(maxDailyEntries)) && Number(maxDailyEntries) >= 1 && Number(maxDailyEntries) <= 100 &&
      Number.isInteger(Number(maxOpenPositions)) && Number(maxOpenPositions) >= 1 && Number(maxOpenPositions) <= 6 &&
      enabledTurtles.length > 0);

  const steps = ["Goal", "Assessment", "Mode", "Review"];

  async function approvePlan() {
    if (!user) return toast.error("Sign in to save an Autopilot plan.");
    setSaving(true);
    setSaveError(null);
    try {
      const proposal = await buildAutopilotProposal({
        setupBook,
        name,
        goalId,
        goalLabel: selectedBill?.name ?? "Grow trading balance",
        strategyId: strategy.id,
        strategyName: strategy.suit_name,
        authorizedCapital: Number(capital),
        lossLimit: Number(lossLimit),
        targetDays: Number(targetDays),
        riskMode: mode,
        scheduleEnabled: true,
        activeDays,
        windowStart,
        windowEnd,
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
        maxDailyEntries: Number(maxDailyEntries),
        maxOpenPositions: Number(maxOpenPositions),
        connectionId: effectiveConnectionId,
        venueAssignments,
        symbols,
        enabledTurtles,
        marginPct: 5,
        rungCount: 5,
        incomeAllocationPct: 100,
        ...(leverage.trim() ? { leverage: Number(leverage) } : {}),
      });
      const { data, error } = await supabase.functions.invoke("autopilot-plan", {
        body: { action: setupBook === "live" ? "configure_live" : "approve_for_paper", proposal },
      });
      if (error || !data?.ok) {
        let message = data?.message;
        if (!message && error && "context" in error && error.context instanceof Response) {
          const response = await error.context
            .clone()
            .json()
            .catch(() => null);
          message = response?.message;
        }
        throw new Error(message ?? error?.message ?? "Could not save this plan.");
      }
      toast.success(
        setupBook === "live"
          ? "Live mandate saved, not armed. Review the owner controls to start."
          : "Plan approved for paper validation.",
      );
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["autopilot-workflows", user.id] }),
        queryClient.invalidateQueries({ queryKey: ["configured-strategies", user.id] }),
        queryClient.invalidateQueries({ queryKey: ["automation-strategy-config", user.id] }),
      ]);
      onContinue();
    } catch (error) {
      const message = error instanceof Error ? error.message : "Could not save this plan.";
      setSaveError(message);
      toast.error(message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[92dvh] max-w-md lg:max-w-2xl overflow-y-auto rounded-[28px] border-white/10 bg-[#11121a] p-0 shadow-[18px_18px_42px_rgba(0,0,0,.75),-8px_-8px_24px_rgba(91,70,120,.16)]">
        <DialogHeader className="border-b border-white/[0.06] px-5 pb-4 pt-5 text-left">
          <div className="mb-3 flex items-center justify-between text-[10px] font-semibold uppercase tracking-[0.18em] text-white/40">
            <span>Autopilot plan</span>
            <span>
              {step + 1} / {steps.length}
            </span>
          </div>
          <div
            className="mb-3 grid grid-cols-4 gap-1.5"
            aria-label={`Step ${step + 1} of ${steps.length}`}
          >
            {steps.map((label, index) => (
              <div key={label} className="space-y-1">
                <div
                  className={`h-1 rounded-full ${index <= step ? "bg-[#9945FF]" : "bg-white/[0.07]"}`}
                />
                <span
                  className={`text-[9px] ${index === step ? "text-white/75" : "text-white/30"}`}
                >
                  {label}
                </span>
              </div>
            ))}
          </div>
          <DialogTitle className="font-display text-xl">Plan with Onyx</DialogTitle>
          <DialogDescription>
            Connect a real goal to {strategy.suit_name}. This plans the automation; it does not
            promise a return.
          </DialogDescription>
        </DialogHeader>

        <div className="px-5 py-5">
          {step === 0 && (
            <section className="space-y-3" aria-labelledby="autopilot-goal-heading">
              <div className="flex items-center gap-2">
                <Target className="h-4 w-4 text-[#9945FF]" />
                <h2 id="autopilot-goal-heading" className="font-semibold">
                  What should this plan support?
                </h2>
              </div>
              <button
                type="button"
                onClick={() => setGoalId("growth")}
                className={`w-full rounded-2xl border p-4 text-left ${goalId === "growth" ? "border-[#9945FF]/60 bg-[#9945FF]/10" : "border-white/[0.07] bg-black/20"}`}
              >
                <p className="text-sm font-semibold">Grow trading balance</p>
                <p className="mt-1 text-xs text-white/45">
                  Run Autopilot without attaching a bill.
                </p>
              </button>
              {bills.map((bill) => (
                <button
                  key={bill.id}
                  type="button"
                  onClick={() => setGoalId(bill.id)}
                  className={`flex w-full items-center justify-between rounded-2xl border p-4 text-left ${goalId === bill.id ? "border-[#9945FF]/60 bg-[#9945FF]/10" : "border-white/[0.07] bg-black/20"}`}
                >
                  <div>
                    <p className="text-sm font-semibold">{bill.name}</p>
                    <p className="mt-1 text-[11px] uppercase tracking-wider text-white/40">
                      {bill.category ?? "Life Map"} · {bill.cadence}
                    </p>
                  </div>
                  <span className="font-mono text-sm">
                    ${Number(bill.amount_usd).toLocaleString()}
                  </span>
                </button>
              ))}
              {!billsQ.isLoading && bills.length === 0 && (
                <p className="rounded-2xl border border-dashed border-white/10 p-4 text-xs leading-5 text-white/45">
                  No Life Map bills yet. You can continue with balance growth or add a bill from
                  Life Map first.
                </p>
              )}
              {billsQ.isError && (
                <p className="rounded-2xl border border-rose-400/20 p-4 text-xs text-rose-200">
                  Bills could not be loaded. Retry before selecting a Life Map target.
                </p>
              )}
              <p className="text-xs leading-5 text-white/45">
                This bill is a tracking target. Realized income is allocated across all bills by
                Life Map priority; selecting it does not direct funds or pay it.
                {setupBook === "paper"
                  ? " Simulation results are not live funds."
                  : " Live results are recorded only after exchange-confirmed closes."}
              </p>
            </section>
          )}

          {step === 1 && (
            <section className="space-y-4" aria-labelledby="autopilot-assessment-heading">
              <div className="flex items-center gap-2">
                <Bot className="h-4 w-4 text-[#9945FF]" />
                <h2 id="autopilot-assessment-heading" className="font-semibold">
                  Onyx needs three boundaries
                </h2>
              </div>
              <Field label="Plan name" type="text" value={name} onChange={setName} />
              <div className="space-y-1.5">
                <Label htmlFor="autopilot-venue">Trading venue</Label>
                <select
                  id="autopilot-venue"
                  value={effectiveConnectionId}
                  onChange={(event) => {
                    setConnectionId(event.target.value);
                    setWalletBySymbol({});
                  }}
                  className="h-11 w-full rounded-xl border border-white/[0.07] bg-black/25 px-3 text-sm"
                >
                  {connectionsQ.data?.map((connection) => (
                    <option key={connection.id} value={connection.id}>
                      {connection.display_name || connection.exchange}
                    </option>
                  ))}
                </select>
                {!connectionsQ.isLoading && !connectionsQ.data?.length ? (
                  <p className="text-xs text-[#E4677A]">
                    Connect and verify a readable venue first.
                  </p>
                ) : null}
              </div>
              <ChoiceGrid
                label="Symbols Scout will scan for this mandate"
                values={SYMBOLS.map((symbol) => ({
                  key: symbol,
                  label: symbol.replace("-USDT", ""),
                }))}
                selected={symbols}
                onToggle={(symbol) =>
                  setSymbols((current) =>
                    current.includes(symbol)
                      ? current.filter((value) => value !== symbol)
                      : [...current, symbol],
                  )
                }
              />
              <div className="space-y-2">
                <Label>Where each symbol trades</Label>
                <p className="text-xs leading-5 text-white/45">
                  Choose a verified exchange for every symbol. A connected wallet can be tied to its
                  assigned exchange; venue accounts that do not use a wallet may leave it blank.
                  {setupBook === "live"
                    ? " ApeX Omni and Aster support automated order routes. Saving a plan does not arm it: review each symbol and resume its exchange separately. Other venues remain unavailable for live automation."
                    : ""}
                </p>
                {venueAssignments.map((assignment) => {
                  const eligibleWallets = (walletsQ.data ?? []).filter(
                    (wallet) =>
                      wallet.assigned_exchange_connection_id === assignment.connectionId &&
                      ["connected", "verified"].includes(wallet.status),
                  );
                  return (
                    <div
                      key={assignment.symbol}
                      className="rounded-2xl border border-white/[0.07] bg-black/20 p-3"
                    >
                      <p className="mb-2 text-xs font-semibold text-white/80">
                        {assignment.symbol}
                      </p>
                      <div className="grid gap-2 sm:grid-cols-2">
                        <select
                          aria-label={`${assignment.symbol} exchange`}
                          value={assignment.connectionId}
                          onChange={(event) => {
                            setVenueBySymbol((current) => ({
                              ...current,
                              [assignment.symbol]: event.target.value,
                            }));
                            setWalletBySymbol((current) => ({
                              ...current,
                              [assignment.symbol]: "",
                            }));
                          }}
                          className="min-w-0 rounded-xl border border-white/10 bg-[#15151e] px-2 py-2 text-xs"
                        >
                          {(connectionsQ.data ?? []).map((venue) => (
                            <option key={venue.id} value={venue.id}>
                              {venue.display_name || venue.exchange}
                            </option>
                          ))}
                        </select>
                        <select
                          aria-label={`${assignment.symbol} wallet`}
                          value={assignment.walletConnectionId ?? ""}
                          onChange={(event) =>
                            setWalletBySymbol((current) => ({
                              ...current,
                              [assignment.symbol]: event.target.value,
                            }))
                          }
                          className="min-w-0 rounded-xl border border-white/10 bg-[#15151e] px-2 py-2 text-xs"
                        >
                          <option value="">Venue account / no wallet</option>
                          {eligibleWallets.map((wallet) => (
                            <option key={wallet.id} value={wallet.id}>
                              {wallet.label ||
                                `${wallet.public_address.slice(0, 6)}…${wallet.public_address.slice(-4)}`}
                            </option>
                          ))}
                        </select>
                      </div>
                    </div>
                  );
                })}
              </div>
              <ChoiceGrid
                label="Trading Turtles Onyx may route to"
                values={availableStrategies.map((item) => ({
                  key: TURTLE_KEY[item.slug] ?? item.slug,
                  label: item.suit_name,
                }))}
                selected={enabledTurtles}
                onToggle={(turtle) =>
                  setEnabledTurtles((current) =>
                    current.includes(turtle)
                      ? current.filter((value) => value !== turtle)
                      : [...current, turtle],
                  )
                }
              />
              <Field
                label={
                  setupBook === "live" ? "Risk reference capital" : "Paper validation bankroll"
                }
                prefix="$"
                value={capital}
                onChange={setCapital}
              />
              <Field
                label="Maximum loss before pausing"
                prefix="$"
                value={lossLimit}
                onChange={setLossLimit}
              />
              {setupBook === "live" && (
                <div className="space-y-2">
                  <Field
                    label={`Leverage ceiling (1–${leverageMax}×)`}
                    value={leverage}
                    onChange={setLeverage}
                    suffix="×"
                  />
                  <p className="text-xs text-white/60">
                    Required for live orders. Choose your ceiling explicitly; symbol and venue
                    limits may lower the executed leverage. Risk mode does not set this value.
                  </p>
                </div>
              )}
              <Field label="Daily entry limit (1–100)" value={maxDailyEntries} onChange={setMaxDailyEntries} />
              <Field label="Concurrent position limit (1–6)" value={maxOpenPositions} onChange={setMaxOpenPositions} />
              <Field
                label="Planning horizon"
                suffix="days"
                value={targetDays}
                onChange={setTargetDays}
              />
              <div className="rounded-2xl border border-violet-400/15 bg-violet-400/[0.06] p-3 text-xs leading-5 text-white/55">
                Locked execution policy: 5% of the current wallet balance, divided into five equal
                rungs. The validation bankroll above measures results; it never caps campaign
                sizing. Available collateral and exchange limits still apply.
              </div>
              <div className="space-y-2">
                <Label>Days this plan may run</Label>
                <div className="grid grid-cols-7 gap-1.5">
                  {DAY_OPTIONS.map((day, index) => {
                    const selected = activeDays.includes(day.value);
                    return (
                      <button
                        key={`${day.value}-${index}`}
                        type="button"
                        aria-pressed={selected}
                        aria-label={`${["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"][day.value]} ${selected ? "selected" : "not selected"}`}
                        onClick={() =>
                          setActiveDays((days) =>
                            selected
                              ? days.filter((value) => value !== day.value)
                              : [...days, day.value],
                          )
                        }
                        className={`grid h-10 place-items-center rounded-xl border text-xs font-semibold ${selected ? "border-[#9945FF]/60 bg-[#9945FF]/15 text-violet-200" : "border-white/[0.07] bg-black/20 text-white/35"}`}
                      >
                        {day.label}
                      </button>
                    );
                  })}
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <TimeField label="Start" value={windowStart} onChange={setWindowStart} />
                <TimeField label="End" value={windowEnd} onChange={setWindowEnd} />
              </div>
              {!canContinue && (
                <p className="text-xs text-[#E4677A]">
                  The pause limit must be positive and cannot exceed authorized capital.
                </p>
              )}
            </section>
          )}

          {step === 2 && (
            <section className="space-y-3" aria-labelledby="autopilot-mode-heading">
              <div className="flex items-center gap-2">
                <Gauge className="h-4 w-4 text-[#9945FF]" />
                <h2 id="autopilot-mode-heading" className="font-semibold">
                  Choose your operating mode
                </h2>
              </div>
              {MODES.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => setMode(item.id)}
                  className={`w-full rounded-2xl border p-4 text-left ${mode === item.id ? "bg-white/[0.06]" : "border-white/[0.07] bg-black/20"}`}
                  style={{ borderColor: mode === item.id ? `${item.tone}88` : undefined }}
                >
                  <div className="flex items-center justify-between">
                    <p className="font-semibold" style={{ color: item.tone }}>
                      {item.label}
                    </p>
                    {mode === item.id && <Check className="h-4 w-4" style={{ color: item.tone }} />}
                  </div>
                  <p className="mt-1 text-xs leading-5 text-white/45">{item.description}</p>
                </button>
              ))}
            </section>
          )}

          {step === 3 && (
            <section className="space-y-4" aria-labelledby="autopilot-review-heading">
              <div className="flex items-center gap-2">
                <ShieldCheck className="h-4 w-4 text-[#14F195]" />
                <h2 id="autopilot-review-heading" className="font-semibold">
                  {setupBook === "live" ? "Review live automation setup" : "Approve the paper plan"}
                </h2>
              </div>
              <div className="rounded-2xl border border-white/[0.07] bg-black/25 p-4">
                <ReviewRow
                  label="Tracked target"
                  value={selectedBill?.name ?? "Grow trading balance"}
                />
                <ReviewRow label="Plan" value={name.trim()} />
                <ReviewRow label="Turtle" value={strategy.suit_name} />
                <ReviewRow
                  label="Venue / wallet map"
                  value={venueAssignments
                    .map((assignment) => {
                      const venue = connectionsQ.data?.find(
                        (item) => item.id === assignment.connectionId,
                      );
                      const wallet = walletsQ.data?.find(
                        (item) => item.id === assignment.walletConnectionId,
                      );
                      return `${assignment.symbol.replace("-USDT", "")} → ${venue?.display_name || venue?.exchange || "Unassigned"}${wallet ? ` / ${wallet.label || `${wallet.public_address.slice(0, 6)}…`}` : ""}`;
                    })
                    .join(" · ")}
                />
                <ReviewRow
                  label="Symbols"
                  value={symbols.map((symbol) => symbol.replace("-USDT", "")).join(", ")}
                />
                <ReviewRow label="Trading Turtles" value={`${enabledTurtles.length} enabled`} />
                <ReviewRow label="Entry limits" value={`${maxDailyEntries} per day · ${maxOpenPositions} concurrent`} />
                <ReviewRow label="Sizing" value="5% dynamic margin · 5 rungs" />
                {setupBook === "live" && (
                  <ReviewRow label="Leverage ceiling" value={`${leverage}×`} />
                )}
                <ReviewRow
                  label="Life Map ledger"
                  value={
                    setupBook === "live"
                      ? "Confirmed net P&L by bill priority"
                      : "Positive net P&L by bill priority; paper separate"
                  }
                />
                <ReviewRow label="Mode" value={selectedMode.label} />
                <ReviewRow
                  label={
                    setupBook === "live" ? "Risk reference capital" : "Paper validation bankroll"
                  }
                  value={`$${Number(capital).toLocaleString()}`}
                />
                <ReviewRow
                  label="Pause after loss"
                  value={`$${Number(lossLimit).toLocaleString()}`}
                />
                <ReviewRow label="Planning horizon" value={`${Number(targetDays)} days`} />
                <ReviewRow
                  label="Schedule"
                  value={`${activeDays.length} days · ${windowStart}–${windowEnd}`}
                />
              </div>
              <p className="rounded-2xl bg-[#14F195]/[0.06] p-4 text-xs leading-5 text-white/55">
                Ledger allocations do not move money or pay a bill. Your selected bill is tracked,
                while allocation follows Life Map priority. The bill amount will not increase trade
                size; platform and exchange limits still apply.
                {setupBook === "paper"
                  ? " Paper results remain simulated."
                  : " Saving this live mandate does not arm it. Only supported, verified venue routes can be armed from the owner controls."}
              </p>
            </section>
          )}
        </div>

        {saveError && (
          <p
            role="alert"
            className="mx-5 rounded-xl border border-amber-300/25 bg-amber-300/5 p-3 text-xs text-amber-100"
          >
            {saveError}
          </p>
        )}
        <div className="flex gap-2 border-t border-white/[0.06] px-5 py-4">
          <Button
            variant="ghost"
            onClick={() => (step === 0 ? onClose() : setStep((value) => value - 1))}
          >
            <ChevronLeft className="mr-1 h-4 w-4" /> {step === 0 ? "Cancel" : "Back"}
          </Button>
          <Button
            className="ml-auto"
            disabled={!canContinue || saving}
            onClick={() =>
              step === steps.length - 1 ? void approvePlan() : setStep((value) => value + 1)
            }
          >
            {step === steps.length - 1
              ? saving
                ? "Saving…"
                : setupBook === "live"
                  ? "Save live mandate"
                  : "Approve for paper"
              : "Continue"}
            {step < steps.length - 1 && <ChevronRight className="ml-1 h-4 w-4" />}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function Field({
  label,
  value,
  onChange,
  prefix,
  suffix,
  type = "number",
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  prefix?: string;
  suffix?: string;
  type?: "number" | "text";
}) {
  const inputId = useId();
  return (
    <div className="space-y-1.5">
      <Label htmlFor={inputId}>{label}</Label>
      <div className="flex items-center rounded-xl border border-white/[0.07] bg-black/25 px-3">
        {prefix && <span className="text-sm text-white/40">{prefix}</span>}
        <Input
          id={inputId}
          type={type}
          min={type === "number" ? "1" : undefined}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          className="border-0 bg-transparent shadow-none focus-visible:ring-0"
        />
        {suffix && <span className="whitespace-nowrap text-xs text-white/40">{suffix}</span>}
      </div>
    </div>
  );
}

function TimeField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <div className="space-y-1.5">
      <Label>{label}</Label>
      <Input
        type="time"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="border-white/[0.07] bg-black/25"
      />
    </div>
  );
}

function ReviewRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between border-b border-white/[0.05] py-2.5 last:border-0">
      <span className="text-xs text-white/40">{label}</span>
      <span className="text-right text-sm font-semibold">{value}</span>
    </div>
  );
}

function ChoiceGrid({
  label,
  values,
  selected,
  onToggle,
}: {
  label: string;
  values: Array<{ key: string; label: string }>;
  selected: string[];
  onToggle: (key: string) => void;
}) {
  return (
    <div className="space-y-2">
      <Label>{label}</Label>
      <div className="grid grid-cols-2 gap-2">
        {values.map((value) => {
          const active = selected.includes(value.key);
          return (
            <button
              key={value.key}
              type="button"
              aria-pressed={active}
              onClick={() => onToggle(value.key)}
              className={`rounded-xl border px-3 py-2 text-left text-xs font-semibold transition ${
                active
                  ? "border-violet-400/50 bg-violet-400/[0.12] text-violet-100"
                  : "border-white/[0.07] bg-black/20 text-white/40"
              }`}
            >
              {value.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}
