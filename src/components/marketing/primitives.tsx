import { type ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * Shared marketing primitives. Kept tiny and dependency-free so every
 * public route pulls from the same visual language.
 */

const accentMap: Record<string, string> = {
  cyan: "text-cyan-300 border-cyan-400/30 bg-cyan-400/10",
  violet: "text-violet-300 border-violet-400/30 bg-violet-400/10",
  emerald: "text-emerald-300 border-emerald-400/30 bg-emerald-400/10",
  amber: "text-amber-300 border-amber-400/30 bg-amber-400/10",
  rose: "text-rose-300 border-rose-400/30 bg-rose-400/10",
  gold: "text-yellow-300 border-yellow-400/30 bg-yellow-400/10",
  muted: "text-white/60 border-white/15 bg-white/5",
};

export function StatusPill({
  children,
  accent = "cyan",
  className,
}: {
  children: ReactNode;
  accent?: keyof typeof accentMap;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-[10px] font-medium uppercase tracking-[0.14em]",
        accentMap[accent],
        className,
      )}
    >
      <span
        aria-hidden
        className={cn("h-1.5 w-1.5 rounded-full", {
          "bg-cyan-300": accent === "cyan",
          "bg-violet-300": accent === "violet",
          "bg-emerald-300": accent === "emerald",
          "bg-amber-300": accent === "amber",
          "bg-rose-300": accent === "rose",
          "bg-yellow-300": accent === "gold",
          "bg-white/60": accent === "muted",
        })}
      />
      {children}
    </span>
  );
}

export function GlassCard({
  children,
  className,
  glow = false,
}: {
  children: ReactNode;
  className?: string;
  glow?: boolean;
}) {
  return (
    <div
      className={cn(
        "relative overflow-hidden rounded-3xl border border-white/[0.08] bg-white/[0.03] p-6 backdrop-blur-xl",
        "shadow-[0_10px_60px_-20px_rgba(0,0,0,0.9)]",
        "before:pointer-events-none before:absolute before:inset-0 before:rounded-3xl before:bg-gradient-to-b before:from-white/[0.04] before:to-transparent",
        glow &&
          "after:pointer-events-none after:absolute after:-inset-px after:rounded-3xl after:bg-gradient-to-br after:from-violet-500/10 after:via-transparent after:to-cyan-400/10",
        className,
      )}
    >
      <div className="relative z-10">{children}</div>
    </div>
  );
}

export function SectionHeading({
  eyebrow,
  title,
  subtitle,
  align = "center",
  className,
}: {
  eyebrow?: string;
  title: ReactNode;
  subtitle?: ReactNode;
  align?: "left" | "center";
  className?: string;
}) {
  return (
    <div
      className={cn(
        "mx-auto max-w-3xl space-y-4",
        align === "center" ? "text-center" : "text-left",
        className,
      )}
    >
      {eyebrow ? (
        <p className="text-[11px] font-semibold uppercase tracking-[0.32em] text-cyan-300/90">
          {eyebrow}
        </p>
      ) : null}
      <h2 className="font-display text-3xl font-semibold leading-tight tracking-tight text-white sm:text-4xl md:text-5xl">
        {title}
      </h2>
      {subtitle ? (
        <p className="text-base leading-relaxed text-white/70 sm:text-lg">{subtitle}</p>
      ) : null}
    </div>
  );
}

export function GradientText({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "bg-gradient-to-r from-cyan-200 via-violet-200 to-cyan-300 bg-clip-text text-transparent",
        className,
      )}
    >
      {children}
    </span>
  );
}

export function SectionShell({
  children,
  className,
  id,
}: {
  children: ReactNode;
  className?: string;
  id?: string;
}) {
  return (
    <section id={id} className={cn("relative w-full py-20 sm:py-28", className)}>
      <div className="mx-auto w-full max-w-7xl px-4 sm:px-6 lg:px-8">{children}</div>
    </section>
  );
}
