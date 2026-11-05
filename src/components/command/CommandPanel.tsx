import { ReactNode } from "react";
import { cn } from "@/lib/utils";

type Tone = "neutral" | "data" | "warning" | "danger" | "success";

const TONE_RING: Record<Tone, string> = {
  neutral: "",
  data: "ring-1 ring-[hsl(var(--data-cyan)/0.35)]",
  warning: "ring-1 ring-[hsl(var(--state-warning)/0.45)]",
  danger: "ring-1 ring-[hsl(var(--state-danger)/0.45)]",
  success: "ring-1 ring-[hsl(var(--state-success)/0.45)]",
};

interface CommandPanelProps {
  title?: ReactNode;
  subtitle?: ReactNode;
  tone?: Tone;
  actions?: ReactNode;
  className?: string;
  children?: ReactNode;
}

/** Command-world panel: dark translucent armor + subtle silver hairline.
 *  Use for major UI regions on Home / Squad / Life Map / Trade. */
export function CommandPanel({
  title,
  subtitle,
  tone = "neutral",
  actions,
  className,
  children,
}: CommandPanelProps) {
  return (
    <section className={cn("command-panel p-4", TONE_RING[tone], className)}>
      {(title || subtitle || actions) && (
        <header className="mb-3 flex items-start justify-between gap-3">
          <div className="min-w-0">
            {title && (
              <h2 className="font-display text-[13px] font-semibold uppercase tracking-[0.16em] text-silver">
                {title}
              </h2>
            )}
            {subtitle && (
              <p className="mt-1 text-[11.5px] leading-relaxed text-muted-foreground">
                {subtitle}
              </p>
            )}
          </div>
          {actions && <div className="shrink-0">{actions}</div>}
        </header>
      )}
      {children}
    </section>
  );
}
