import { ScoutRingAvatar } from "./ScoutRingAvatar";
import { useScoutActivation } from "@/hooks/useScoutActivation";
import { openScout } from "./ScoutPanel";
import scoutAsset from "@/assets/characters/scout.webp.asset.json";
import { cn } from "@/lib/utils";

/**
 * ScoutFab — small circular Scout avatar rendered above the Onyx head on
 * the tablet rail and mobile FAB stack. Always visible (parity with Onyx);
 * the panel itself surfaces activation controls. Tapping opens the global
 * ScoutPanel — no route change.
 */
export function ScoutFab({ compact = false }: { compact?: boolean }) {
  const { active } = useScoutActivation();
  const size = compact ? 44 : 52;
  return (
    <button
      type="button"
      onClick={() => openScout()}
      aria-label="Open Scout"
      title="Scout"
      className={cn(
        "group relative flex items-center justify-center rounded-full transition hover:scale-105 focus:outline-none focus-visible:ring-2 focus-visible:ring-[#22D3EE]",
      )}
    >
      <ScoutRingAvatar src={scoutAsset.url} alt="Scout" size={size} active={active} />
    </button>
  );
}
