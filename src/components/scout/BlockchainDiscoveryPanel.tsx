import { useId, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { ExternalLink, Radar } from "lucide-react";
import { CommandPanel } from "@/components/command/CommandPanel";
import { tokenSwapLink } from "@/lib/blockchain/tokenSelection";
import { supabase } from "@/integrations/supabase/client";
import { discoverPools } from "@/lib/scout/discovery.functions";
import {
  DISCOVERY_CHAINS,
  discoveryRequestSchema,
  filterDiscovery,
  type DiscoveryPair,
  type DiscoveryRequest,
} from "@/lib/scout/discovery";

const money = (n: number | null) =>
  n === null
    ? "Unknown"
    : new Intl.NumberFormat("en-US", {
        style: "currency",
        currency: "USD",
        maximumSignificantDigits: 5,
      }).format(n);
const inputClass =
  "tb-neu-inset w-full rounded-xl border border-white/10 bg-[#11131b] px-3 py-2 text-sm text-white focus-visible:outline-cyan-300";
function PoolLogo({ pair }: { pair: DiscoveryPair }) {
  const [failed, setFailed] = useState(false);
  return (
    <span className="flex h-9 w-9 shrink-0 items-center justify-center overflow-hidden rounded-full bg-cyan-400/10 text-cyan-200 ring-1 ring-cyan-300/20">
      {pair.image && !failed ? (
        <img
          src={pair.image}
          alt=""
          loading="lazy"
          referrerPolicy="no-referrer"
          onError={() => setFailed(true)}
          className="h-full w-full rounded-full object-cover"
        />
      ) : (
        <Radar className="h-4 w-4" aria-hidden="true" />
      )}
    </span>
  );
}

/** On-demand market discovery, isolated from Scout's strategy activation switch. */
export function BlockchainDiscoveryPanel() {
  const id = useId();
  const [chain, setChain] = useState<DiscoveryRequest["chain"]>("base");
  const [query, setQuery] = useState("");
  const [liquidity, setLiquidity] = useState(0);
  const [volume, setVolume] = useState(0);
  const [ageHours, setAgeHours] = useState(0);
  const [sort, setSort] = useState<"liquidity" | "volume">("liquidity");
  const request = { chain, query: query.trim() };
  const key = JSON.stringify(request);
  const search = useMutation({
    mutationFn: async (input: DiscoveryRequest) => {
      const { data } = await supabase.auth.getSession();
      if (!data.session) throw new Error("Sign in to search blockchain pools.");
      const result = await discoverPools({
        data: input,
        headers: { Authorization: `Bearer ${data.session.access_token}` },
      });
      return { key: JSON.stringify(input), result };
    },
  });
  const result = search.data?.key === key ? search.data.result : null;
  const pairs = result
    ? filterDiscovery(result.pairs, { liquidity, volume, ageHours, sort }, result.fetchedAt)
    : [];
  function resetSearch() {
    search.reset();
  }
  return (
    <div id="blockchain-discovery" className="scroll-mt-24">
      <CommandPanel
        title="Blockchain discovery"
        tone="data"
        subtitle="DEX Screener · on-demand pool research · no account or API key required"
      >
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (discoveryRequestSchema.safeParse(request).success) search.mutate(request);
          }}
          className="grid items-end gap-3 sm:grid-cols-[150px_minmax(0,1fr)_auto]"
        >
          <label htmlFor={`${id}-chain`} className="space-y-1 text-xs text-white/70">
            <span>Blockchain</span>
            <select
              id={`${id}-chain`}
              value={chain}
              onChange={(e) => {
                setChain(e.target.value as typeof chain);
                resetSearch();
              }}
              className={inputClass}
            >
              {Object.entries(DISCOVERY_CHAINS).map(([value, name]) => (
                <option key={value} value={value}>
                  {name}
                </option>
              ))}
            </select>
          </label>
          <label htmlFor={`${id}-query`} className="space-y-1 text-xs text-white/70">
            <span>Token contract address or search</span>
            <input
              id={`${id}-query`}
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                resetSearch();
              }}
              maxLength={100}
              placeholder="Paste a token address, or search a name / symbol"
              className={inputClass}
              autoComplete="off"
            />
          </label>
          <button
            type="submit"
            disabled={search.isPending || !discoveryRequestSchema.safeParse(request).success}
            className="tb-neu-raised rounded-full px-5 py-2 text-sm text-cyan-200 disabled:opacity-40"
          >
            {search.isPending ? "Searching…" : "Find pools"}
          </button>
        </form>
        <div className="mt-3 grid grid-cols-2 gap-3 lg:grid-cols-4">
          <label htmlFor={`${id}-liquidity`} className="space-y-1 text-xs text-white/60">
            <span>Minimum liquidity</span>
            <select
              id={`${id}-liquidity`}
              value={liquidity}
              onChange={(e) => setLiquidity(Number(e.target.value))}
              className={inputClass}
            >
              <option value={0}>All reported / unknown</option>
              {[10000, 50000, 100000, 1000000].map((n) => (
                <option key={n} value={n}>
                  {money(n)}
                </option>
              ))}
            </select>
          </label>
          <label htmlFor={`${id}-volume`} className="space-y-1 text-xs text-white/60">
            <span>Minimum 24h volume</span>
            <select
              id={`${id}-volume`}
              value={volume}
              onChange={(e) => setVolume(Number(e.target.value))}
              className={inputClass}
            >
              <option value={0}>All reported / unknown</option>
              {[10000, 100000, 1000000].map((n) => (
                <option key={n} value={n}>
                  {money(n)}
                </option>
              ))}
            </select>
          </label>
          <label htmlFor={`${id}-age`} className="space-y-1 text-xs text-white/60">
            <span>Minimum pool age</span>
            <select
              id={`${id}-age`}
              value={ageHours}
              onChange={(e) => setAgeHours(Number(e.target.value))}
              className={inputClass}
            >
              <option value={0}>Any / unknown</option>
              <option value={24}>1 day</option>
              <option value={168}>7 days</option>
              <option value={720}>30 days</option>
            </select>
          </label>
          <label htmlFor={`${id}-sort`} className="space-y-1 text-xs text-white/60">
            <span>Order results by</span>
            <select
              id={`${id}-sort`}
              value={sort}
              onChange={(e) => setSort(e.target.value as typeof sort)}
              className={inputClass}
            >
              <option value="liquidity">Liquidity</option>
              <option value="volume">24h volume</option>
            </select>
          </label>
        </div>
        <p className="mt-3 text-xs leading-5 text-white/55">
          Symbols and logos can be copied by unrelated tokens. Verify the chain and contract. Paid
          boosts do not influence this ranking. Robinhood Chain coverage has not been verified.
        </p>
        <div aria-live="polite" aria-busy={search.isPending} className="mt-3">
          {search.isError && (
            <p role="alert" className="rounded-xl bg-rose-400/10 p-3 text-sm text-rose-200">
              {search.error.message}
            </p>
          )}
          {!result && !search.isPending && !search.isError && (
            <p className="tb-neu-inset rounded-xl p-4 text-sm text-white/60">
              Search a token to compare pools. Contract-address searches avoid ambiguous symbols.
            </p>
          )}
          {result && (
            <>
              <p className="mb-3 text-xs text-cyan-200/80">
                {pairs.length} of {result.pairs.length} returned pools · fetched{" "}
                {new Date(result.fetchedAt).toLocaleString()} · cached up to 30s, not streaming
              </p>
              {pairs.length === 0 && (
                <p className="tb-neu-inset rounded-xl p-4 text-sm text-white/60">
                  No returned pools match this chain and these filters. Try the token contract
                  address or adjust filters. Search results are not a complete market listing.
                </p>
              )}
              <div className="grid gap-3 lg:grid-cols-2">
                {pairs.slice(0, 30).map((pair) => (
                  <article
                    key={pair.id}
                    className="tb-neu-inset min-w-0 rounded-2xl border border-white/5 p-3"
                  >
                    <div className="flex items-center gap-3">
                      <PoolLogo pair={pair} />
                      <div className="min-w-0 flex-1">
                        <h3 className="truncate text-sm font-semibold">
                          {pair.base.symbol || "Unknown token"} /{" "}
                          {pair.quote.symbol || "Unknown quote"}
                        </h3>
                        <p className="truncate text-xs text-cyan-200/70">
                          {DISCOVERY_CHAINS[pair.chain]} · {pair.dex}
                        </p>
                      </div>
                      <a
                        href={pair.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="rounded-full p-2 text-cyan-200"
                        aria-label={`Open ${pair.base.symbol} pool on DEX Screener`}
                      >
                        <ExternalLink className="h-4 w-4" />
                      </a>
                    </div>
                    <dl className="mt-3 grid grid-cols-3 gap-2 text-xs">
                      {[
                        ["Price", money(pair.price)],
                        ["Liquidity", money(pair.liquidity)],
                        ["Volume · 24h", money(pair.volume)],
                        [
                          "Change · 24h",
                          pair.change === null
                            ? "Unknown"
                            : `${pair.change > 0 ? "+" : ""}${pair.change.toFixed(2)}%`,
                        ],
                        ["Buys / sells · 24h", `${pair.buys ?? "?"} / ${pair.sells ?? "?"}`],
                        [
                          "Pool age",
                          pair.createdAt === null
                            ? "Unknown"
                            : `${Math.floor((result.fetchedAt - pair.createdAt) / 3_600_000)}h`,
                        ],
                      ].map(([name, value]) => (
                        <div key={name}>
                          <dt className="text-white/45">{name}</dt>
                          <dd
                            className={`mt-1 tabular-nums ${name === "Change · 24h" && pair.change !== null ? (pair.change < 0 ? "text-rose-300" : "text-emerald-300") : "text-white/90"}`}
                          >
                            {value}
                          </dd>
                        </div>
                      ))}
                    </dl>
                    <details className="mt-3 text-xs text-white/60">
                      <summary className="cursor-pointer text-cyan-200">
                        Contract &amp; pool identity
                      </summary>
                      <dl className="mt-2 space-y-2 break-all">
                        {[
                          ["Base token", pair.base.address],
                          ["Quote token", pair.quote.address],
                          ["Pool", pair.address],
                        ].map(([name, value]) => (
                          <div key={name}>
                            <dt>{name}</dt>
                            <dd className="select-all font-mono text-white/80">{value}</dd>
                          </div>
                        ))}
                      </dl>
                    </details>
                    <p className="mt-3 text-[11px] text-amber-200/80">
                      Contract safety and sellability not checked · not a trade signal
                    </p>
                    {tokenSwapLink(pair.chain, pair.base.address) ? (
                      <a
                        href={tokenSwapLink(pair.chain, pair.base.address)!}
                        className="tb-neu-raised mt-3 inline-flex min-h-11 items-center rounded-full px-3 text-xs text-cyan-200"
                      >
                        Review {pair.base.symbol || "token"} swap route
                      </a>
                    ) : (
                      <p className="mt-3 text-xs text-white/50">
                        Discovery only · swap execution not available on this chain.
                      </p>
                    )}
                  </article>
                ))}
              </div>
              {pairs.length > 30 && (
                <p className="mt-2 text-xs text-white/50">
                  Showing the first 30 pools. Narrow the filters to explore the remaining results.
                </p>
              )}
            </>
          )}
        </div>
        <p className="mt-3 text-xs leading-5 text-white/45">
          Discovery does not approve tokens, activate strategies or submit swaps. Execution needs
          its own verified route, wallet authorization and receipt tracking.
        </p>
      </CommandPanel>
    </div>
  );
}
