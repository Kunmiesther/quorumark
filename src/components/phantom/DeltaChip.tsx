import { cn } from "@/lib/utils";

interface DeltaChipProps {
  /** Numeric delta as a percentage (e.g. 2.34 for +2.34%). */
  percent?: number | null;
  /** Absolute dollar delta shown before the chip. */
  usd?: number | null;
  className?: string;
}

const formatUsd = (n: number) =>
  `${n >= 0 ? "+" : "−"}$${Math.abs(n).toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;

/**
 * DeltaChip — dollar delta + filled percent pill. Pill is accent-bg /
 * black-text for positive, negative-red for losses, muted for flat.
 */
export function DeltaChip({ percent, usd, className }: DeltaChipProps) {
  const pct = percent ?? 0;
  const positive = pct > 0;
  const negative = pct < 0;

  const pillClass = positive
    ? "bg-[color:var(--positive)] text-black"
    : negative
      ? "bg-[color:var(--negative)] text-white"
      : "bg-white/10 text-white/60";

  const usdColor = positive
    ? "text-[color:var(--positive)]"
    : negative
      ? "text-[color:var(--negative)]"
      : "text-white/60";

  return (
    <div className={cn("flex items-center gap-2", className)}>
      {typeof usd === "number" && (
        <span className={cn("text-[14px] font-semibold tabular-nums", usdColor)}>
          {formatUsd(usd)}
        </span>
      )}
      <span
        className={cn(
          "inline-flex items-center rounded-lg px-2 py-0.5 text-[12px] font-semibold tabular-nums",
          pillClass,
        )}
      >
        {positive && "+"}
        {pct.toFixed(2)}%
      </span>
    </div>
  );
}
