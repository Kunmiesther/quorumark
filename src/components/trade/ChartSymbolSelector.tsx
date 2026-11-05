import { ChevronDown } from "lucide-react";

/** Uses the desk's market list and state; changing market never submits an order. */
export function ChartSymbolSelector({
  symbol,
  symbols,
  onSymbol,
}: {
  symbol: string;
  symbols: readonly string[];
  onSymbol: (symbol: string) => void;
}) {
  // A position opened at the venue may use a symbol outside the manual list.
  // Keep its current value visible without expanding the executable universe.
  const options = Array.from(new Set([symbol, ...symbols]));
  return (
    <div className="relative min-w-0 max-w-full">
      <select
        aria-label="Chart symbol"
        title="Change chart symbol"
        value={symbol}
        onChange={(event) => onSymbol(event.target.value)}
        className="tb-neu-raised min-h-11 max-w-full cursor-pointer appearance-none rounded-xl border border-white/10 bg-[#171821] py-2 pl-3 pr-9 text-[17px] font-semibold text-white transition hover:border-violet-400/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-400"
      >
        {options.map((option) => (
          <option key={option} value={option} className="bg-[#171821] text-white">
            {option.replace(/[-_]/g, " / ")}
          </option>
        ))}
      </select>
      <ChevronDown
        aria-hidden="true"
        className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-violet-300"
      />
    </div>
  );
}
