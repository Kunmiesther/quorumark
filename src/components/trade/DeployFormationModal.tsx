/**
 * DeployFormationModal — pre-submit confirmation for the manual DCA ladder.
 *
 * Displays every safety-relevant field the owner ruling requires: symbol,
 * direction, rung count, per-rung margin, TOTAL margin, effective leverage,
 * total notional, and the hard stop price.
 *
 * IMPORTANT: this modal is a PLAN PREVIEW ONLY. The Confirm button will not
 * submit orders in this build — atomic ladder submission with fail-closed
 * unwind on stop-attach failure is NOT wired end-to-end yet (see notice
 * below). The owner sees the full plan and can review, but nothing is sent
 * to the venue.
 */
import type { ManualLadderPlan } from "@/lib/manualLadderPlan";
import { EXECUTION_ENABLED } from "@/lib/app-env";

interface Props {
  open: boolean;
  plan: ManualLadderPlan | null;
  armed: boolean;
  onClose: () => void;
  onConfirm: () => void;
}

function fmtUsd(n: number): string {
  return n.toLocaleString(undefined, { style: "currency", currency: "USD", maximumFractionDigits: 2 });
}
function fmtPx(n: number): string {
  return n.toLocaleString(undefined, { maximumFractionDigits: 6 });
}

export function DeployFormationModal({ open, plan, armed, onClose, onConfirm }: Props) {
  if (!open || !plan) return null;
  // Even armed, the frontend leaves submit DISABLED because the server-side
  // atomic submit path is not wired in this build. This is honest.
  const canSubmit = armed && EXECUTION_ENABLED;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Deploy formation preview"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-lg rounded-xl border border-white/10 bg-[color:var(--surface-1)] p-5 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between">
          <h2 className="font-display text-[14px] font-bold uppercase tracking-[0.16em] text-white">
            Deploy Formation
          </h2>
          <span className="rounded-full bg-[color:var(--onixus-purple)]/20 px-2 py-0.5 text-[10px] font-bold uppercase tracking-[0.14em] text-[color:var(--onixus-purple)]">
            Manual DCA
          </span>
        </div>

        <dl className="mt-4 grid grid-cols-2 gap-y-1.5 text-[12px]">
          <Row k="Symbol" v={plan.symbol} />
          <Row k="Direction" v={plan.side === "BUY" ? "LONG" : "SHORT"} />
          <Row k="Rungs" v={String(plan.rungCount)} />
          <Row k="Leverage" v={`${plan.leverage}×`} />
          {/* Ruling #8 ADD1 — surface ACTUAL post-rounding totals. Intended
              (owner target) shown as a secondary line for transparency. */}
          <Row k="Actual total margin" v={fmtUsd(plan.totalMargin)} />
          <Row k="Actual total notional" v={fmtUsd(plan.totalNotional)} />
          <Row k="Intended margin (cap)" v={fmtUsd(plan.intendedTotalMargin)} />
          <Row k="Hard stop" v={`${fmtPx(plan.hardStopPrice)} (${plan.hardStopSide})`} />
        </dl>

        <div className="mt-4 max-h-56 overflow-y-auto rounded border border-white/10">
          <table className="w-full text-[11px]">
            <thead className="sticky top-0 bg-[color:var(--surface-2)] text-white/60">
              <tr>
                <th className="px-2 py-1 text-left">Rung</th>
                <th className="px-2 py-1 text-right">Limit price</th>
                <th className="px-2 py-1 text-right">Size</th>
                <th className="px-2 py-1 text-right">Margin (actual)</th>
                <th className="px-2 py-1 text-right">Notional (actual)</th>
              </tr>
            </thead>
            <tbody className="font-mono tabular-nums text-white/85">
              {plan.rungs.map((r) => (
                <tr key={r.index} className="border-t border-white/[0.05]">
                  <td className="px-2 py-1 text-left">R{r.index}</td>
                  <td className="px-2 py-1 text-right">{fmtPx(r.limitPrice)}</td>
                  <td className="px-2 py-1 text-right">{r.size.toLocaleString(undefined, { maximumFractionDigits: 6 })}</td>
                  <td className="px-2 py-1 text-right">{fmtUsd(r.marginUsd)}</td>
                  <td className="px-2 py-1 text-right">{fmtUsd(r.notionalUsd)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {!canSubmit && (
          <p className="mt-3 rounded border border-[color:var(--warning)]/50 bg-[color:var(--warning)]/10 p-2 text-[11px] text-[color:var(--warning)]">
            Preview only. Atomic ladder submission with fail-closed stop
            attach is not wired end-to-end in this build; nothing will be
            sent to the venue.
          </p>
        )}

        <div className="mt-5 flex justify-end gap-2">
          <button
            onClick={onClose}
            className="rounded border border-white/10 px-3 py-1.5 text-[12px] font-semibold text-white/70 hover:text-white"
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            disabled={!canSubmit}
            aria-disabled={!canSubmit}
            className={[
              "rounded px-4 py-1.5 text-[12px] font-bold uppercase tracking-[0.14em]",
              canSubmit
                ? "bg-[color:var(--onixus-purple)] text-white hover:brightness-110"
                : "cursor-not-allowed bg-white/[0.06] text-white/35",
            ].join(" ")}
          >
            Confirm Deploy
          </button>
        </div>
      </div>
    </div>
  );
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <>
      <dt className="text-white/55">{k}</dt>
      <dd className="text-right font-mono tabular-nums text-white">{v}</dd>
    </>
  );
}
