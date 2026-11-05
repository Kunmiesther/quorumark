import { Component, type ErrorInfo, type ReactNode } from "react";
import { recordOnboardingDiagnostic } from "@/lib/onboarding-diagnostics";
import { reportLovableError } from "@/lib/lovable-error-reporting";

type Props = { children: ReactNode };
type State = { error: Error | null; info: ErrorInfo | null };

export class WelcomeErrorBoundary extends Component<Props, State> {
  state: State = { error: null, info: null };

  static getDerivedStateFromError(error: Error): State {
    return { error, info: null };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    this.setState({ error, info });
    try {
      recordOnboardingDiagnostic({
        route: typeof window !== "undefined" ? window.location.pathname : "(ssr)",
        source: "welcome error boundary",
        status: "caught error",
        detail: error.message,
      });
    } catch {}
    reportLovableError(error, { boundary: "welcome", componentStack: info.componentStack });
    console.error("[welcome error boundary]", error, info);
  }

  reset = () => this.setState({ error: null, info: null });

  render() {
    if (!this.state.error) return this.props.children;
    const { error, info } = this.state;
    return (
      <div className="flex flex-1 flex-col gap-4 py-8 text-left font-mono text-xs text-foreground">
        <div>
          <h2 className="text-[10px] uppercase tracking-wider text-muted-foreground">
            Onboarding crashed
          </h2>
          <h1 className="mt-1 font-display text-lg font-bold text-destructive">
            {error.name}: {error.message}
          </h1>
          <p className="mt-1 text-[10px] text-muted-foreground">
            Route: {typeof window !== "undefined" ? window.location.pathname : ""}
          </p>
        </div>
        {error.stack && (
          <pre className="max-h-64 overflow-auto whitespace-pre-wrap rounded-md border border-border bg-surface p-3 text-[10px] leading-relaxed text-muted-foreground">
            {error.stack}
          </pre>
        )}
        {info?.componentStack && (
          <details className="rounded-md border border-border bg-surface p-3 text-[10px] text-muted-foreground">
            <summary className="cursor-pointer text-foreground">Component stack</summary>
            <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap">
              {info.componentStack}
            </pre>
          </details>
        )}
        <div className="flex gap-2">
          <button
            onClick={this.reset}
            className="flex h-10 flex-1 items-center justify-center rounded-xl bg-primary text-xs font-semibold text-primary-foreground active:scale-[0.97]"
          >
            Try again
          </button>
          <button
            onClick={() => {
              if (typeof window !== "undefined") window.location.href = "/welcome";
            }}
            className="flex h-10 flex-1 items-center justify-center rounded-xl border border-white/10 bg-white/[0.04] text-xs font-medium text-foreground active:scale-[0.97]"
          >
            Reload /welcome
          </button>
        </div>
      </div>
    );
  }
}
