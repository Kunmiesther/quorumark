import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import { openScout } from "@/components/scout/ScoutPanel";
import { useScoutActivation } from "@/hooks/useScoutActivation";
import scoutAsset from "@/assets/characters/scout.webp.asset.json";

/**
 * ScoutBeacon — Scout identity/status pill.
 *
 * Geometry, border thickness, corner radius, padding, height are all matched
 * to `OnyxBeacon` (variant="pill") so the two pills read as a matched pair.
 * The stationary SVG capsule + traveling highlight technique is identical;
 * only the palette (cyan) and the head image differ.
 */

type Status = "ready" | "offline";

const CYAN = { base: "#22D3EE", mid: "#67E8F9", hi: "#0EA5E9", dim: "rgba(34,211,238,0.32)" };
const MUTED = { base: "#94A3B8", mid: "#64748B", hi: "#94A3B8", dim: "rgba(148,163,184,0.25)" };

export function ScoutBeacon({ className }: { className?: string }) {
  const { active } = useScoutActivation();
  const status: Status = active ? "ready" : "offline";
  const label = active ? "Open Scout — active" : "Open Scout — offline";

  const palette = status === "ready" ? CYAN : MUTED;
  const animated = status === "ready";
  const cycleDuration = "5.5s";

  const btnRef = useRef<HTMLButtonElement>(null);
  const [box, setBox] = useState<{ w: number; h: number }>({ w: 0, h: 0 });
  useLayoutEffect(() => {
    const el = btnRef.current;
    if (!el) return;
    const measure = () => {
      const r = el.getBoundingClientRect();
      setBox({ w: r.width, h: r.height });
    };
    measure();
    const RO =
      typeof window !== "undefined"
        ? (window as typeof window & { ResizeObserver?: typeof ResizeObserver }).ResizeObserver
        : undefined;
    if (!RO) return;
    const ro = new RO(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const stroke = 2;
  const inset = stroke / 2;
  const w = Math.max(box.w, 0);
  const h = Math.max(box.h, 0);
  const rw = Math.max(w - stroke, 0);
  const rh = Math.max(h - stroke, 0);
  const r = Math.min(rw, rh) / 2;
  const perimeter =
    2 * Math.max(rw - 2 * r, 0) + 2 * Math.max(rh - 2 * r, 0) + 2 * Math.PI * r;
  const highlight = Math.max(perimeter * 0.16, 8);
  const gapId = useMemo(() => `scout-beacon-hi-${status}`, [status]);
  const baseId = useMemo(() => `scout-beacon-base-${status}`, [status]);

  return (
    <button
      ref={btnRef}
      type="button"
      onClick={() => openScout()}
      aria-label={label}
      title={label}
      data-scout-status={status}
      data-testid="scout-beacon"
      className={cn(
        "scout-beacon group relative isolate inline-flex shrink-0 items-center justify-center rounded-full bg-black",
        "focus:outline-none focus-visible:ring-2 focus-visible:ring-white/80 focus-visible:ring-offset-2 focus-visible:ring-offset-black",
        "transition-transform hover:scale-[1.02]",
        // Matches OnyxBeacon pill dimensions exactly.
        "h-10 gap-2 px-4",
        className,
      )}
    >
      {w > 0 && h > 0 && (
        <svg
          aria-hidden
          className="pointer-events-none absolute inset-0 h-full w-full overflow-visible"
          viewBox={`0 0 ${w} ${h}`}
          preserveAspectRatio="none"
        >
          <defs>
            <linearGradient id={baseId} x1="0" y1="0" x2="1" y2="1">
              <stop offset="0%" stopColor={palette.dim} />
              <stop offset="100%" stopColor={palette.dim} />
            </linearGradient>
            <linearGradient id={gapId} x1="0" y1="0" x2="1" y2="0">
              <stop offset="0%" stopColor={palette.base} stopOpacity="0" />
              <stop offset="55%" stopColor={palette.mid} stopOpacity="1" />
              <stop offset="100%" stopColor={palette.hi} stopOpacity="1" />
            </linearGradient>
          </defs>
          <rect
            x={inset}
            y={inset}
            width={rw}
            height={rh}
            rx={r}
            ry={r}
            fill="none"
            stroke={`url(#${baseId})`}
            strokeWidth={stroke}
          />
          <rect
            x={inset}
            y={inset}
            width={rw}
            height={rh}
            rx={r}
            ry={r}
            fill="none"
            stroke={`url(#${gapId})`}
            strokeWidth={stroke}
            strokeLinecap="round"
            pathLength={perimeter}
            strokeDasharray={`${highlight} ${Math.max(perimeter - highlight, 0.001)}`}
            style={
              animated
                ? {
                    animation: `onyx-beacon-trace ${cycleDuration} linear infinite`,
                    ["--onyx-beacon-perimeter" as string]: `${perimeter}`,
                  }
                : { strokeDashoffset: -perimeter * 0.25 }
            }
          />
        </svg>
      )}
      <span className="relative z-10 inline-flex items-center justify-center gap-2">
        <img
          src={scoutAsset.url}
          alt=""
          aria-hidden
          draggable={false}
          className={cn(
            "h-6 w-6 shrink-0 rounded-full object-cover",
            status === "offline" && "opacity-60 grayscale",
          )}
        />
        <span className="whitespace-nowrap text-[12.5px] font-semibold tracking-[0.18em] text-white">
          SCOUT
        </span>
      </span>
    </button>
  );
}
