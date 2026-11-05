/**
 * Trust Center primitives.
 *
 * One vocabulary for every status on the page, so "green" means the same
 * thing in five sections. Institutional restraint: a single accent, tone
 * carried by a small dot and the label, never by a filled card.
 *
 * TONE CONTRACT — read before adding a state:
 *   ok        proven working, from a fresh record
 *   warn      working but degraded, or needs owner action
 *   down      proven failing
 *   idle      nothing to report — NOT a failure and never rendered red
 *   unknown   no evidence either way — never rendered green
 *
 * `idle` and `unknown` exist because collapsing them into `down` is how a
 * quiet system starts looking broken, and collapsing them into `ok` is how a
 * broken one starts looking fine.
 */
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export type Tone = "ok" | "warn" | "down" | "idle" | "unknown";

export const TONE_DOT: Record<Tone, string> = {
  ok: "bg-emerald-400",
  warn: "bg-amber-400",
  down: "bg-red-400",
  idle: "bg-white/25",
  unknown: "bg-white/25",
};

export const TONE_TEXT: Record<Tone, string> = {
  ok: "text-emerald-300",
  warn: "text-amber-300",
  down: "text-red-300",
  idle: "text-white/45",
  unknown: "text-white/45",
};

const TONE_GLOW: Record<Tone, string> = {
  ok: "shadow-[0_0_0_3px_rgba(52,211,153,0.12)]",
  warn: "shadow-[0_0_0_3px_rgba(251,191,36,0.12)]",
  down: "shadow-[0_0_0_3px_rgba(248,113,113,0.12)]",
  idle: "",
  unknown: "",
};

export function StatusDot({
  tone,
  pulse = false,
  className,
}: {
  tone: Tone;
  pulse?: boolean;
  className?: string;
}) {
  return (
    <span
      aria-hidden
      className={cn(
        "inline-block h-2 w-2 shrink-0 rounded-full",
        TONE_DOT[tone],
        TONE_GLOW[tone],
        pulse && tone === "ok" && "animate-pulse",
        className,
      )}
    />
  );
}

/** Uppercase micro-label. The page's only heading treatment below H1. */
export function Eyebrow({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <p
      className={cn(
        "text-[10px] font-semibold uppercase tracking-[0.18em] text-white/40",
        className,
      )}
    >
      {children}
    </p>
  );
}

export function SectionHeading({
  title,
  subtitle,
  actions,
}: {
  title: string;
  subtitle?: string;
  actions?: ReactNode;
}) {
  return (
    <header className="mb-3 flex items-start justify-between gap-3">
      <div className="min-w-0">
        <h2 className="text-[13px] font-semibold uppercase tracking-[0.16em] text-white/85">
          {title}
        </h2>
        {subtitle && (
          <p className="mt-1 break-words text-[11.5px] leading-relaxed text-white/45">{subtitle}</p>
        )}
      </div>
      {actions && <div className="shrink-0">{actions}</div>}
    </header>
  );
}

/**
 * One labelled fact. `value` is rendered as-is — pass an em dash for
 * "no data", never a zero. A fabricated $0 is worse than a blank.
 */
export function Metric({
  label,
  value,
  tone,
  hint,
  mono = true,
}: {
  label: string;
  value: ReactNode;
  tone?: Tone;
  hint?: string;
  mono?: boolean;
}) {
  return (
    <div className="min-w-0">
      <div className="flex items-center gap-1.5">
        {tone && <StatusDot tone={tone} />}
        <Eyebrow>{label}</Eyebrow>
      </div>
      <p
        className={cn(
          "mt-1 break-words text-[15px] font-semibold text-white/90 [overflow-wrap:anywhere]",
          mono && "tabular-nums",
          tone && TONE_TEXT[tone],
        )}
      >
        {value}
      </p>
      {hint && <p className="mt-0.5 break-words text-[10.5px] text-white/35">{hint}</p>}
    </div>
  );
}

/** A subsystem line: dot, name, state, and the reason when it is not ok. */
export function SubsystemRow({
  name,
  state,
  tone,
  detail,
  at,
}: {
  name: string;
  state: string;
  tone: Tone;
  detail?: string | null;
  at?: string | null;
}) {
  return (
    <div className="flex items-start justify-between gap-3 py-2.5">
      <div className="flex min-w-0 items-start gap-2.5">
        <StatusDot tone={tone} className="mt-1.5" pulse={tone === "ok"} />
        <div className="min-w-0">
          <p className="break-words text-[13px] font-medium text-white/90">{name}</p>
          {detail && (
            <p className="mt-0.5 break-words text-[11.5px] leading-relaxed text-white/45 [overflow-wrap:anywhere]">
              {detail}
            </p>
          )}
        </div>
      </div>
      <div className="max-w-[42%] shrink-0 text-right">
        <p
          className={cn(
            "break-words text-[12px] font-semibold [overflow-wrap:anywhere]",
            TONE_TEXT[tone],
          )}
        >
          {state}
        </p>
        {at && <p className="mt-0.5 text-[10.5px] tabular-nums text-white/30">{at}</p>}
      </div>
    </div>
  );
}

/**
 * Secondary action. `disabledReason` is REQUIRED when disabled: a control
 * that cannot be used must say why, or the page is just being mysterious.
 */
export function ActionButton({
  label,
  icon,
  onClick,
  disabled = false,
  disabledReason,
  danger = false,
  pending = false,
}: {
  label: string;
  icon?: ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  disabledReason?: string;
  danger?: boolean;
  pending?: boolean;
}) {
  const isDisabled = disabled || pending;
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={isDisabled}
      title={isDisabled ? disabledReason : undefined}
      aria-label={isDisabled && disabledReason ? `${label} — ${disabledReason}` : label}
      className={cn(
        "inline-flex items-center justify-center gap-1.5 rounded-xl px-3 py-2 text-[11.5px] font-semibold transition",
        "min-h-[36px]",
        isDisabled
          ? "cursor-not-allowed bg-white/[0.03] text-white/30"
          : danger
            ? "bg-red-500/12 text-red-200 hover:bg-red-500/20"
            : "bg-white/[0.06] text-white/80 hover:bg-white/[0.11] hover:text-white",
      )}
    >
      {icon}
      <span className="truncate">{pending ? "Working…" : label}</span>
    </button>
  );
}

/** Freshness formatting shared by every section, so ages never disagree. */
export function relTime(iso: string | null | undefined): string {
  if (!iso) return "never";
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return "never";
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

export function ageSeconds(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return null;
  return Math.max(0, (Date.now() - ms) / 1000);
}

/** USD, or an em dash. Never 0 for missing — see Metric. */
export function fmtUsd(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "—";
  const abs = Math.abs(n);
  const sign = n < 0 ? "-" : "";
  return `${sign}$${abs.toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

export function fmtSignedUsd(n: number | null | undefined): {
  text: string;
  tone: Tone;
} {
  if (n === null || n === undefined || !Number.isFinite(n)) {
    return { text: "—", tone: "unknown" };
  }
  return {
    text: `${n > 0 ? "+" : ""}${fmtUsd(n).replace("-", "-")}`,
    tone: n > 0 ? "ok" : n < 0 ? "down" : "idle",
  };
}
