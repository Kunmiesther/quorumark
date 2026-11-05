import { createFileRoute } from "@tanstack/react-router";
import { lazy, Suspense, useState } from "react";
import { ChevronDown, ChevronUp, Loader2, Settings2 } from "lucide-react";
import { SuiteSelectCard } from "@/components/turtle/SuiteSelectCard";
import { CouncilSettings } from "@/components/automation/CouncilSettings";
import { AutopilotPlanStatus } from "@/components/automation/AutopilotPlanStatus";
import { AutomationOperationsPanel } from "@/components/automation/AutomationOperationsPanel";
import { AutomationIncomePanel } from "@/components/automation/AutomationIncomePanel";
import { LiveReviewDesk } from "@/components/automation/LiveReviewDesk";
import { SafetySummary } from "@/components/shared/SafetySummary";
import { AutopilotOnyxChat } from "@/components/automation/AutopilotOnyxChat";
import { AutomationMandates } from "@/components/automation/AutomationMandates";
import { AutomationObservatory } from "@/components/automation/AutomationObservatory";

const OnyxDecisionsPanel = lazy(() =>
  import("@/components/onyx/OnyxDecisionsPanel").then((module) => ({
    default: module.OnyxDecisionsPanel,
  })),
);

export const Route = createFileRoute("/_authenticated/automation")({
  component: AutomationPage,
  head: () => ({ meta: [{ title: "Autopilot — TurtleBot" }] }),
});

function AutomationPage() {
  const [book, setBook] = useState<"live" | "paper">("live");
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [showCouncilActivity, setShowCouncilActivity] = useState(true);
  const openBuilder = () => {
    window.setTimeout(
      () => document.getElementById("automation-builder")?.scrollIntoView({ behavior: "smooth" }),
      0,
    );
  };

  return (
    <main className="mx-auto w-full max-w-[1600px] px-4 pb-6 pt-4 sm:px-6 lg:px-8 lg:pb-10 lg:pt-6">
      <header className="flex min-w-0 items-end justify-between gap-4">
        <div>
          <p className="text-[10px] uppercase tracking-[0.22em] text-violet-300/75">
            Automation control
          </p>
          <h1 className="font-display text-2xl lg:text-3xl">Autopilot</h1>
          <p className="mt-1 max-w-2xl text-xs text-white/45 sm:text-sm">
            {book === "live"
              ? "Live venue positions, automation authority, Council evidence, and owner controls."
              : "Build and validate strategies without submitting live orders."}
          </p>
        </div>
        <div className="hidden items-center gap-2 lg:flex">
          <span className="rounded-full border border-emerald-400/20 bg-emerald-400/[0.08] px-3 py-1.5 text-[10px] font-semibold uppercase tracking-[0.16em] text-emerald-300">
            Owner controlled
          </span>
          <span className="rounded-full border border-white/10 bg-white/[0.04] px-3 py-1.5 text-[10px] font-semibold uppercase tracking-[0.16em] text-white/50">
            {book === "live" ? "Live operations" : "Paper simulation"}
          </span>
        </div>
      </header>

      <section className="tb-neu-panel mt-5 rounded-[24px] p-3 sm:p-4" aria-label="Autopilot mode">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-white/40">
              Operating view
            </p>
            <p className="mt-1 text-sm font-semibold text-white">
              {book === "live" ? "Live automation" : "Paper simulation"}
            </p>
          </div>
          <div
            className="tb-neu-inset flex w-full rounded-2xl p-1 sm:w-auto"
            role="tablist"
            aria-label="Autopilot operating view"
          >
            {(["live", "paper"] as const).map((value) => (
              <button
                key={value}
                id={`autopilot-${value}-tab`}
                type="button"
                role="tab"
                aria-selected={book === value}
                aria-controls="autopilot-mode-panel"
                onClick={() => setBook(value)}
                className={`${book === value ? "tb-neu-raised text-white" : "text-white/45 hover:text-white"} flex-1 rounded-xl px-4 py-2 text-xs font-semibold sm:flex-none`}
              >
                {value === "live"
                  ? "Live automation"
                  : book === "live"
                    ? "Simulation"
                    : "Paper simulation"}
              </button>
            ))}
          </div>
        </div>
        <p className="mt-2 text-xs leading-5 text-white/45">
          {book === "live"
            ? "Viewing Live does not arm a strategy. Check readiness and use the owner controls below to arm or pause each symbol."
            : "Paper decisions and P&L are simulated. Switching views does not change any strategy's execution mode."}
        </p>
      </section>

      <div id="autopilot-mode-panel" role="tabpanel" aria-labelledby={`autopilot-${book}-tab`}>
        <section
          className="mt-5 grid min-w-0 gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(320px,0.8fr)]"
          aria-label="Autopilot setup"
        >
          <div className="tb-neu-panel min-w-0 rounded-[28px] p-4 lg:p-5">
            <p className="text-[10px] uppercase tracking-[0.18em] text-violet-300/75">
              Your automation workflow
            </p>
            <h2 className="mt-1 font-display text-xl">From setup to monitored trades</h2>
            <ol className="mt-4 grid gap-2 sm:grid-cols-2">
              {[
                "Choose Turtles and BTC, ETH, SOL, or XRP",
                "Assign each symbol to an exchange and wallet",
                "Link a Life Map target and review risk limits",
                "Approve execution, then monitor venue evidence",
              ].map((step, index) => (
                <li
                  key={step}
                  className="tb-neu-inset flex min-w-0 gap-3 rounded-2xl p-3 text-xs text-white/65"
                >
                  <span className="font-mono text-violet-200">0{index + 1}</span>
                  <span>{step}</span>
                </li>
              ))}
            </ol>
            <p className="mt-3 text-xs leading-5 text-white/45">
              Onyx explains each choice, but cannot silently authorize trading. A saved plan, an
              armed strategy, and an exchange-confirmed fill are shown as different states.
            </p>
            <button
              type="button"
              onClick={openBuilder}
              className="tb-neu-raised mt-4 rounded-full px-4 py-2.5 text-xs font-semibold text-violet-200"
            >
              Open guided plan builder
            </button>
          </div>
          <AutopilotOnyxChat onOpenBuilder={openBuilder} />
        </section>
        {book === "live" ? (
          <>
            <AutomationMandates />
            <LiveReviewDesk />
          </>
        ) : (
          <ActivationPath />
        )}
        <section id="automation-operations">
          <AutomationOperationsPanel book={book} />
        </section>
        <section id="automation-builder" className="mt-5 min-w-0">
          <SuiteSelectCard embedded setupBook={book} />
          {book === "paper" ? <AutopilotPlanStatus /> : null}
        </section>
        <AutomationObservatory book={book} />
      </div>

      <div className="mt-5 min-w-0">
        <aside className="min-w-0">
          <section className="tb-neu-panel rounded-[28px] p-4 lg:sticky lg:top-5 lg:p-5">
            <button
              type="button"
              onClick={() => setShowAdvanced((open) => !open)}
              aria-expanded={showAdvanced}
              className="flex w-full items-center justify-between gap-3 text-left"
            >
              <span className="flex min-w-0 items-center gap-3">
                <span className="tb-neu-raised grid h-10 w-10 shrink-0 place-items-center rounded-full text-violet-300">
                  <Settings2 className="h-4 w-4" />
                </span>
                <span className="min-w-0">
                  <span className="block font-display text-lg">
                    Signal intelligence &amp; controls
                  </span>
                  <span className="mt-1 block text-xs leading-5 text-white/45">
                    Review Council output, model settings, and the reason behind each
                    recommendation.
                  </span>
                </span>
              </span>
              <span>
                {showAdvanced ? (
                  <ChevronUp className="h-5 w-5" />
                ) : (
                  <ChevronDown className="h-5 w-5" />
                )}
              </span>
            </button>

            <div
              className={`${showAdvanced ? "block" : "hidden"} mt-4 border-t border-white/[0.06] pt-1`}
            >
              <CouncilSettings />
              {book === "paper" ? (
                <div className="tb-neu-inset mt-5 rounded-[24px] p-4">
                  <button
                    type="button"
                    onClick={() => setShowCouncilActivity((open) => !open)}
                    aria-expanded={showCouncilActivity}
                    className="flex w-full items-center justify-between gap-3 text-left"
                  >
                    <span className="min-w-0">
                      <span className="block font-display text-base">
                        Qualified signal decisions
                      </span>
                      <span className="mt-1 block text-xs leading-5 text-white/45">
                        Full-width signal evidence on desktop. Onyx remains advisory and cannot
                        override limits.
                      </span>
                    </span>
                    {showCouncilActivity ? (
                      <ChevronUp className="h-5 w-5 shrink-0" />
                    ) : (
                      <ChevronDown className="h-5 w-5 shrink-0" />
                    )}
                  </button>
                  {showCouncilActivity ? (
                    <div className="mt-4 border-t border-white/[0.06] pt-4">
                      <Suspense
                        fallback={
                          <div className="grid min-h-24 place-items-center">
                            <Loader2 className="h-5 w-5 animate-spin text-violet-300" />
                          </div>
                        }
                      >
                        <OnyxDecisionsPanel />
                      </Suspense>
                    </div>
                  ) : (
                    <button
                      type="button"
                      onClick={() => setShowCouncilActivity(true)}
                      className="mt-4 w-full rounded-2xl border border-violet-400/20 bg-violet-400/[0.07] px-4 py-3 text-xs font-semibold text-violet-200 transition hover:bg-violet-400/[0.12]"
                    >
                      Open signal decision desk
                    </button>
                  )}
                </div>
              ) : (
                <p className="mt-4 text-xs leading-5 text-white/50">
                  Live Council decisions appear beside each matching venue position above.
                  Recommendations alone are not orders.
                </p>
              )}
            </div>
          </section>
        </aside>
      </div>
      <AutomationIncomePanel book={book} />
      <SafetySummary className="mt-5" />
    </main>
  );
}

function ActivationPath() {
  const steps = [
    "Connect venue",
    "Set outcome",
    "Onyx builds mandate",
    "Paper validates",
    "Owner arms Live",
  ];

  return (
    <section
      className="tb-neu-inset mt-5 rounded-[24px] p-3 lg:p-4"
      aria-labelledby="activation-path-heading"
    >
      <p
        id="activation-path-heading"
        className="px-1 text-[10px] font-semibold uppercase tracking-[0.18em] text-white/40"
      >
        Set up or expand Autopilot
      </p>
      <ol className="mt-3 grid grid-cols-5 gap-1 lg:gap-4">
        {steps.map((step, index) => (
          <li key={step} className="min-w-0 text-center">
            <span className="tb-neu-raised mx-auto grid h-7 w-7 place-items-center rounded-full text-[10px] font-semibold text-violet-200 lg:h-9 lg:w-9 lg:text-xs">
              {index + 1}
            </span>
            <span className="mt-1 block text-[11px] leading-5 text-white/45 lg:text-xs">
              {step}
            </span>
          </li>
        ))}
      </ol>
    </section>
  );
}
