/**
 * BOS color goes on the LINE STROKE only — never on the chart background,
 * plot area, panel, or a colored region fill. Guards against regressions
 * where a low-opacity area/fill leaks the regime color under the line and
 * reads as a tinted background.
 *
 * Also guards the cinematic "World Journey" decorative layer contract:
 *   - lives behind the chart
 *   - never captures pointer events
 *   - carries a near-black readability scrim
 *   - motion is CSS transform-driven (no rAF/state churn)
 *   - honors prefers-reduced-motion
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

const SRC = fs.readFileSync(
  path.resolve(__dirname, "../BotLineChart.tsx"),
  "utf8",
);
const WORLD_SRC = fs.readFileSync(
  path.resolve(__dirname, "../BotWorldJourney.tsx"),
  "utf8",
);
const STYLES = fs.readFileSync(
  path.resolve(__dirname, "../../../styles.css"),
  "utf8",
);

describe("BotLineChart: BOS color lives on the stroke, not the background", () => {
  it("has no <Area> series (would fill under the line)", () => {
    expect(SRC).not.toMatch(/<Area[\s>]/);
    expect(SRC).not.toMatch(/<ReferenceArea[\s>]/);
    expect(SRC).not.toMatch(/fillOpacity=/);
  });

  it("Line elements set fill=\"none\" so recharts never tints below the curve", () => {
    const lineBlocks = SRC.match(/<Line[\s\S]*?\/>/g) ?? [];
    expect(lineBlocks.length).toBeGreaterThan(0);
    for (const block of lineBlocks) {
      expect(block).toMatch(/fill="none"/);
    }
  });

  it("regimeColor is applied to stroke, dot fill, and mark-line only — never to a plot/panel background", () => {
    expect(SRC).not.toMatch(/background:\s*regimeColor/);
    expect(SRC).not.toMatch(/backgroundColor:\s*regimeColor/);
    expect(SRC).not.toMatch(/<rect[^>]*fill=\{regimeColor\}/);
  });

  it("chart container is jet black, constant across BOS states", () => {
    expect(SRC).toMatch(/bg-black/);
  });

  it("price line stroke is prominent (>= 2.5px) so it reads on the dark canvas", () => {
    // Approved UI contract: a single continuous natural line (the split
    // head/tail series was removed with the Solana-gradient comet redesign).
    const line = SRC.match(/dataKey="price"[\s\S]*?\/>/);
    expect(line).not.toBeNull();
    const width = line![0].match(/strokeWidth=\{(\d+(?:\.\d+)?)\}/);
    expect(width).not.toBeNull();
    expect(parseFloat(width![1])).toBeGreaterThanOrEqual(2.5);
  });

});

describe("BotLineChart: cinematic World Journey background layer", () => {
  it("mounts the BotWorldJourney layer inside the chart container", () => {
    expect(SRC).toMatch(/<BotWorldJourney\s*\/>/);
    expect(SRC).toMatch(/from "\.\/BotWorldJourney"/);
  });

  it("world layer is non-interactive (pointer-events: none)", () => {
    expect(WORLD_SRC).toMatch(/pointer-events-none/);
  });

  it("world layer sits behind the chart via z-index stacking", () => {
    // Decorative layer: zIndex 0. Chart wrapper: zIndex 1.
    expect(WORLD_SRC).toMatch(/zIndex:\s*0/);
    expect(SRC).toMatch(/zIndex:\s*1/);
  });

  it("readability scrim + vignette sit above the art without hiding it", () => {
    // Approved cinematic contract: the world art must stay visible (the owner
    // asked for the line to travel THROUGH the environments), so the flat
    // scrim is intentionally light and legibility comes from scrim + a
    // top/bottom vignette + a 3.25px glowing stroke.
    const scrim = WORLD_SRC.match(
      /data-testid="botline-world-scrim"[\s\S]{0,240}?rgba\(0,0,0,(0?\.\d+)\)/,
    );
    expect(scrim).not.toBeNull();
    const opacity = parseFloat(scrim![1]);
    expect(opacity).toBeGreaterThanOrEqual(0.2);
    expect(opacity).toBeLessThanOrEqual(0.6);
    // Vignette gradient keeps the top/bottom edges dark for axis labels.
    expect(WORLD_SRC).toMatch(/linear-gradient\(to bottom, rgba\(0,0,0,0?\.\d+\)/);
  });

  it("uses ONLY existing cinematic asset pointers (no generated imagery)", () => {
    // Locked pairing set — see the BotWorldJourney Accumulator lock.
    for (const asset of [
      "bg_cave_water",
      "bg_desert_planet",
      "bg_purple_alley",
      "bg_server_room",
      "bg_lava_volcano",
      "bg_accumulator_shatter",
    ]) {
      expect(WORLD_SRC).toMatch(new RegExp(`${asset}\\.png\\.asset\\.json`));
    }
    for (const turtle of [
      "turtle-accumulator-cutout",
      "turtle-vanguard-cutout",
      "turtle-sniper-cutout",
      "turtle-scout-cutout",
      "turtle-arbiter-cutout",
      "turtle-hunter-cutout",
    ]) {
      expect(WORLD_SRC).toMatch(new RegExp(`${turtle}\\.webp`));
    }
  });

  it("motion is CSS-transform driven (no rAF/setInterval in the layer)", () => {

    expect(WORLD_SRC).not.toMatch(/requestAnimationFrame/);
    expect(WORLD_SRC).not.toMatch(/setInterval/);
    expect(WORLD_SRC).toMatch(/botline-world-journey-strip/);
    // Keyframes + animation utility are declared in the global stylesheet.
    expect(STYLES).toMatch(/@keyframes\s+botline-world-journey/);
    expect(STYLES).toMatch(/\.botline-world-journey-strip\s*\{[^}]*animation-name:\s*botline-world-journey/);
    // Duration lives in a cinematic 90–120s window (doubled for the mirrored strip).
    const dur = WORLD_SRC.match(/JOURNEY_SECONDS\s*=\s*(\d+)/);
    expect(dur).not.toBeNull();
    const secs = parseInt(dur![1], 10);
    expect(secs).toBeGreaterThanOrEqual(90);
    expect(secs).toBeLessThanOrEqual(120);
  });

  it("honors prefers-reduced-motion (no panning animation)", () => {
    expect(WORLD_SRC).toMatch(/useReducedMotion/);
    expect(WORLD_SRC).toMatch(/reduced\s*\?\s*undefined\s*:\s*"botline-world-journey-strip"/);
    expect(STYLES).toMatch(/prefers-reduced-motion[\s\S]*botline-world-journey-strip[\s\S]*animation:\s*none/);
  });

  it("adjacent worlds blend via gradient masks (no hard slideshow cuts)", () => {
    expect(WORLD_SRC).toMatch(/maskImage:\s*"linear-gradient/);
  });
});
