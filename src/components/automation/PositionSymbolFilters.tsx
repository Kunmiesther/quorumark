import { LayoutGrid } from "lucide-react";
import { CoinBadge } from "@/components/trade/CoinBadge";

type Props = {
  options: ReadonlyArray<{ symbol: string; count: number }>;
  selected: string;
  onSelect: (symbol: string) => void;
};

export function PositionSymbolFilters({ options, selected, onSelect }: Props) {
  return (
    <div
      role="group"
      aria-label="Filter live positions by symbol"
      className="mt-4 flex flex-wrap gap-2"
    >
      {options.map(({ symbol, count }) => (
        <button
          key={symbol}
          type="button"
          aria-pressed={selected === symbol}
          onClick={() => onSelect(symbol)}
          className={`inline-flex min-h-10 shrink-0 items-center gap-2 whitespace-nowrap rounded-full px-3 py-2 text-xs transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-300 focus-visible:ring-offset-2 focus-visible:ring-offset-[#11121a] ${selected === symbol ? "tb-neu-inset bg-violet-500/20 text-violet-100 ring-1 ring-violet-400/40" : "tb-neu-raised text-white/70 hover:text-white"}`}
        >
          <span aria-hidden="true" className="flex shrink-0 items-center">
            {symbol === "ALL" ? (
              <LayoutGrid className="h-4 w-4" />
            ) : (
              <CoinBadge symbol={symbol} size={20} />
            )}
          </span>
          <span>{symbol === "ALL" ? "All symbols" : symbol}</span>{" "}
          <span className="min-w-5 rounded-full bg-black/20 px-1.5 py-0.5 text-center text-[10px] font-medium tabular-nums text-white/65">
            {count}
          </span>
        </button>
      ))}
    </div>
  );
}
