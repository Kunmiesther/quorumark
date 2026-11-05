/**
 * Life-Map-scoped turtle art. These action-shot images are used ONLY on the
 * /life-map strategy cards. The locked masters in `turtle-images.ts` remain
 * the source of truth for /strategies, /squad, and the rest of the app.
 *
 * Falls back to the master image for any slug not overridden here.
 */
import vanguard from "@/assets/lifemap-vanguard.png.asset.json";
import accumulator from "@/assets/lifemap-accumulator.png.asset.json";
import sniper from "@/assets/lifemap-sniper.png.asset.json";
import arbiter from "@/assets/lifemap-arbiter.png.asset.json";
import hunter from "@/assets/lifemap-hunter.png.asset.json";
import scout from "@/assets/lifemap-scout.png.asset.json";
import { turtleImage as masterTurtleImage } from "./turtle-images";

const LIFEMAP_OVERRIDES: Record<string, string> = {
  "break-retest": vanguard.url,
  dca: accumulator.url,
  "rsi-divergence": sniper.url,
  "funding-arb": arbiter.url,
  "liq-hunting": hunter.url,
  "ema-cross": scout.url,
};

export function lifeMapTurtleImage(slug: string): string {
  return LIFEMAP_OVERRIDES[slug] ?? masterTurtleImage(slug);
}
