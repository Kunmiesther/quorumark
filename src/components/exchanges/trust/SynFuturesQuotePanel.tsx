import { useId, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { inspectSynFuturesQuote } from "@/lib/exchanges/synfutures.functions";
import { PairBadge } from "@/components/trade/PairBadge";

export function SynFuturesQuotePanel({
  markets,
}: {
  markets: Array<{ instrument: string; symbol: string; expiries: readonly number[] }>;
}) {
  const id = useId();
  const [selected, setSelected] = useState("");
  const [side, setSide] = useState<"long" | "short">("long");
  const [notional, setNotional] = useState("100");
  const options = markets.flatMap((market) =>
    market.expiries.map((expiry) => ({
      ...market,
      expiry,
      key: `${market.instrument}:${expiry}`,
    })),
  );
  const market = options.find((option) => option.key === selected);
  const quote = useMutation({
    mutationFn: async (input: {
      instrument: string;
      expiry: number;
      side: "long" | "short";
      notional: string;
    }) => {
      const { data } = await supabase.auth.getSession();
      if (!data.session) throw new Error("Sign in to request a quote.");
      return inspectSynFuturesQuote({
        data: input,
        headers: { Authorization: `Bearer ${data.session.access_token}` },
      });
    },
  });
  const result =
    market &&
    quote.data?.instrument === market.instrument &&
    quote.data.expiry === market.expiry &&
    quote.data.side === side &&
    quote.data.requested_notional === notional
      ? quote.data
      : null;
  return (
    <section
      className="mt-4 rounded-xl border border-violet-300/15 p-3"
      aria-label="SynFutures market quote"
    >
      <h3 className="text-sm font-medium text-violet-200">Preview a SynFutures market</h3>
      <p className="my-2 text-xs leading-5 text-white/55">
        Live contract quote, not a paper fill or an order. Values use the selected market’s quote
        token, not necessarily USD.
      </p>
      <div className="grid gap-2 sm:grid-cols-2">
        <label htmlFor={`${id}-market`} className="text-xs text-white/65">
          Market / expiry
          <select
            id={`${id}-market`}
            value={market?.key ?? ""}
            onChange={(event) => {
              setSelected(event.target.value);
              quote.reset();
            }}
            className="tb-neu-inset mt-1 w-full rounded-lg bg-[#101118] p-2 text-white"
          >
            <option value="">Choose a discovered market</option>
            {options.map((item) => (
              <option key={item.key} value={item.key}>
                {item.symbol} ·{" "}
                {item.expiry === 4294967295
                  ? "Perpetual"
                  : new Date(item.expiry * 1000).toISOString().slice(0, 10)}
              </option>
            ))}
          </select>
        </label>
        <label htmlFor={`${id}-side`} className="text-xs text-white/65">
          Direction
          <select
            id={`${id}-side`}
            value={side}
            onChange={(event) => {
              setSide(event.target.value as "long" | "short");
              quote.reset();
            }}
            className="tb-neu-inset mt-1 w-full rounded-lg bg-[#101118] p-2 text-white"
          >
            <option value="long">Long</option>
            <option value="short">Short</option>
          </select>
        </label>
        <label htmlFor={`${id}-notional`} className="text-xs text-white/65">
          Notional (quote-token units)
          <input
            id={`${id}-notional`}
            inputMode="decimal"
            value={notional}
            maxLength={32}
            onChange={(event) => {
              setNotional(event.target.value);
              quote.reset();
            }}
            className="tb-neu-inset mt-1 w-full rounded-lg bg-[#101118] p-2 text-white"
          />
        </label>
        <button
          type="button"
          disabled={
            !market ||
            !/^(?:0|[1-9]\d{0,11})(?:\.\d{1,18})?$/.test(notional) ||
            Number(notional) <= 0 ||
            quote.isPending
          }
          onClick={() =>
            market &&
            quote.mutate({ instrument: market.instrument, expiry: market.expiry, side, notional })
          }
          className="tb-neu-raised self-end rounded-xl px-3 py-2 text-xs text-violet-200 disabled:opacity-40"
        >
          {quote.isPending ? "Reading quote…" : "Get on-chain quote"}
        </button>
      </div>
      {quote.isError ? (
        <p role="alert" className="mt-2 text-xs text-amber-200">
          Quote unavailable. The amount may exceed liquidity, or the contract read failed. No order
          was sent.
        </p>
      ) : null}
      {result && !quote.isError ? (
        <div aria-live="polite" className="mt-3 space-y-2 text-xs text-white/70">
          <PairBadge symbol={result.symbol} />
          <dl className="grid grid-cols-2 gap-2">
            {[
              ["Base size", result.base_size],
              ["Average entry", result.average_entry],
              ["Mark price", result.mark_price],
              ["Entry notional", result.entry_notional],
              ["Quoted fee", result.fee],
            ].map(([label, value]) => (
              <div key={label} className="tb-neu-inset min-w-0 rounded-lg p-2">
                <dt className="text-white/45">{label}</dt>
                <dd className="mt-1 break-all font-mono text-cyan-100">{value}</dd>
              </div>
            ))}
          </dl>
          <p className="break-all">Quote token: {result.quote_token}</p>
          <p className="text-amber-100/70">{result.note}</p>
          <p className="text-white/45">
            Read {new Date(result.checked_at).toLocaleString()} · prices can change
          </p>
        </div>
      ) : null}
    </section>
  );
}
