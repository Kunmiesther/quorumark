import { useExecutionStatus } from "@/hooks/useExecutionStatus";
import { cn } from "@/lib/utils";

/**
 * ExecutionStatusChip — the ONE surface for execution status.
 *
 * State comes strictly from the backend: user_strategy (enabled/mode),
 * exchange_connections (status/exchange/permissions), and
 * apex_execution_credentials (active mainnet signing credential). No prop
 * lets a caller override the status; there is no local toggle.
 *
 * Signing credential presence replaces the retired "run-live-proof"
 * artifact — the current path is worker → edge broker → Railway signer
 * CREATE_ORDER, which requires an active envelope-wrapped credential row
 * (never a proof order). See docs/MAINNET_PARITY.md.
 */
function toneClass(tone: "neutral" | "positive" | "warning"): string {
  switch (tone) {
    case "positive":
      return "border-teal-400/30 bg-teal-400/[0.09] text-teal-200";
    case "warning":
      return "border-red-400/30 bg-red-400/[0.08] text-red-200";
    case "neutral":
    default:
      return "border-white/10 bg-white/[0.04] text-muted-foreground";
  }
}

export function ExecutionStatusChip({ className }: { className?: string }) {
  const meta = useExecutionStatus();

  return (
    <div
      role="status"
      aria-live="polite"
      data-execution-status={meta.status}
      className={cn(
        "mx-5 mt-1 mb-2 flex items-center gap-3 rounded-2xl border px-3.5 py-2.5",
        toneClass(meta.tone),
        className,
      )}
    >
      <span
        className={cn(
          "inline-flex h-2 w-2 shrink-0 rounded-full",
          meta.tone === "positive"
            ? "bg-teal-300"
            : meta.tone === "warning"
              ? "bg-red-300"
              : "bg-muted-foreground/60",
        )}
        aria-hidden
      />
      <div className="min-w-0 flex-1">
        <p className="text-[12.5px] font-semibold leading-tight text-foreground">{meta.label}</p>
        <p className="mt-0.5 text-[10.5px] leading-tight text-muted-foreground">
          {meta.description}
        </p>
      </div>
    </div>
  );
}
