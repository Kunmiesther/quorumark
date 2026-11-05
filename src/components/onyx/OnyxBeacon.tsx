import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import { openOnyx, useOnyxOpen } from "@/components/onyx/OnyxPanel";
import { useAuth } from "@/hooks/useAuth";
import onyxHead from "@/assets/onyx-head.png.asset.json";

export type OnyxStatus = "ready" | "thinking" | "degraded" | "offline";

// ---------------------------------------------------------------------------
// Global Onyx activity signal.
// ---------------------------------------------------------------------------
let thinkingCount = 0;
const thinkingListeners = new Set<(n: number) => void>();
function emitThinking() {
  for (const l of thinkingListeners) l(thinkingCount);
}
export function beginOnyxThinking() {
  thinkingCount += 1;
  emitThinking();
}
export function endOnyxThinking() {
  thinkingCount = Math.max(0, thinkingCount - 1);
  emitThinking();
}
function useOnyxThinking(): boolean {
  const [n, setN] = useState(thinkingCount);
  useEffect(() => {
    const fn = (v: number) => setN(v);
    thinkingListeners.add(fn);
    return () => {
      thinkingListeners.delete(fn);
    };
  }, []);
  return n > 0;
}

let degradedFlag = false;
const degradedListeners = new Set<(v: boolean) => void>();
export function setOnyxDegraded(v: boolean) {
  degradedFlag = v;
  for (const l of degradedListeners) l(v);
}
function useOnyxDegraded(): boolean {
  const [v, setV] = useState(degradedFlag);
  useEffect(() => {
    const fn = (val: boolean) => setV(val);
    degradedListeners.add(fn);
    return () => {
      degradedListeners.delete(fn);
    };
  }, []);
  return v;
}

function useOnyxStatus(): OnyxStatus {
  const { user, isReady } = useAuth();
  const thinking = useOnyxThinking();
  const degraded = useOnyxDegraded();
  return useMemo(() => {
    if (degraded) return "degraded";
    if (!isReady || !user) return "offline";
    if (thinking) return "thinking";
    return "ready";
  }, [degraded, isReady, user, thinking]);
}

const STATUS_LABEL: Record<OnyxStatus, string> = {
  ready: "active",
  thinking: "thinking",
  degraded: "degraded",
  offline: "offline",
};

type PaletteId = "onyx" | "amber" | "muted";
const STATUS_PALETTE: Record<OnyxStatus, PaletteId> = {
  ready: "onyx",
  thinking: "onyx",
  degraded: "amber",
  offline: "muted",
};

const PALETTE_STOPS: Record<PaletteId, { base: string; mid: string; hi: string; dim: string }> = {
  onyx:   { base: "#1E90FF", mid: "#22D3EE", hi: "#9945FF", dim: "rgba(120,140,220,0.35)" },
  amber:  { base: "#F59E0B", mid: "#FBBF24", hi: "#B45309", dim: "rgba(245,158,11,0.30)" },
  muted:  { base: "#94A3B8", mid: "#64748B", hi: "#94A3B8", dim: "rgba(148,163,184,0.25)" },
};

export type OnyxBeaconVariant = "pill" | "compact" | "fab";

interface Props {
  variant?: OnyxBeaconVariant;
  className?: string;
  statusOverride?: OnyxStatus;
}

/**
 * OnyxBeacon — global Onyx identity + status control.
 *
 * The pill, its border, logo, text, and glow are ALL stationary. Only a
 * concentrated highlight travels clockwise along a fixed rounded-rect SVG
 * stroke, like light moving through a stationary wire. No transform:rotate
 * is ever applied. Reduced-motion shows a static illuminated edge.
 */
export function OnyxBeacon({
  variant = "pill",
  className,
  statusOverride,
}: Props) {
  const detectedStatus = useOnyxStatus();
  const status = statusOverride ?? detectedStatus;
  const open = useOnyxOpen();
  const label = open
    ? `Close Onyx — ${STATUS_LABEL[status]}`
    : `Open Onyx — ${STATUS_LABEL[status]}`;

  const isFab = variant === "fab";
  const isCompact = variant === "compact";

  const dims = isFab
    ? { size: "h-14 w-14", logo: "h-8 w-8", text: "" }
    : isCompact
      ? { size: "h-9 px-3 gap-1.5", logo: "h-5 w-5", text: "text-[11.5px]" }
      : { size: "h-10 px-4 gap-2", logo: "h-6 w-6", text: "text-[12.5px]" };

  const palette = PALETTE_STOPS[STATUS_PALETTE[status]];
  const animated = status === "ready" || status === "thinking";
  const cycleDuration = status === "thinking" ? "2.8s" : "5.5s";

  // Measure pill geometry so the SVG path exactly matches the rounded perimeter
  // at any width. This keeps the tracer glued to the border with no scaling.
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
    const RO = typeof window !== "undefined" ? (window as typeof window & { ResizeObserver?: typeof ResizeObserver }).ResizeObserver : undefined;
    if (!RO) return;
    const ro = new RO(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Build a rounded-rect path inset by 1px so the 2px stroke sits exactly on
  // the pill perimeter. r = (h-2)/2 gives a true capsule.
  const stroke = 2;
  const inset = stroke / 2;
  const w = Math.max(box.w, 0);
  const h = Math.max(box.h, 0);
  const rw = Math.max(w - stroke, 0);
  const rh = Math.max(h - stroke, 0);
  const r = Math.min(rw, rh) / 2;
  const perimeter = 2 * Math.max(rw - 2 * r, 0) + 2 * Math.max(rh - 2 * r, 0) + 2 * Math.PI * r;
  const highlight = Math.max(perimeter * 0.16, 8); // ~16% of perimeter
  const gapId = `onyx-beacon-hi-${status}`;
  const baseId = `onyx-beacon-base-${status}`;

  return (
    <button
      ref={btnRef}
      type="button"
      onClick={() => openOnyx()}
      aria-label={label}
      title={label}
      data-onyx-status={status}
      data-testid="onyx-beacon"
      className={cn(
        "onyx-beacon group relative isolate inline-flex shrink-0 items-center justify-center rounded-full bg-black",
        status === "ready" &&
          "shadow-[0_0_18px_rgba(34,211,238,0.28),0_0_34px_rgba(153,69,255,0.18)]",
        "focus:outline-none focus-visible:ring-2 focus-visible:ring-white/80 focus-visible:ring-offset-2 focus-visible:ring-offset-black",
        "transition-transform hover:scale-[1.02]",
        dims.size,
        className,
      )}
    >
      {/* Fixed SVG border — dim base ring + traveling highlight tracer.
          The SVG itself never rotates; only stroke-dashoffset changes. */}
      {w > 0 && h > 0 && (
        <svg
          aria-hidden
          className="onyx-beacon-ring pointer-events-none absolute inset-0 h-full w-full overflow-visible"
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
          {/* Dim fixed base perimeter */}
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
          {/* Traveling highlight — stationary path, only dashoffset animates */}
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
                    // Custom prop consumed by the keyframes.
                    ["--onyx-beacon-perimeter" as string]: `${perimeter}`,
                  }
                : { strokeDashoffset: -perimeter * 0.25 }
            }
          />
        </svg>
      )}
      {/* Foreground content */}
      <span className="relative z-10 inline-flex items-center justify-center gap-2">
        <img
          src={onyxHead.url}
          alt=""
          aria-hidden
          draggable={false}
          className={cn(
            "shrink-0 object-contain",
            dims.logo,
            status === "thinking" && "onyx-beacon-logo-pulse",
            status === "offline" && "opacity-60 grayscale",
          )}
          style={{ mixBlendMode: "screen" }}
        />
        {!isFab && (
          <span
            className={cn(
              "font-semibold tracking-[0.18em] text-white whitespace-nowrap",
              dims.text,
            )}
          >
            ONYX
          </span>
        )}
      </span>
    </button>
  );
}
