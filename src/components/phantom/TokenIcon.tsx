/**
 * TokenIcon — bundled, dependency-free brand marks for the handful of
 * tokens the app actually holds. Any unknown symbol falls back to a
 * bordered monogram that renders the full ticker (never a sliced "USD"
 * substring that confuses USDC and USDT).
 *
 * Kept as inline SVG on purpose:
 *   - zero network cost, zero image decode
 *   - crisp at any DPR
 *   - no external asset registry to maintain
 *   - safe fallback for coins we haven't drawn yet
 */

import { useId } from "react";

type Props = { symbol: string; size?: number; className?: string };

const NORMALIZE: Record<string, string> = {
  WBTC: "BTC",
  WETH: "ETH",
};

export function TokenIcon({ symbol, size = 44, className }: Props) {
  const raw = (symbol || "").trim().toUpperCase();
  const key = NORMALIZE[raw] ?? raw;
  const px = { width: size, height: size };
  const solGradId = useId();

  switch (key) {
    case "BTC":
      return (
        <svg viewBox="0 0 40 40" {...px} className={className} aria-hidden>
          <circle cx="20" cy="20" r="20" fill="#F7931A" />
          <path
            fill="#fff"
            d="M26.4 17.7c.4-2.4-1.5-3.7-4-4.5l.8-3.3-2-.5-.8 3.2-1.6-.4.8-3.2-2-.5-.8 3.3-1.3-.3-2.8-.7-.5 2.1s1.5.3 1.5.4c.8.2.9.7.9 1.1l-.9 3.7c.1 0 .2.1.3.1l-.3-.1-1.3 5.2c-.1.2-.3.6-.9.4 0 0-1.5-.4-1.5-.4l-1 2.3 2.6.7 1.4.4-.8 3.4 2 .5.8-3.3 1.6.4-.8 3.3 2 .5.8-3.4c3.4.7 6 .4 7.1-2.7.9-2.5-.1-3.9-1.9-4.9 1.3-.3 2.3-1.2 2.6-3zm-4.6 6.5c-.6 2.5-4.9 1.2-6.3.8l1.1-4.4c1.4.3 5.8 1 5.2 3.6zm.6-6.5c-.6 2.3-4.1 1.1-5.3.8l1-4c1.2.3 4.9.9 4.3 3.2z"
          />
        </svg>
      );
    case "ETH":
      return (
        <svg viewBox="0 0 40 40" {...px} className={className} aria-hidden>
          <circle cx="20" cy="20" r="20" fill="#627EEA" />
          <g fill="#fff">
            <path opacity="0.6" d="M20 5v11l9 4z" />
            <path d="M20 5l-9 15 9-4z" />
            <path opacity="0.6" d="M20 27v8l9-13z" />
            <path d="M20 35v-8l-9-5z" />
            <path opacity="0.2" d="M20 25l9-5-9-4z" />
            <path opacity="0.6" d="M11 20l9 5v-9z" />
          </g>
        </svg>
      );
    case "USDC":
      return (
        <svg viewBox="0 0 40 40" {...px} className={className} aria-hidden>
          <circle cx="20" cy="20" r="20" fill="#2775CA" />
          <path
            fill="#fff"
            d="M20 32.5c-6.9 0-12.5-5.6-12.5-12.5S13.1 7.5 20 7.5 32.5 13.1 32.5 20 26.9 32.5 20 32.5zm-.9-7.6v1.6h1.7v-1.6c2.2-.3 3.6-1.5 3.6-3.4 0-1.8-1.1-2.7-3.4-3.2l-1.7-.4c-1.4-.3-2-.7-2-1.5s.8-1.4 2.1-1.4c1.4 0 2.2.5 2.4 1.6h1.9c-.2-1.9-1.4-3-3.2-3.3v-1.6h-1.7v1.6c-2 .3-3.4 1.5-3.4 3.3 0 1.7 1.1 2.7 3.2 3.2l1.7.4c1.5.3 2.1.7 2.1 1.6 0 .9-.9 1.5-2.4 1.5-1.6 0-2.5-.6-2.6-1.7h-2c.1 2 1.5 3.1 3.7 3.3z"
          />
        </svg>
      );
    case "USDT":
      return (
        <svg viewBox="0 0 40 40" {...px} className={className} aria-hidden>
          <circle cx="20" cy="20" r="20" fill="#26A17B" />
          <path
            fill="#fff"
            d="M22.4 18.8v-2.5h5.7v-3.8H11.9v3.8h5.7v2.5c-4.7.2-8.2 1.1-8.2 2.2s3.5 2 8.2 2.2v7.9h4.8v-7.9c4.7-.2 8.2-1.1 8.2-2.2s-3.5-2-8.2-2.2zm0 3.7v-.1c-.1 0-.7.1-2.2.1-1.2 0-2.1-.1-2.4-.1v.1c-3.7-.2-6.5-.8-6.5-1.6s2.8-1.4 6.5-1.6v2.5c.3 0 1.2.1 2.4.1 1.4 0 2.1-.1 2.2-.1v-2.5c3.7.2 6.4.8 6.4 1.6.1.7-2.7 1.3-6.4 1.6z"
          />
        </svg>
      );
    case "SOL":
      return (
        <svg viewBox="0 0 40 40" {...px} className={className} aria-hidden>
          <defs>
            <linearGradient id={solGradId} x1="0" y1="0" x2="40" y2="40" gradientUnits="userSpaceOnUse">
              <stop offset="0" stopColor="#9945FF" />
              <stop offset="1" stopColor="#14F195" />
            </linearGradient>
          </defs>
          <circle cx="20" cy="20" r="20" fill="#0B0B12" />
          <g fill={`url(#${solGradId})`}>
            <path d="M12.6 25.6c.2-.2.5-.3.8-.3h14.3c.5 0 .7.6.4.9l-2.8 2.8c-.2.2-.5.3-.8.3H10.2c-.5 0-.7-.6-.4-.9l2.8-2.8z" />
            <path d="M12.6 11.6c.2-.2.5-.3.8-.3h14.3c.5 0 .7.6.4.9l-2.8 2.8c-.2.2-.5.3-.8.3H10.2c-.5 0-.7-.6-.4-.9l2.8-2.8z" />
            <path d="M25.3 18.5c-.2-.2-.5-.3-.8-.3H10.2c-.5 0-.7.6-.4.9l2.8 2.8c.2.2.5.3.8.3h14.3c.5 0 .7-.6.4-.9l-2.8-2.8z" />
          </g>
        </svg>
      );
    default: {
      // Truthful fallback: show the FULL ticker (up to 5 chars), bordered,
      // no colored fill that would fake a brand identity.
      const label = key.slice(0, 5);
      const fontSize = label.length >= 4 ? size * 0.28 : size * 0.36;
      return (
        <svg viewBox="0 0 40 40" {...px} className={className} aria-hidden>
          <circle cx="20" cy="20" r="19" fill="rgba(255,255,255,0.06)" stroke="rgba(255,255,255,0.14)" />
          <text
            x="20"
            y="20"
            textAnchor="middle"
            dominantBaseline="central"
            fontFamily="Space Grotesk, system-ui, sans-serif"
            fontWeight="700"
            fontSize={fontSize}
            fill="rgba(255,255,255,0.82)"
            letterSpacing="0.02em"
          >
            {label}
          </text>
        </svg>
      );
    }
  }
}
