import { createFileRoute, Outlet, useNavigate, useRouterState } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { ArrowLeft, ArrowRight } from "lucide-react";
import { OnboardingDiagnosticsPanel } from "@/components/welcome/OnboardingDiagnosticsPanel";
import { WelcomeErrorBoundary } from "@/components/welcome/WelcomeErrorBoundary";

const ONBOARDING_ROUTES = [
  "/welcome/pin",
  "/welcome/pin-confirm",
  "/welcome/face-id",
  "/welcome/exchange",
  "/welcome/wallet",
  "/welcome/notifications",
  "/welcome/ai-model",
  "/welcome/bills",
  "/welcome/ready",
] as const;
const MAX_VISITED_KEY = "tb_onboarding_max_visited";

function WelcomeLayout() {
  const navigate = useNavigate();
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const showBack = pathname !== "/welcome" && pathname !== "/welcome/";
  const currentStep = ONBOARDING_ROUTES.indexOf(pathname as (typeof ONBOARDING_ROUTES)[number]);
  const [showForward, setShowForward] = useState(false);
  const [maxVisited, setMaxVisited] = useState(-1);
  useEffect(() => {
    const saved = Number(sessionStorage.getItem(MAX_VISITED_KEY) ?? -1);
    const nextMax = currentStep >= 0 ? Math.max(saved, currentStep) : saved;
    if (nextMax !== saved) sessionStorage.setItem(MAX_VISITED_KEY, String(nextMax));
    setMaxVisited(nextMax);
    setShowForward(sessionStorage.getItem("tb_onboarding_went_back") === "1");
  }, [currentStep, pathname]);
  const goBack = () => {
    sessionStorage.setItem("tb_onboarding_went_back", "1");
    setShowForward(true);
    const previous = currentStep > 0 ? ONBOARDING_ROUTES[currentStep - 1] : "/welcome";
    navigate({ to: previous });
  };
  const goForward = () => {
    if (currentStep < 0 || currentStep >= maxVisited) return;
    navigate({ to: ONBOARDING_ROUTES[currentStep + 1] });
  };
  return (
    <div className="welcome-shell min-h-[100dvh]">
      <main
        className="welcome-frame mx-auto flex min-h-[100dvh] w-full max-w-[430px] flex-col overflow-x-hidden px-5"
        style={{
          paddingTop: "max(1rem, env(safe-area-inset-top))",
          paddingBottom: "max(1rem, env(safe-area-inset-bottom))",
        }}
      >
        {showBack && (
          <button type="button" onClick={goBack} aria-label="Go back" className="welcome-back-button fixed z-50 flex h-11 w-11 items-center justify-center rounded-2xl text-purple-300">
            <ArrowLeft className="h-5 w-5" />
          </button>
        )}
        {showBack && showForward && currentStep >= 0 && currentStep < maxVisited && (
          <button type="button" onClick={goForward} aria-label="Go forward" className="welcome-forward-button fixed z-50 flex h-11 w-11 items-center justify-center rounded-2xl text-purple-300">
            <ArrowRight className="h-5 w-5" />
          </button>
        )}
        <WelcomeErrorBoundary>
          <div key={pathname} className="welcome-route-stage flex flex-1 flex-col">
            <Outlet />
          </div>
        </WelcomeErrorBoundary>
        {import.meta.env.DEV && <OnboardingDiagnosticsPanel />}
      </main>
    </div>
  );
}

export const Route = createFileRoute("/welcome")({
  component: WelcomeLayout,
  errorComponent: ({ error, reset }) => {
    const routeError =
      error instanceof Error ? error : new Error(String(error));
    return (
      <main className="mx-auto flex min-h-screen max-w-md flex-col gap-4 px-5 pb-10 pt-12 font-mono text-xs">
        <h2 className="text-[10px] uppercase tracking-wider text-muted-foreground">
          Welcome route error
        </h2>
        <h1 className="font-display text-lg font-bold text-destructive">
          {routeError.name}: {routeError.message}
        </h1>
        {routeError.stack && (
          <pre className="max-h-72 overflow-auto whitespace-pre-wrap rounded-md border border-border bg-surface p-3 text-[10px] text-muted-foreground">
            {routeError.stack}
          </pre>
        )}
        <button
          onClick={reset}
          className="flex h-10 items-center justify-center rounded-xl bg-primary text-xs font-semibold text-primary-foreground active:scale-[0.97]"
        >
          Try again
        </button>
      </main>
    );
  },
});
