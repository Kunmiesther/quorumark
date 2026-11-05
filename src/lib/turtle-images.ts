import accumulator from "@/assets/turtle-accumulator.webp";
import vanguard from "@/assets/turtle-vanguard.webp";
import sniper from "@/assets/turtle-sniper.webp";
import scout from "@/assets/turtle-scout.webp";
import arbiter from "@/assets/turtle-arbiter.webp";
import hunter from "@/assets/turtle-hunter.webp";

export const TURTLE_IMAGES: Record<string, string> = {
  dca: accumulator,
  "break-retest": vanguard,
  "rsi-divergence": sniper,
  "ema-cross": scout,
  "funding-arb": arbiter,
  "liq-hunting": hunter,
};

export function turtleImage(slug: string): string {
  return TURTLE_IMAGES[slug] ?? accumulator;
}
