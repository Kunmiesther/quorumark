import { useState } from "react";
import { cn } from "@/lib/utils";

/**
 * Official brand mark — do NOT redraw, reinterpret, or recolor.
 * Replace only the file at `public/brand/turtlebot-logo.png`.
 * The rendered <img> ships the file exactly as supplied; no filters,
 * hue-rotate, or CSS inversion. `withGlow` adds a restrained violet
 * drop-shadow only. If the image is missing (404/onError), a plain
 * typographic "TB" placeholder renders — never a substitute mark.
 */

const LOGO_SRC = "/brand/turtlebot-logo.png";

type Variant = "full" | "icon";

interface TurtleBotLogoProps {
  size?: number;
  variant?: Variant;
  className?: string;
  withGlow?: boolean;
  priority?: boolean;
}

export function TurtleBotLogo({
  size = 64,
  variant = "full",
  className,
  withGlow = false,
  priority = false,
}: TurtleBotLogoProps) {
  const [failed, setFailed] = useState(false);

  const style = withGlow
    ? { filter: "drop-shadow(0 0 18px rgba(168,85,247,0.45))" }
    : undefined;

  if (failed) {
    return (
      <span
        className={cn(
          "inline-flex items-center justify-center rounded-full bg-[hsl(var(--graphite))] font-display font-bold uppercase tracking-tight text-[hsl(var(--brand-violet-bright))] ring-1 ring-[hsl(var(--silver)/0.14)]",
          className,
        )}
        style={{ width: size, height: size, fontSize: Math.round(size * 0.4), ...style }}
        aria-label="TurtleBot"
        role="img"
        data-variant={variant}
      >
        TB
      </span>
    );
  }

  return (
    <img
      src={LOGO_SRC}
      alt="TurtleBot"
      width={size}
      height={size}
      decoding="async"
      loading={priority ? "eager" : "lazy"}
      onError={() => setFailed(true)}
      className={cn("shrink-0 select-none", className)}
      style={{ width: size, height: size, ...style }}
      data-variant={variant}
      draggable={false}
    />
  );
}

interface TurtleBotWordmarkProps {
  size?: number;
  className?: string;
  withGlow?: boolean;
  priority?: boolean;
}

export function TurtleBotWordmark({
  size = 40,
  className,
  withGlow = false,
  priority = false,
}: TurtleBotWordmarkProps) {
  return (
    <span className={cn("inline-flex items-center gap-2.5", className)}>
      <TurtleBotLogo size={size} variant="icon" withGlow={withGlow} priority={priority} />
      <span
        className="font-display font-semibold tracking-tight text-foreground"
        style={{ fontSize: Math.round(size * 0.5) }}
      >
        TurtleBot
      </span>
    </span>
  );
}
