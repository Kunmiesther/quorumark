/**
 * ActivationStrip — the switches customers MUST turn on to earn from Life Map.
 *
 * Status pills come from `useTurtleStates` (single source of truth), so
 * this surface and the Intelligence Hub always agree on a turtle's state.
 * - Scout uses `useScoutActivation` (server-persisted preference).
 * - Each strategy uses `useStrategyEnabled(strategy_key)` — writes to
 *   `user_strategy_toggles` so the paper engine picks up the change.
 */
import { STRATEGIES, SCOUT_META, type TurtleStrategyWithArt } from "@/lib/lifemap/catalog";
import { useScoutActivation } from "@/hooks/useScoutActivation";
import { useStrategyEnabled } from "@/hooks/useStrategyEnabled";
import { useTurtleStates, type TurtleStatus, type TurtleKey } from "@/hooks/useTurtleStates";

const STATUS_LABEL: Record<TurtleStatus, string> = {
  armed: "Armed",
  watching: "Watching",
  "in-position": "In position",
  "locked-out": "Locked-out",
  benched: "Benched",
};

function statusOf(states: ReturnType<typeof useTurtleStates>["data"], key: string): TurtleStatus | null {
  const row = states?.find((s) => s.key === (key as TurtleKey));
  return row?.status ?? null;
}

export function ActivationStrip() {
  const scout = useScoutActivation();
  const { data: states } = useTurtleStates();
  return (
    <section className="rounded-3xl bg-white/[0.04] p-5">
      <div className="mb-4 flex items-baseline justify-between">
        <h2 className="text-[13px] font-semibold text-white">Turn on your engine</h2>
        <p className="type-eyebrow text-white/40">
          Bots only trade what you switch on
        </p>
      </div>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <SwitchTile
          label={SCOUT_META.label}
          blurb={SCOUT_META.blurb}
          accent={SCOUT_META.accent}
          checked={scout.active}
          disabled={scout.loading || scout.saving || scout.unauthenticated}
          onChange={(next) => scout.setActive(next)}
          image={SCOUT_META.image}
          badge="Recon"
          status={statusOf(states, "scout")}
        />
        {STRATEGIES.map((s) => (
          <StrategyTile key={s.key} strategy={s} status={statusOf(states, s.key)} />
        ))}
      </div>
    </section>
  );
}

function StrategyTile({
  strategy,
  status,
}: {
  strategy: TurtleStrategyWithArt;
  status: TurtleStatus | null;
}) {
  const toggle = useStrategyEnabled(strategy.key);
  return (
    <SwitchTile
      label={strategy.label}
      blurb={strategy.blurb}
      accent={strategy.accent}
      checked={!!toggle.enabled}
      disabled={toggle.isLoading || toggle.isSaving}
      onChange={(next) => void toggle.setEnabled(next)}
      image={strategy.image}
      badge="Bot"
      status={status}
    />
  );
}

function SwitchTile({
  label,
  blurb,
  accent,
  checked,
  disabled,
  onChange,
  image,
  badge,
  status,
}: {
  label: string;
  blurb: string;
  accent: string;
  checked: boolean;
  disabled: boolean;
  onChange: (next: boolean) => void;
  image?: string;
  badge: string;
  status?: TurtleStatus | null;
}) {
  const statusTone =
    status === "in-position"
      ? "text-[color:var(--positive)] border-[color:var(--positive)]/40"
      : status === "armed"
        ? "text-[color:var(--accent)] border-[color:var(--accent)]/40"
        : status === "locked-out"
          ? "text-amber-300 border-amber-400/40"
          : status === "benched"
            ? "text-white/40 border-white/10"
            : "text-white/55 border-white/10";
  return (
    <div
      className="relative flex min-h-[132px] items-start gap-3 overflow-hidden rounded-2xl bg-black/50 p-4 ring-1 ring-white/5 transition"
      style={{
        boxShadow: checked
          ? `inset 0 0 0 1px ${accent}66, 0 0 32px -12px ${accent}`
          : undefined,
      }}
    >
      {/* Accent wash */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0"
        style={{
          background: `radial-gradient(120% 80% at 100% 100%, ${accent}22 0%, transparent 60%)`,
          opacity: checked ? 1 : 0.5,
        }}
      />

      {/* Bleeding turtle portrait */}
      {image && (
        <img
          src={image}
          alt=""
          aria-hidden
          className="pointer-events-none absolute -bottom-4 -right-3 h-[120px] w-[120px] object-contain drop-shadow-[0_10px_20px_rgba(0,0,0,0.5)] transition"
          style={{
            opacity: checked ? 0.95 : 0.55,
            filter: checked ? "none" : "grayscale(30%)",
          }}
        />
      )}

      <div className="relative z-10 flex min-w-0 flex-1 flex-col">
        <div className="flex items-center gap-2">
          <span
            className="text-[9px] uppercase tracking-widest"
            style={{ color: accent }}
          >
            {badge}
          </span>
          <span
            className="h-1 w-1 rounded-full"
            style={{ background: accent, boxShadow: `0 0 6px ${accent}` }}
          />
          {status && (
            <span
              className={`ml-auto rounded-full border px-1.5 py-[1px] font-mono text-[8.5px] uppercase tracking-[0.14em] ${statusTone}`}
            >
              {STATUS_LABEL[status]}
            </span>
          )}
        </div>
        <p className="mt-1 text-[15px] font-semibold text-white">{label}</p>
        <p className="mt-1 max-w-[70%] text-[11px] leading-snug text-white/60">
          {blurb}
        </p>
      </div>

      <button
        type="button"
        role="switch"
        aria-checked={checked}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className="relative z-10 h-5 w-9 shrink-0 rounded-full transition disabled:opacity-50"
        style={{ background: checked ? accent : "rgba(255,255,255,0.15)" }}
      >
        <span
          className="absolute top-0.5 h-4 w-4 rounded-full bg-white shadow transition"
          style={{ left: checked ? "calc(100% - 18px)" : "2px" }}
        />
      </button>
    </div>
  );
}
