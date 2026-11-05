import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  MAX_SELECTABLE_LEVERAGE,
  MIN_SELECTABLE_LEVERAGE,
  clampLeverage,
  getLeverageRisk,
} from "@/lib/strategy-config";

export interface LeverageSelectorProps {
  initialLeverage?: number;
  capital?: number;
  strategySlug?: string;
  onChange?: (leverage: number, riskPct: number, positionSize: number) => void;
}

// CONTINUOUS 1..100, not a preset list.
//
// This used to snap to [50, 100, 200, 300, 400, 500]. Four of those six were
// impossible: the pilot ceiling, the signer and the venue all cap at 100, so
// picking 500x quietly produced 100x. The picker was describing a system that
// does not exist.
const MIN = MIN_SELECTABLE_LEVERAGE;
const MAX = MAX_SELECTABLE_LEVERAGE;

// Marks are labels on the track, NOT the only reachable values — every
// integer between MIN and MAX can be selected.
const MARKS = [1, 25, 50, 75, 100] as const;

/** Track position 0..1 for a leverage. Linear: the scale is now uniform. */
function leverageToFrac(lev: number): number {
  return (clampLeverage(lev) - MIN) / (MAX - MIN);
}
function fracToLeverage(frac: number): number {
  const clamped = Math.max(0, Math.min(1, frac));
  return clampLeverage(Math.round(MIN + clamped * (MAX - MIN)));
}

/** Risk color: low leverage = green, mid = yellow/orange, high = red-ish. */
function riskColor(lev: number): string {
  // 1x = safest (green), 100x = riskiest (red-orange). Continuous now, so the
  // colour tracks the actual value rather than a preset's rank.
  const t = leverageToFrac(lev);
  // Interpolate hue: 150 (green) → 35 (orange) → 12 (red-orange)
  const hue = 150 - t * 138;
  return `oklch(0.78 0.19 ${hue})`;
}

export function LeverageSelector({
  initialLeverage = 100,
  capital = 500,
  onChange,
}: LeverageSelectorProps) {
  const [leverage, setLeverage] = useState<number>(() =>
    clampLeverage(initialLeverage),
  );
  const [dragging, setDragging] = useState(false);
  const trackRef = useRef<HTMLDivElement | null>(null);

  const riskPct = getLeverageRisk(leverage);
  const positionSize = useMemo(
    () => Math.round(capital * (leverage / 100) * 100) / 100,
    [capital, leverage],
  );
  const frac = leverageToFrac(leverage);
  const accent = riskColor(leverage);

  useEffect(() => {
    onChange?.(leverage, riskPct, positionSize);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [leverage, capital]);

  const setFromClientX = useCallback((clientX: number) => {
    const el = trackRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const f = (clientX - rect.left) / rect.width;
    setLeverage(fracToLeverage(f));
  }, []);

  // Pointer drag
  useEffect(() => {
    if (!dragging) return;
    const move = (e: PointerEvent) => setFromClientX(e.clientX);
    const up = () => setDragging(false);
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
    };
  }, [dragging, setFromClientX]);

  function onKeyDown(e: React.KeyboardEvent) {
    // 1x per arrow, 10x per Page key — a 1..100 range needs a coarse step too
    // or crossing it takes 99 presses.
    const step = e.shiftKey ? 10 : 1;
    if (e.key === "ArrowLeft" || e.key === "ArrowDown") {
      e.preventDefault();
      setLeverage(clampLeverage(leverage - step));
    } else if (e.key === "ArrowRight" || e.key === "ArrowUp") {
      e.preventDefault();
      setLeverage(clampLeverage(leverage + step));
    } else if (e.key === "PageDown") {
      e.preventDefault();
      setLeverage(clampLeverage(leverage - 10));
    } else if (e.key === "PageUp") {
      e.preventDefault();
      setLeverage(clampLeverage(leverage + 10));
    } else if (e.key === "Home") {
      e.preventDefault();
      setLeverage(MIN);
    } else if (e.key === "End") {
      e.preventDefault();
      setLeverage(MAX);
    }
  }

  return (
    <div
      className="space-y-5 rounded-[18px] border border-white/10 bg-white/[0.05] p-4 backdrop-blur-xl shadow-[0_1px_0_0_rgba(255,255,255,0.04)_inset]"
      style={{ transition: "border-color 280ms cubic-bezier(.22,1,.36,1)" }}
    >
      {/* Headline value + risk */}
      <div className="flex items-end justify-between gap-3">
        <div>
          <h2 className="text-[10.5px] uppercase tracking-[0.14em] text-muted-foreground">
            Leverage
          </h2>
          <div className="flex items-baseline gap-1">
            <span
              className="num font-display text-4xl font-bold tabular-nums tracking-tight transition-colors"
              style={{ color: accent }}
            >
              {leverage}
            </span>
            <span className="text-lg font-semibold text-foreground/70">X</span>
          </div>
        </div>
        <div className="text-right">
          <h2 className="text-[10.5px] uppercase tracking-[0.14em] text-muted-foreground">
            Risk / Stop
          </h2>
          <div
            className="num font-display text-3xl font-bold tabular-nums"
            style={{ color: accent }}
          >
            {riskPct}%
          </div>
        </div>
      </div>

      {/* Interactive track */}
      <div className="space-y-2">
        <div className="flex items-center justify-between text-[10.5px] font-medium tabular-nums text-muted-foreground">
          <span>{MIN}X</span>
          <span>{MAX}X</span>
        </div>
        <div
          ref={trackRef}
          role="slider"
          tabIndex={0}
          aria-valuemin={MIN}
          aria-valuemax={MAX}
          aria-valuenow={leverage}
          aria-label="Leverage"
          onPointerDown={(e) => {
            e.preventDefault();
            (e.target as Element).setPointerCapture?.(e.pointerId);
            setDragging(true);
            setFromClientX(e.clientX);
          }}
          onKeyDown={onKeyDown}
          className="relative h-9 cursor-pointer select-none rounded-full px-2 outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
        >
          {/* base track */}
          <div className="absolute inset-x-2 top-1/2 h-2 -translate-y-1/2 overflow-hidden rounded-full bg-white/[0.08]">
            {/* filled portion */}
            <div
              className="absolute inset-y-0 left-0 rounded-full"
              style={{
                width: `${frac * 100}%`,
                background: `linear-gradient(90deg, oklch(0.78 0.19 150), ${accent})`,
                transition: "width 320ms cubic-bezier(.22,1,.36,1), background 320ms cubic-bezier(.22,1,.36,1)",
              }}
            />
          </div>

          {/* scale marks — labels on a continuous track, not the only stops */}
          <div className="pointer-events-none absolute inset-x-2 top-1/2 -translate-y-1/2">
            {MARKS.map((p) => {
              const f = leverageToFrac(p);
              const active = p === leverage;
              return (
                <span
                  key={p}
                  className="absolute top-1/2 h-1.5 w-1.5 -translate-x-1/2 -translate-y-1/2 rounded-full transition-colors"
                  style={{
                    left: `${f * 100}%`,
                    background: active ? "transparent" : "rgba(255,255,255,0.25)",
                  }}
                />
              );
            })}
          </div>

          {/* thumb */}
          <div
            className="pointer-events-none absolute top-1/2 -translate-y-1/2"
            style={{
              left: `calc(${frac * 100}% + 8px - ${frac * 16}px)`,
              transition: dragging
                ? "none"
                : "left 320ms cubic-bezier(.22,1,.36,1)",
            }}
          >
            <div
              className="h-4 w-4 -translate-x-1/2 rounded-full border-2 border-background"
              style={{
                background: accent,
                boxShadow: dragging
                  ? `0 0 24px ${accent}, 0 0 0 6px rgba(168,85,247,0.18)`
                  : `0 0 14px ${accent}`,
                transition: "box-shadow 220ms cubic-bezier(.22,1,.36,1)",
              }}
            />
          </div>
        </div>

        {/* risk gradient indicator */}
        <div className="h-1.5 w-full overflow-hidden rounded-full">
          <div
            className="h-full w-full"
            style={{
              background:
                "linear-gradient(90deg, oklch(0.82 0.19 150) 0%, oklch(0.85 0.18 100) 35%, oklch(0.80 0.19 60) 65%, oklch(0.72 0.20 25) 100%)",
              opacity: 0.55,
            }}
          />
        </div>
      </div>

      {/* Quick picks. Shortcuts to common values — the slider and the arrow
          keys reach every integer from 1 to 100. */}
      <div className="grid grid-cols-5 gap-1.5">
        {MARKS.map((p) => {
          const active = p === leverage;
          return (
            <button
              key={p}
              type="button"
              onClick={() => setLeverage(p)}
              className="num rounded-lg border px-1 py-1.5 text-[11.5px] font-semibold tabular-nums transition-all"
              style={
                active
                  ? {
                      borderColor: accent,
                      background: "rgba(168,85,247,0.10)",
                      color: accent,
                      boxShadow: `0 0 16px ${accent}40, inset 0 0 0 1px ${accent}55`,
                    }
                  : {
                      borderColor: "rgba(255,255,255,0.08)",
                      background: "rgba(255,255,255,0.025)",
                      color: "var(--muted-foreground)",
                    }
              }
            >
              {p}X
            </button>
          );
        })}
      </div>

      {/* Position info card */}
      <div className="space-y-3 rounded-[14px] border border-white/[0.07] bg-black/30 p-3">
        <div className="flex items-center justify-between">
          <span className="text-[10.5px] uppercase tracking-[0.14em] text-muted-foreground">
            Position Size
          </span>
          <span className="num text-[15px] font-bold tabular-nums text-foreground">
            ${positionSize.toLocaleString()}
          </span>
        </div>
        <div className="text-[10.5px] text-muted-foreground">
          <span className="num tabular-nums">${capital.toLocaleString()}</span> ×{" "}
          <span className="num tabular-nums">{leverage}</span> / 100
        </div>

        <div className="space-y-1.5">
          <div className="flex items-center justify-between text-[10.5px]">
            <span className="uppercase tracking-[0.14em] text-muted-foreground">
              Risk Gauge
            </span>
            <span className="num font-semibold tabular-nums" style={{ color: accent }}>
              {riskPct}%
            </span>
          </div>
          <div className="h-2 w-full overflow-hidden rounded-full bg-white/[0.06]">
            <div
              className="h-full rounded-full"
              style={{
                // Scale: 11% is max in map → fill % accordingly (cap at 100%).
                width: `${Math.min(100, (riskPct / 11) * 100)}%`,
                background: accent,
                boxShadow: `0 0 10px ${accent}80`,
                transition:
                  "width 320ms cubic-bezier(.22,1,.36,1), background 320ms cubic-bezier(.22,1,.36,1)",
              }}
            />
          </div>
        </div>
      </div>
    </div>
  );
}
