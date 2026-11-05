import { Link } from "@tanstack/react-router";
import { ScoutRingAvatar } from "./ScoutRingAvatar";
import { useScoutActivation } from "@/hooks/useScoutActivation";
import scoutAsset from "@/assets/characters/scout.webp.asset.json";
import onyxAsset from "@/assets/onyx-head.png.asset.json";

/**
 * CommandAvatars — Onyx + Scout side-by-side on the Home page.
 * Scout appears only when activated. Both render as circular Kalshi-style
 * avatars in Onixus violet/blue. Scout's ring spins while reconnaissance is active.
 */
export function CommandAvatars({ size = 88 }: { size?: number }) {
  const { active } = useScoutActivation();

  return (
    <div className="flex items-end gap-4">
      <div className="flex flex-col items-center gap-1.5">
        <ScoutRingAvatar src={onyxAsset.url} alt="Onyx" size={size} active={true} />
        <div className="text-center">
          <p className="font-display text-[11px] font-semibold uppercase tracking-[0.18em] text-white">
            Onyx
          </p>
          <p className="font-mono text-[9.5px] uppercase tracking-[0.14em] text-white/45">
            Commander
          </p>
        </div>
      </div>

      {active && (
        <Link to="/scout" className="group flex flex-col items-center gap-1.5 focus:outline-none">
          <ScoutRingAvatar
            src={scoutAsset.url}
            alt="Scout"
            size={size}
            active={true}
            className="transition-transform group-hover:scale-105"
          />
          <div className="text-center">
            <p className="font-display text-[11px] font-semibold uppercase tracking-[0.18em] text-white">
              Scout
            </p>
            <p className="font-mono text-[9.5px] uppercase tracking-[0.14em] text-[#22D3EE]">
              Recon · Scanning
            </p>
          </div>
        </Link>
      )}
    </div>
  );
}
