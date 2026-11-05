import { motion, useReducedMotion } from "framer-motion";

export type CharacterBeaconProps = {
  portrait: string;
  name: string;
  caption: string;
  accent?: string; // hex or css color; default cyan
  size?: "sm" | "md" | "lg";
  status?: string;
};

const SIZE_MAP = {
  sm: { box: "w-[220px]", portrait: 168, ring: 200 },
  md: { box: "w-[260px]", portrait: 200, ring: 236 },
  lg: { box: "w-[300px]", portrait: 236, ring: 276 },
};

/**
 * Scout-style radar beacon card. Circular portrait floating inside animated
 * radar rings, with a name and a stat caption underneath. Used as a recurring
 * visual motif across the landing page — one beacon per character per section.
 */
export function CharacterBeacon({
  portrait,
  name,
  caption,
  accent = "#22D3EE",
  size = "md",
  status,
}: CharacterBeaconProps) {
  const reduce = useReducedMotion();
  const s = SIZE_MAP[size];

  return (
    <div
      className={`relative mx-auto ${s.box} shrink-0 select-none`}
      style={{ ["--beacon" as string]: accent }}
    >
      {/* transparent stage — bleeds into the page background */}
      <div
        className="relative px-4 pb-4 pt-5"
      >
        {/* faint corner ticks */}
        <span className="pointer-events-none absolute right-3 top-3 h-2.5 w-2.5 border-r border-t" style={{ borderColor: `${accent}66` }} />
        <span className="pointer-events-none absolute bottom-14 right-3 h-2.5 w-2.5 border-b border-r" style={{ borderColor: `${accent}66` }} />

        {/* radar stage */}
        <div className="relative mx-auto flex aspect-square w-full items-center justify-center">
          {/* rings */}
          <svg
            aria-hidden
            viewBox="0 0 200 200"
            className="absolute inset-0 h-full w-full"
          >

            {[92, 74, 56, 38].map((r, i) => (
              <circle
                key={r}
                cx="100"
                cy="100"
                r={r}
                fill="none"
                stroke={accent}
                strokeOpacity={0.14 + i * 0.05}
                strokeWidth={0.6}
              />
            ))}
            {/* crosshairs */}
            <line x1="5" y1="100" x2="195" y2="100" stroke={accent} strokeOpacity="0.12" strokeWidth="0.5" />
            <line x1="100" y1="5" x2="100" y2="195" stroke={accent} strokeOpacity="0.12" strokeWidth="0.5" />
          </svg>

          {/* sweeping radar arm */}
          {!reduce && (
            <motion.div
              className="absolute inset-0 origin-center"
              animate={{ rotate: 360 }}
              transition={{ duration: 6, ease: "linear", repeat: Infinity }}
              aria-hidden
            >
              <div
                className="absolute left-1/2 top-1/2 h-1/2 w-1/2 origin-top-left"
                style={{
                  background: `conic-gradient(from 0deg, ${accent}55, transparent 55%)`,
                  clipPath: "polygon(0 0, 100% 0, 0 100%)",
                  opacity: 0.55,
                }}
              />
            </motion.div>
          )}

          {/* pulse rings */}
          {!reduce && (
            <>
              {[0, 1.4].map((delay) => (
                <motion.span
                  key={delay}
                  className="absolute rounded-full border"
                  style={{ borderColor: `${accent}55`, width: s.ring, height: s.ring }}
                  initial={{ opacity: 0.5, scale: 0.6 }}
                  animate={{ opacity: 0, scale: 1 }}
                  transition={{ duration: 2.8, delay, repeat: Infinity, ease: "easeOut" }}
                />
              ))}
            </>
          )}

          {/* portrait — full character, uncropped, floating over the radar */}
          <div
            className="relative flex items-end justify-center"
            style={{
              width: s.portrait,
              height: s.portrait,
              filter: `drop-shadow(0 8px 16px rgba(0,0,0,0.55)) drop-shadow(0 0 8px ${accent}22)`,
            }}
          >
            <img
              src={portrait}
              alt={name}
              loading="lazy"
              className="h-full w-full object-contain"
            />
          </div>
        </div>

        {/* caption */}
        <div className="mt-3 text-center">
          <p
            className="font-display text-[15px] font-semibold uppercase tracking-[0.42em] text-white"
            style={{ textShadow: `0 0 18px ${accent}55` }}
          >
            {name}
          </p>
          <p className="mt-2 rounded-md bg-white/[0.03] py-1.5 text-[11.5px] text-white/70">
            {caption}
          </p>
          {status && (
            <p
              className="mt-2 inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[9.5px] uppercase tracking-[0.22em]"
              style={{ borderColor: `${accent}55`, color: accent }}
            >
              <span className="h-1 w-1 rounded-full" style={{ background: accent }} />
              {status}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
