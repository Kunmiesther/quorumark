import { LockKeyhole, ShieldCheck, WalletCards } from "lucide-react";

const protections = [
  { icon: WalletCards, label: "Funds stay at your exchange" },
  { icon: LockKeyhole, label: "TurtleBot never withdraws" },
  { icon: ShieldCheck, label: "Owner confirmation before Live" },
] as const;

export function SafetySummary({ className = "" }: { className?: string }) {
  return (
    <aside
      className={`tb-neu-inset rounded-[24px] p-3 ${className}`}
      aria-label="TurtleBot safety summary"
    >
      <p className="px-1 text-[9px] font-semibold uppercase tracking-[0.18em] text-emerald-300/75">
        Your safety controls
      </p>
      <div className="mt-2 grid gap-2 sm:grid-cols-3">
        {protections.map(({ icon: Icon, label }) => (
          <div
            key={label}
            className="flex items-center gap-2 rounded-2xl px-2 py-2 text-[11px] text-white/55"
          >
            <Icon className="h-4 w-4 shrink-0 text-emerald-300" />
            <span>{label}</span>
          </div>
        ))}
      </div>
    </aside>
  );
}
