/**
 * Convenience wrapper: fetch live candles + ticker for a symbol and render
 * PositionBotChart. Used on the paper page (secondary mount). The primary
 * mount on the Trade page passes candles + livePrice directly from the
 * existing page-level queries to avoid duplicate fetches.
 */
import { useCandles } from "@/hooks/useCandles";
import { useApexTicker } from "@/hooks/useApexTicker";
import {
  PositionBotChart,
  type BotChartPosition,
  type BotChartTrade,
  type BotChartEvent,
} from "./PositionBotChart";

export function PositionBotChartAuto({
  symbol,
  position,
  trades,
  events,
  watchingLabel,
  height,
}: {
  symbol: string;
  position: BotChartPosition | null;
  trades?: BotChartTrade[];
  events?: BotChartEvent[];
  watchingLabel?: string;
  height?: number;
}) {
  const candlesQ = useCandles(symbol, "15m", 200);
  const tickerQ = useApexTicker(symbol, true);
  return (
    <PositionBotChart
      symbol={symbol}
      candles={candlesQ.data ?? []}
      livePrice={tickerQ.data?.price ?? null}
      livePriceTs={tickerQ.data?.fetchedAt ?? null}
      position={position}
      trades={trades}
      events={events}
      watchingLabel={watchingLabel}
      height={height}
    />
  );
}
