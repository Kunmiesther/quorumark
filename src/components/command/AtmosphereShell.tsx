import { ReactNode } from "react";
import { AppHeader } from "@/components/turtle/AppHeader";
import { cn } from "@/lib/utils";

interface AtmosphereShellProps {
  /** Ambient accent color (usually the active turtle accent). Defaults to intel-cyan. */
  accent?: string;
  /** Eyebrow text over the H1 — sets the command context. */
  eyebrow?: string;
  /** Page title, rendered in the command display face. */
  title: ReactNode;
  /** Optional one-line subtitle beneath the title. */
  subtitle?: ReactNode;
  /** Optional right-aligned header actions. */
  headerActions?: ReactNode;
  /** Whether to show the AppHeader inside the atmosphere (default true). */
  showHeader?: boolean;
  /** Additional classes on the outer container. */
  className?: string;
  /** Optional cinematic hero image. Renders behind the header + title band with a dark overlay. */
  heroImage?: string;
  /** How to position the hero image (default 'center top'). */
  heroPosition?: string;
  /** Hero band height (default '54vh'). */
  heroHeight?: string;
  /** 0..1 — strength of the top-to-bottom dark overlay (default 0.55). Lower = brighter/more color. */
  heroOverlayOpacity?: number;
  /** 0..1 — strength of the left dark wash for text legibility (default 0.9). Set 0 to remove. */
  heroLeftWashOpacity?: number;
  /** Extra glow accent behind hero for punch. */
  heroGlow?: boolean;
  children?: ReactNode;
}

/**
 * Shared command-world shell for the inner authenticated pages
 * (Life Map, Trade, Squad, Profile). It gives every page:
 *
 *  - the pure jet-black `--bg-void` floor,
 *  - a subtle accent radial that ties the page to its active turtle,
 *  - the holographic grid dissolving to the edges,
 *  - a consistent command-styled title block,
 *  - and the shared AppHeader chrome. AppShell owns primary navigation.
 *
 * Pages compose their own instruments/panels as `children`. This shell
 * intentionally does NOT render fake data — empty states are the caller's
 * responsibility so we never present missing data as $0.
 */
export function AtmosphereShell({
  accent = "#22D3EE",
  eyebrow,
  title,
  subtitle,
  headerActions,
  showHeader = true,
  className,
  heroImage,
  heroPosition = "center top",
  heroHeight = "54vh",
  heroOverlayOpacity = 0.55,
  heroLeftWashOpacity = 0.9,
  heroGlow = false,
  children,
}: AtmosphereShellProps) {
  const topO = Math.max(0, heroOverlayOpacity - 0.1);
  const midO = heroOverlayOpacity;
  const botO = Math.min(1, heroOverlayOpacity + 0.35);
  return (
    <div
      className={cn(
        "relative mx-auto max-w-md overflow-hidden bg-[color:var(--bg-void)] pb-4 text-[color:var(--text-primary)]",
        className,
      )}
      style={
        {
          ["--edge-color" as string]: accent,
        } as React.CSSProperties
      }
    >
      {heroImage ? (
        <>
          {/* Cinematic hero image band */}
          <div
            aria-hidden
            className="pointer-events-none absolute inset-x-0 top-0 overflow-hidden"
            style={{ height: heroHeight, maxHeight: 640 }}
          >
            <img
              src={heroImage}
              alt=""
              className="h-full w-full object-cover"
              style={{ objectPosition: heroPosition, filter: "saturate(1.15) contrast(1.05) brightness(1.08)" }}
            />
            {heroGlow && (
              <div
                aria-hidden
                className="absolute inset-0"
                style={{
                  background: `radial-gradient(60% 55% at 70% 35%, ${accent}55, transparent 70%)`,
                  mixBlendMode: "screen",
                }}
              />
            )}
            {/* Dark gradient overlay for text legibility, fading to jet-black body */}
            <div
              className="absolute inset-0"
              style={{
                background: `linear-gradient(180deg, rgba(2,3,6,${topO}) 0%, rgba(2,3,6,${midO}) 40%, rgba(2,3,6,${botO}) 82%, var(--bg-void) 100%)`,
              }}
            />
            {heroLeftWashOpacity > 0 && (
              /* Left-column dark wash so text sits on a jet-black bed */
              <div
                className="absolute inset-y-0 left-0 w-3/4"
                style={{
                  background: `linear-gradient(90deg, rgba(2,3,6,${heroLeftWashOpacity}) 0%, rgba(2,3,6,${Math.max(0, heroLeftWashOpacity - 0.35)}) 55%, transparent 100%)`,
                }}
              />
            )}
          </div>
        </>
      ) : (
        <>
          {/* Ambient accent glow — anchored top-right, static (no loop). */}
          <div
            aria-hidden
            className="pointer-events-none absolute inset-x-0 top-0 h-[46vh]"
            style={{
              background: `radial-gradient(80% 60% at 78% 0%, ${accent}22, transparent 70%)`,
            }}
          />
          {/* Fine command grid — dissolves at edges via the holo-grid utility. */}
          <div
            aria-hidden
            className="holo-grid pointer-events-none absolute inset-0 opacity-[0.55]"
          />
        </>
      )}
      {/* Bottom fade so BottomNav sits on solid void. */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 bottom-0 h-40"
        style={{
          background:
            "linear-gradient(180deg, transparent 0%, rgba(2,3,4,0.85) 60%, var(--bg-void) 100%)",
        }}
      />

      <div className="relative z-10">
        {showHeader && <AppHeader />}

        <header className="mt-1 flex items-start justify-between gap-3 px-5 pt-2">
          <div className="min-w-0">
            {eyebrow && (
              <p className="font-display text-[10px] font-bold uppercase tracking-[0.28em] text-[color:var(--intel-cyan)]">
                {eyebrow}
              </p>
            )}
            <h1 className="mt-1 font-display text-[24px] font-semibold uppercase leading-[1.05] tracking-[0.03em]">
              {title}
            </h1>
            {subtitle && (
              <p className="mt-1.5 text-[12px] leading-relaxed text-[color:var(--text-secondary)]">
                {subtitle}
              </p>
            )}
          </div>
          {headerActions && <div className="shrink-0">{headerActions}</div>}
        </header>

        <main className="mt-5 space-y-4 px-5">{children}</main>
      </div>
    </div>
  );
}
