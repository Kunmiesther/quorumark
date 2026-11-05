/**
 * Ruling #16 — localized error boundary for the Trade Desk panels.
 * A single malformed row (e.g. a null field the panel forgot to guard)
 * must degrade THAT panel only, not blank the whole page.
 */
import { Component, type ErrorInfo, type ReactNode } from "react";

type Props = { label: string; children: ReactNode };
type State = { error: Error | null };

export class PanelErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error(`[panel:${this.props.label}]`, error, info);
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="rounded-md border border-white/10 bg-black/40 p-3 text-[11px] text-white/70">
        <div className="mb-1 font-semibold uppercase tracking-[0.14em] text-[color:var(--onixus-red)]">
          {this.props.label} unavailable
        </div>
        <div className="font-mono text-[10px] text-white/50">
          {this.state.error.message}
        </div>
      </div>
    );
  }
}
