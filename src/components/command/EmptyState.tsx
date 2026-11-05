import { ReactNode } from "react";
import { cn } from "@/lib/utils";

interface StateProps {
  title: string;
  description?: string;
  action?: ReactNode;
  icon?: ReactNode;
  className?: string;
}

function shell(children: ReactNode, className?: string) {
  return (
    <div
      className={cn(
        "flex min-h-[160px] flex-col items-center justify-center gap-2 rounded-2xl border border-white/8 bg-white/[0.03] p-6 text-center",
        className,
      )}
    >
      {children}
    </div>
  );
}

export function EmptyState({ title, description, action, icon, className }: StateProps) {
  return shell(
    <>
      {icon && <div className="mb-1 text-muted-foreground">{icon}</div>}
      <p className="font-display text-[13px] font-semibold uppercase tracking-[0.16em] text-silver">
        {title}
      </p>
      {description && (
        <p className="max-w-xs text-[11.5px] leading-relaxed text-muted-foreground">
          {description}
        </p>
      )}
      {action && <div className="mt-2 min-h-[44px]">{action}</div>}
    </>,
    className,
  );
}

export function LoadingState({ title = "Loading", description, className }: Partial<StateProps>) {
  return shell(
    <>
      <div
        className="h-5 w-5 animate-spin rounded-full border-2 border-white/15 border-t-[hsl(var(--data-cyan))]"
        aria-hidden
      />
      <p className="font-display text-[13px] font-semibold uppercase tracking-[0.16em] text-silver">
        {title}
      </p>
      {description && (
        <p className="max-w-xs text-[11.5px] leading-relaxed text-muted-foreground">
          {description}
        </p>
      )}
    </>,
    className,
  );
}

export function ErrorState({ title, description, action, icon, className }: StateProps) {
  return shell(
    <>
      {icon && <div className="mb-1 text-[hsl(var(--state-danger))]">{icon}</div>}
      <p className="font-display text-[13px] font-semibold uppercase tracking-[0.16em] text-[hsl(var(--state-danger))]">
        {title}
      </p>
      {description && (
        <p className="max-w-xs text-[11.5px] leading-relaxed text-muted-foreground">
          {description}
        </p>
      )}
      {action && <div className="mt-2 min-h-[44px]">{action}</div>}
    </>,
    cn("ring-1 ring-[hsl(var(--state-danger)/0.35)]", className),
  );
}
