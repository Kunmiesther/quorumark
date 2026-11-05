import { formatPrice, formatSize } from "@/lib/formatPrice";
import type { PositionProtection, ProtectionLevel } from "@/lib/live/positionProtection";

function Level({ label, level }: { label: string; level: ProtectionLevel }) {
  return (
    <div title={`Venue order ${level.id}`}>
      {label} {formatPrice(level.price)}
      <span className="ml-1 text-[10px] text-white/55">
        {level.closePosition
          ? "· close position"
          : level.quantity !== null
            ? `· ${formatSize(level.quantity)} units`
            : "· size unavailable"}
      </span>
    </div>
  );
}

export function PositionProtectionReadout({
  protection,
  botTarget,
  syncedAt,
}: {
  protection: PositionProtection;
  botTarget?: number | null;
  syncedAt?: string | null;
}) {
  return (
    <div className="space-y-1 font-mono text-xs" data-testid="venue-protection-readout">
      <div className="text-emerald-300">
        {protection.takeProfits.length ? (
          protection.takeProfits.map((level, i) => (
            <Level
              key={level.id}
              label={protection.takeProfits.length > 1 ? `TP${i + 1}` : "TP"}
              level={level}
            />
          ))
        ) : (
          <span className="text-white/50">TP not visible at venue</span>
        )}
      </div>
      <div className="text-amber-200">
        {protection.stops.length ? (
          protection.stops.map((level, i) => (
            <Level
              key={level.id}
              label={protection.stops.length > 1 ? `SL${i + 1}` : "SL"}
              level={level}
            />
          ))
        ) : (
          <span className="text-rose-300">SL not visible at venue</span>
        )}
      </div>
      {!protection.takeProfits.length && botTarget != null && botTarget > 0 && (
        <div className="text-[10px] text-white/50">
          Bot target {formatPrice(botTarget)} · not order proof
        </div>
      )}
      <div className="text-[9px] text-white/40" title={syncedAt ?? undefined}>
        Last venue snapshot
        {syncedAt ? ` · ${new Date(syncedAt).toLocaleTimeString()}` : " · time unavailable"}
      </div>
    </div>
  );
}
