import { useMemo } from "react";
import { turtleByAnyKey, turtleImage, type TurtleDef } from "@/lib/turtles";
import { useReducedMotion } from "@/hooks/useReducedMotion";

interface TurtleWorldStageProps {
  /** Turtle key or DB slug. If null/unknown, renders the Accumulator master
   *  dimmed as the "no turtle assigned" empty state. */
  turtleKey: string | null;
  /** True = grayscale + reduced opacity + no visor scan (empty state). */
  unassigned?: boolean;
  /** Optional extra classes on the outer wrapper. */
  className?: string;
  /** Height of the stage — defaults to 62vh so the turtle dominates the fold. */
  minHeightClass?: string;
  children?: React.ReactNode;
}

/**
 * The active Turtle IS the environment — this stage renders the master art
 * as the primary hero background, tinted by that turtle's accent, dissolving
 * into jet-black at the bottom edge. UI instrumentation is composed as
 * `children` and floats over the safe dark portion.
 *
 * Composition rules (from the design brief):
 *  - Turtle fills ~55-60% of the fold, upper-right biased.
 *  - Bottom edge fades to var(--bg-void) via a masked gradient.
 *  - Visor scan runs once on mount; disabled when reduced-motion is on.
 *  - No parallax loop, no drifting particles, no cropping through the face.
 */
export function TurtleWorldStage({
  turtleKey,
  unassigned = false,
  className = "",
  minHeightClass = "min-h-[62vh]",
  children,
}: TurtleWorldStageProps) {
  const reducedMotion = useReducedMotion();
  const turtle: TurtleDef | null = useMemo(
    () => (turtleKey ? turtleByAnyKey(turtleKey) : null),
    [turtleKey],
  );
  // Fallback to Accumulator master when unassigned or unknown key.
  const displaySlug = turtle?.slug ?? "dca";
  const accent = turtle?.accent ?? "#22D3EE";
  const image = turtleImage(displaySlug);

  return (
    <section
      className={`relative w-full overflow-hidden ${minHeightClass} ${className}`}
      style={
        {
          backgroundColor: "var(--bg-void)",
          ["--edge-color" as string]: accent,
        } as React.CSSProperties
      }
      aria-label={
        unassigned || !turtle
          ? "No turtle assigned"
          : `${turtle.name} — active intelligence`
      }
    >
      {/* Accent radial glow behind the turtle. Static — no loop. */}
      <div
        aria-hidden
        className="absolute inset-0 pointer-events-none"
        style={{
          background: `radial-gradient(70% 55% at 70% 35%, ${accent}22, transparent 65%)`,
        }}
      />

      {/* Turtle master — upper-right, dominates the fold. */}
      <img
        src={image}
        alt={
          unassigned || !turtle
            ? ""
            : `${turtle.name}, ${turtle.role}`
        }
        aria-hidden={unassigned || !turtle ? true : undefined}
        className={[
          "absolute inset-y-0 right-0 h-full w-[85%] max-w-[720px]",
          "object-cover object-right select-none pointer-events-none",
          unassigned ? "opacity-25 grayscale" : "opacity-95",
        ].join(" ")}
        draggable={false}
        loading="eager"
        decoding="async"
      />

      {/* Bottom dissolve into jet black — 45% mask so UI beneath stays legible. */}
      <div
        aria-hidden
        className="absolute inset-x-0 bottom-0 h-[55%] pointer-events-none"
        style={{
          background:
            "linear-gradient(180deg, transparent 0%, rgba(2,3,4,0.55) 40%, var(--bg-void) 100%)",
        }}
      />

      {/* Left-side safe-dark scrim so headline copy stays readable over art. */}
      <div
        aria-hidden
        className="absolute inset-y-0 left-0 w-[60%] pointer-events-none"
        style={{
          background:
            "linear-gradient(90deg, rgba(2,3,4,0.85) 0%, rgba(2,3,4,0.45) 55%, transparent 100%)",
        }}
      />

      {/* Fine command grid — layered over the world, dissolves at edges. */}
      <div aria-hidden className="holo-grid absolute inset-0 pointer-events-none" />

      {/* Visor scan — one-shot cyan sweep on mount. Skipped for reduced motion
          and for the unassigned empty state. */}
      {!reducedMotion && !unassigned && turtle && (
        <div
          aria-hidden
          className="visor-scan absolute inset-0 pointer-events-none"
        />
      )}

      {/* Slot — command copy, status rail, whatever the caller composes. */}
      {children && (
        <div className="relative z-10 flex h-full flex-col">{children}</div>
      )}

      {/* Unassigned overlay copy — only when explicitly unassigned. */}
      {unassigned && (
        <div className="pointer-events-none absolute inset-0 z-10 flex flex-col items-center justify-center px-6 text-center">
          <p className="font-display text-[10px] font-semibold uppercase tracking-[0.28em] text-[color:var(--intel-cyan)]">
            No Turtle Assigned
          </p>
          <p className="mt-2 font-display text-[22px] font-semibold uppercase tracking-[0.06em] text-[color:var(--text-primary)]">
            Select a Turtle intelligence
          </p>
        </div>
      )}
    </section>
  );
}
