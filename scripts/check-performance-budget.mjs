import { readdirSync, statSync } from "node:fs";
import { basename, join } from "node:path";

const assetDir = ".output/public/assets";
const files = readdirSync(assetDir).map((name) => ({
  name,
  bytes: statSync(join(assetDir, name)).size,
}));

const budgets = [
  { label: "JavaScript chunk", match: (name) => name.endsWith(".js"), max: 625 * 1024 },
  { label: "CSS bundle", match: (name) => name.endsWith(".css"), max: 300 * 1024 },
  { label: "Raster asset", match: (name) => /\.(png|jpe?g|webp)$/i.test(name), max: 410 * 1024 },
];

let failed = false;
for (const budget of budgets) {
  const candidates = files.filter((file) => budget.match(file.name));
  const largest = candidates.sort((a, b) => b.bytes - a.bytes)[0];
  if (!largest) continue;
  const ok = largest.bytes <= budget.max;
  failed ||= !ok;
  console.log(
    `${ok ? "✓" : "✗"} ${budget.label}: ${basename(largest.name)} ${(largest.bytes / 1024).toFixed(1)} KiB / ${(budget.max / 1024).toFixed(0)} KiB`,
  );
}

if (failed) process.exitCode = 1;
