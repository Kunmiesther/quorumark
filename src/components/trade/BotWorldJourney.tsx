// Decorative "TurtleBot World Journey" background strip for BotLineChart.
//
// Each tile pairs an environment background with its resident turtle
// character (background removed) standing at ground level.
import { useMemo } from "react";
import { useReducedMotion } from "@/hooks/useReducedMotion";

import bgCaveWater from "@/assets/bg_cave_water.png.asset.json";
import bgDesertPlanet from "@/assets/bg_desert_planet.png.asset.json";

import bgPurpleAlley from "@/assets/bg_purple_alley.png.asset.json";
import bgServerRoom from "@/assets/bg_server_room.png.asset.json";
import bgLavaVolcano from "@/assets/bg_lava_volcano.png.asset.json";
import bgAccumulatorShatter from "@/assets/bg_accumulator_shatter.png.asset.json";

import turtleAccumulator from "@/assets/turtle-accumulator-cutout.webp";
import turtleVanguard from "@/assets/turtle-vanguard-cutout.webp";
import turtleSniper from "@/assets/turtle-sniper-cutout.webp";
import turtleScout from "@/assets/turtle-scout-cutout.webp";
import turtleArbiter from "@/assets/turtle-arbiter-cutout.webp";
import turtleHunter from "@/assets/turtle-hunter-cutout.webp";

type World = { bg: string; turtle: string; name: string };

const WORLDS: World[] = [
  { bg: bgAccumulatorShatter.url, turtle: turtleAccumulator, name: "accumulator" },
  { bg: bgLavaVolcano.url, turtle: turtleVanguard, name: "vanguard" },
  { bg: bgPurpleAlley.url, turtle: turtleSniper, name: "sniper" },
  { bg: bgCaveWater.url, turtle: turtleScout, name: "scout" },
  { bg: bgServerRoom.url, turtle: turtleArbiter, name: "arbiter" },
  { bg: bgDesertPlanet.url, turtle: turtleHunter, name: "hunter" },
];

const TILE_VW = 60; // % of viewport width per world tile
const JOURNEY_SECONDS = 105;

export function BotWorldJourney() {
  const reduced = useReducedMotion();
  const tiles = useMemo(() => [...WORLDS, ...WORLDS], []);
  const totalWidthPct = tiles.length * TILE_VW;

  return (
    <div
      aria-hidden="true"
      data-testid="botline-world-journey"
      className="pointer-events-none absolute inset-0 overflow-hidden select-none"
      style={{ zIndex: 0 }}
    >
      <div
        data-testid="botline-world-strip"
        className={reduced ? undefined : "botline-world-journey-strip"}
        style={{
          position: "absolute",
          inset: 0,
          width: `${totalWidthPct}vw`,
          display: "flex",
          willChange: "transform",
          animationDuration: `${JOURNEY_SECONDS * 2}s`,
        }}
      >
        {tiles.map((w, i) => (
          <div
            key={`${w.name}-${i}`}
            style={{
              width: `${TILE_VW}vw`,
              height: "100%",
              flex: "0 0 auto",
              position: "relative",
              WebkitMaskImage:
                "linear-gradient(to right, transparent 0%, #000 12%, #000 88%, transparent 100%)",
              maskImage:
                "linear-gradient(to right, transparent 0%, #000 12%, #000 88%, transparent 100%)",
            }}
          >
            {/* Environment background */}
            <div
              style={{
                position: "absolute",
                inset: 0,
                backgroundImage: `url("${w.bg}")`,
                backgroundSize: "cover",
                backgroundPosition: "center",
                backgroundRepeat: "no-repeat",
                opacity: 0.85,
              }}
            />
            {/* Turtle standing in the world */}
            <img
              src={w.turtle}
              alt=""
              style={{
                position: "absolute",
                bottom: "4%",
                left: "50%",
                transform: "translateX(-50%)",
                height: "82%",
                width: "auto",
                objectFit: "contain",
                opacity: 0.95,
                filter: "drop-shadow(0 12px 24px rgba(0,0,0,0.55))",
                pointerEvents: "none",
              }}
            />
            <span
              style={{
                position: "absolute",
                left: "50%",
                bottom: "5%",
                transform: "translateX(-50%)",
                padding: "3px 8px",
                borderRadius: 999,
                background: "rgba(5,7,15,.58)",
                border: "1px solid rgba(255,255,255,.10)",
                color: "rgba(255,255,255,.70)",
                fontSize: 8,
                letterSpacing: ".16em",
                textTransform: "uppercase",
                whiteSpace: "nowrap",
              }}
            >
              {w.name}
            </span>
          </div>
        ))}
      </div>

      {/* Readability scrim — keeps the chart line legible over the art. */}
      <div
        data-testid="botline-world-scrim"
        style={{ position: "absolute", inset: 0, background: "rgba(0,0,0,0.2)" }}
      />
      <div
        style={{
          position: "absolute",
          inset: 0,
          background:
            "linear-gradient(to bottom, rgba(0,0,0,0.4) 0%, rgba(0,0,0,0) 22%, rgba(0,0,0,0) 78%, rgba(0,0,0,0.4) 100%)",
        }}
      />
    </div>
  );
}
