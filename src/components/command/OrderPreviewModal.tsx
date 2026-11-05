import { EXECUTION_ENABLED } from "@/lib/app-env";
import { ApexOmniLogo } from "@/components/brand/ApexOmniLogo";

export interface OrderPreview {
  venue: string;              // e.g. "ApeX Omni"
  network: "testnet" | "mainnet";
  market: string;             // e.g. "BTC-USDT"
  side: "long" | "short";
  orderType: string;          // e.g. "MARKET" | "LIMIT"
  size: string;               // human-formatted, e.g. "0.001 BTC"
  leverage?: string;          // e.g. "5x"
  marginRequired?: string;    // e.g. "≈ $6.30 USDT"
  estimatedEntry?: string;    // e.g. "$63,000"
  markPrice?: string;         // e.g. "$62,998" — required for mainnet MARKET
  protectedPrice?: string;    // worst-price boundary for MARKET orders (mainnet)
  slippageEstimate?: string;  // e.g. "12 bps" or "$7.55"
  maxFee?: string;            // upper bound fee, mainnet
  orderExpiresAt?: string;    // ISO string or humanized time
  estimatedFee?: string;      // e.g. "$0.03"
  estimatedLiquidation?: string; // e.g. "$55,000" or undefined when N/A
  maxExpectedLoss?: string;   // e.g. "≤ $2.10" when calculable
  stopLoss?: string;
  takeProfit?: string;
}


interface Props {
  open: boolean;
  preview: OrderPreview | null;
  onClose: () => void;
  onConfirm: () => void;
}

/**
 * Pre-trade preview modal. Shows every risk-relevant field the user must see
 * before submitting a real order.
 *
 * Phase A: renders and validates the shape, but the Confirm button is
 * DISABLED unless EXECUTION_ENABLED is true. Even when it is enabled, the
 * server-side proof gate remains the ultimate authority.
 */
export function OrderPreviewModal({ open, preview, onClose, onConfirm }: Props) {
  if (!open || !preview) return null;
  const isMainnet = preview.network === "mainnet";
  const submitBlocked = !EXECUTION_ENABLED;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Order preview"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-md rounded-lg border border-[color:var(--border)] bg-[color:var(--surface-1)] p-5 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between">
          {preview.venue.toLowerCase().includes("apex") ? (
            <ApexOmniLogo size="lg" />
          ) : (
            <p className="font-display text-[13px] font-bold uppercase tracking-[0.18em]">
              {preview.venue}
            </p>
          )}
          <span
            className={[
              "rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-[0.18em]",
              isMainnet
                ? "bg-[color:var(--danger-red)] text-white"
                : "bg-[color:var(--intel-cyan)] text-black",
            ].join(" ")}
          >
            {isMainnet ? "Live Mainnet" : "Testnet"}
          </span>
        </div>

        <dl className="mt-4 grid grid-cols-2 gap-y-2 text-[12px]">
          <Row k="Market" v={preview.market} />
          <Row k="Side" v={preview.side === "long" ? "LONG" : "SHORT"} />
          <Row k="Order type" v={preview.orderType} />
          <Row k="Size" v={preview.size} />
          {preview.leverage && <Row k="Leverage" v={preview.leverage} />}
          {preview.marginRequired && <Row k="Margin" v={preview.marginRequired} />}
          {preview.estimatedEntry && <Row k="Est. entry" v={preview.estimatedEntry} />}
          {preview.markPrice && <Row k="Mark price" v={preview.markPrice} />}
          {preview.protectedPrice && (
            <Row k={preview.side === "long" ? "Max buy price" : "Min sell price"} v={preview.protectedPrice} />
          )}
          {preview.slippageEstimate && <Row k="Est. slippage" v={preview.slippageEstimate} />}
          {preview.maxFee && <Row k="Max fee" v={preview.maxFee} />}
          {preview.estimatedFee && <Row k="Est. fees" v={preview.estimatedFee} />}
          {preview.estimatedLiquidation && (
            <Row k="Est. liquidation" v={preview.estimatedLiquidation} />
          )}
          {preview.maxExpectedLoss && <Row k="Max expected loss" v={preview.maxExpectedLoss} />}
          {preview.orderExpiresAt && <Row k="Order expires" v={preview.orderExpiresAt} />}
          {preview.stopLoss && <Row k="Stop-loss" v={preview.stopLoss} />}
          {preview.takeProfit && <Row k="Take-profit" v={preview.takeProfit} />}
        </dl>

        {isMainnet && (
          <p className="mt-3 rounded border border-[color:var(--danger-red)]/40 bg-[color:var(--danger-red)]/10 p-2 text-[11px] text-[color:var(--danger-red)]">
            Live mainnet. Real funds. Review every field above before confirming.
          </p>
        )}

        {submitBlocked && (
          <p className="mt-3 rounded border border-[color:var(--warn-amber)] bg-[color:var(--warn-amber)]/10 p-2 text-[11px] text-[color:var(--warn-amber)]">
            Execution disabled — the L2 signer is not yet available for
            mainnet in this build. Order will not be submitted.
          </p>
        )}


        <div className="mt-5 flex justify-end gap-2">
          <button
            onClick={onClose}
            className="rounded border border-[color:var(--border)] px-3 py-1.5 text-[12px] font-semibold text-[color:var(--text-secondary)] hover:text-[color:var(--text-primary)]"
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            disabled={submitBlocked}
            className={[
              "rounded px-3 py-1.5 text-[12px] font-bold uppercase tracking-[0.14em]",
              submitBlocked
                ? "cursor-not-allowed bg-[color:var(--surface-2)] text-[color:var(--text-secondary)]"
                : isMainnet
                  ? "bg-[color:var(--danger-red)] text-white"
                  : "bg-[color:var(--intel-cyan)] text-black",
            ].join(" ")}
          >
            {isMainnet ? "Confirm Live Trade" : "Confirm Testnet Trade"}
          </button>
        </div>
      </div>
    </div>
  );
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <>
      <dt className="text-[color:var(--text-secondary)]">{k}</dt>
      <dd className="text-right font-mono text-[color:var(--text-primary)]">{v}</dd>
    </>
  );
}
