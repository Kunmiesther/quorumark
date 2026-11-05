/**
 * CoinBadge — circular token badge with real icon and initials fallback.
 *
 * General icons use the pinned cryptocurrency-icons color set. Solana uses
 * its official gradient mark; the pinned set's green disc is outdated.
 *
 *   https://cdn.jsdelivr.net/npm/cryptocurrency-icons@0.18.1/svg/color/{slug}.svg
 *
 * Keyed by lowercased base ticker after stripping the quote pair suffix
 * (BTC-USDT → btc). Tickers known to be absent from the set fall through
 * to a bordered initials chip in the Onixus palette — no overlay dots, no
 * secondary badges are drawn on the icon itself.
 */
import { useState } from "react";

const OFFICIAL_ICONS: Record<string, string> = {
  SOL: "https://solana.com/src/img/branding/solanaLogoMark.svg",
};

const CDN_BASE = "https://cdn.jsdelivr.net/npm/cryptocurrency-icons@0.18.1/svg/color";

// Explicit "no icon exists in the set" list — skip the network fetch and
// go straight to the initials fallback. Keep this small; only tickers we
// have confirmed miss from cryptocurrency-icons@0.18.1.
const NO_ICON = new Set<string>(["APEX", "PENGU", "SUI", "PEPE", "WIF", "JUP"]);

// Overrides where the engine's ticker doesn't match the icon filename.
const SLUG_OVERRIDES: Record<string, string> = {
  MATIC: "matic",
  POL: "matic", // Polygon rebrand — still shipped under matic.svg
  SHIB: "shib",
};

function baseSymbol(sym: string): string {
  return (sym || "").toUpperCase().split(/[-/_]/)[0];
}

export function CoinBadge({
  symbol,
  size = 28,
  className,
}: {
  symbol: string;
  size?: number;
  className?: string;
}) {
  const base = baseSymbol(symbol);
  const [brokenSymbol, setBrokenSymbol] = useState<string | null>(null);
  const missing = NO_ICON.has(base) || brokenSymbol === base;

  if (!missing) {
    const slug = (SLUG_OVERRIDES[base] ?? base).toLowerCase();
    return (
      <img
        src={OFFICIAL_ICONS[base] ?? `${CDN_BASE}/${slug}.svg`}
        alt={base}
        width={size}
        height={size}
        loading="lazy"
        onError={() => setBrokenSymbol(base)}
        className={className}
        style={{
          width: size,
          height: size,
          borderRadius: "9999px",
          background: "#000",
          display: "inline-block",
          flexShrink: 0,
          objectFit: "contain",
          padding: base === "SOL" ? size * 0.14 : 0,
        }}
      />
    );
  }

  // Fallback: circular initials in Onixus palette. No overlay dots.
  const label = base.slice(0, 3);
  const fontSize = Math.max(9, Math.round(size * 0.34));
  return (
    <span
      className={className}
      style={{
        width: size,
        height: size,
        borderRadius: "9999px",
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        background: "color-mix(in oklab, var(--onixus-hot-blue) 22%, #000)",
        border: "1px solid color-mix(in oklab, var(--onixus-hot-blue) 45%, transparent)",
        color: "#fff",
        fontWeight: 700,
        fontSize,
        letterSpacing: "0.02em",
        flexShrink: 0,
        lineHeight: 1,
      }}
      aria-label={base}
      title={base}
    >
      {label}
    </span>
  );
}
