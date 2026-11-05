import { CoinBadge } from "./CoinBadge";

/** No invented quote currency for bare symbols or unknown instruments. */
export function splitAssetPair(symbol: string): [string, string | null] {
  const normalized = symbol.trim().toUpperCase();
  const separated = normalized.split(/[-/_]/);
  if (separated.length === 2 && separated.every(Boolean)) return [separated[0], separated[1]];
  const match = normalized.match(/^(.+?)(USDT|USDC|USD|BTC|ETH)$/);
  return match ? [match[1], match[2]] : [normalized, null];
}

export function PairBadge({
  symbol,
  size = 24,
  showLabel = true,
}: {
  symbol: string;
  size?: number;
  showLabel?: boolean;
}) {
  const [base, quote] = splitAssetPair(symbol);
  return (
    <span className="inline-flex min-w-0 items-center gap-2" aria-label={symbol}>
      <span
        className="relative inline-flex shrink-0 items-center"
        aria-hidden="true"
        style={{ width: quote ? size * 1.65 : size, height: size }}
      >
        {quote && (
          <span className="absolute right-0">
            <CoinBadge symbol={quote} size={size} />
          </span>
        )}
        <span className="relative z-10 rounded-full ring-2 ring-[#101118]">
          <CoinBadge symbol={base} size={size} />
        </span>
      </span>
      {showLabel && <span className="truncate">{symbol}</span>}
    </span>
  );
}
