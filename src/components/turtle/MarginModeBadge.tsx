/**
 * Capability-aware margin-mode badge.
 *
 * Uses the compile-time Venue Capability Registry (`registry.ts`) to render:
 *   - "Cross · Required by <exchange>" when the venue allows only cross
 *   - "Isolated · Required by <exchange>" when the venue allows only isolated
 *   - "Cross | Isolated" chooser (currently read-only) when both are allowed
 *   - "Margin mode — unavailable" when the venue is unknown or unverified
 *
 * Preview UIs read static declarations here; execution paths must call
 * `preflightOrder()` against a runtime-verified capability record.
 */
import { staticAllowedMarginModes } from "@/lib/venue/registry";

interface Props {
  exchange: string | null;
  marketType: string | null;
  selectedMode: string | null;
}

export function MarginModeBadge({ exchange, marketType, selectedMode }: Props) {
  const market =
    marketType === "futures" ? "Futures" : marketType === "spot" ? "Spot" : "—";

  if (!exchange) {
    return (
      <p
        aria-label="Margin mode requires a connected exchange"
        className="mt-0.5 flex items-center gap-1.5 text-xs text-muted-foreground"
      >
        <span>{market}</span>
        <span
          title="Connect an exchange to configure margin mode."
          className="inline-flex items-center gap-1 rounded-sm border border-white/10 bg-white/5 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wider text-muted-foreground"
        >
          Margin — unavailable
        </span>
      </p>
    );
  }

  const info = staticAllowedMarginModes(exchange);

  if (!info.known) {
    return (
      <p className="mt-0.5 flex items-center gap-1.5 text-xs text-muted-foreground">
        <span>{market}</span>
        <span
          title={`Unknown venue "${exchange}" — capabilities not declared. Preflight will fail closed.`}
          aria-label="Margin mode unavailable for unknown venue"
          className="inline-flex items-center gap-1 rounded-sm border border-amber-500/40 bg-amber-500/10 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wider text-amber-400"
        >
          Venue unknown
        </span>
      </p>
    );
  }

  if (info.locked) {
    const only = info.modes[0]!;
    const label = only.toUpperCase();
    return (
      <p className="mt-0.5 flex items-center gap-1.5 text-xs text-muted-foreground">
        <span>{market}</span>
        <span
          title={`${label} required by ${exchange}. Locked capability, not a policy choice.`}
          aria-label={`Margin mode: ${only} (required by ${exchange})`}
          className="inline-flex items-center gap-1 rounded-sm border border-emerald-500/40 bg-emerald-500/10 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wider text-emerald-400"
        >
          <span aria-hidden="true">🔒</span> {label}
          <span className="ml-1 text-[9px] normal-case tracking-normal text-emerald-300/80">
            required by {exchange}
          </span>
        </span>
      </p>
    );
  }

  // Both modes allowed. Show the currently selected mode as active, others as available.
  const selected = (selectedMode ?? info.modes[0]!).toLowerCase();
  return (
    <p className="mt-0.5 flex items-center gap-1.5 text-xs text-muted-foreground">
      <span>{market}</span>
      <span
        title={`Runtime-verified capability required before ${exchange} orders submit.`}
        aria-label="Margin mode selectable"
        className="inline-flex items-center gap-1 rounded-sm border border-white/10 bg-white/5 px-1 py-0.5 text-[10px] font-medium uppercase tracking-wider text-white/80"
      >
        {info.modes.map((m) => (
          <span
            key={m}
            className={
              m === selected
                ? "rounded-sm bg-white/10 px-1 text-white"
                : "px-1 text-white/50"
            }
          >
            {m}
          </span>
        ))}
      </span>
    </p>
  );
}
