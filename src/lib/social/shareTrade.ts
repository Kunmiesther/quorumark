export interface ShareableTrade {
  symbol: string;
  direction: "long" | "short";
  entry: number;
  exit: number;
  book: "paper" | "live";
}

export function tradeMovePct(trade: ShareableTrade): number | null {
  if (!Number.isFinite(trade.entry) || !Number.isFinite(trade.exit) || trade.entry <= 0) return null;
  const raw = ((trade.exit - trade.entry) / trade.entry) * 100;
  return trade.direction === "short" ? -raw : raw;
}

export function tradeShareText(trade: ShareableTrade): string {
  const move = tradeMovePct(trade);
  const result = move == null ? "completed" : `${move >= 0 ? "+" : ""}${move.toFixed(2)}%`;
  return [
    `${trade.book === "paper" ? "PAPER TRADE" : "LIVE TRADE"} · ${trade.symbol.replace("-", "/")}`,
    `${trade.direction.toUpperCase()} · ${result}`,
    "Powered by TurtleBot · @turtlebotapp · Past performance does not guarantee future results.",
  ].join("\n");
}

export async function shareTrade(trade: ShareableTrade): Promise<"shared" | "copied"> {
  const text = tradeShareText(trade);
  if (typeof navigator !== "undefined" && typeof navigator.share === "function") {
    await navigator.share({ title: "TurtleBot trade result", text, url: "https://www.turtlebot.app" });
    return "shared";
  }
  if (typeof navigator !== "undefined" && navigator.clipboard) {
    await navigator.clipboard.writeText(`${text}\nhttps://www.turtlebot.app`);
    return "copied";
  }
  throw new Error("Sharing is not supported on this device.");
}
