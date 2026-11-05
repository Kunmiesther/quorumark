/**
 * OnixusShowcase — "From Onixus" house-promo board on the home dashboard.
 * Replaces the legacy RWA placeholder. Content is config-driven; edit
 * `src/lib/promos/onixusPromos.ts` to change entries.
 *
 * Design contract: same glass surface + type tokens as the rest of the home
 * route. No fake metrics, no testimonials — one tagline per card.
 */
import { getVisiblePromos, type OnixusPromo } from "@/lib/promos/onixusPromos";
import { ArrowUpRight } from "lucide-react";

const BADGE_STYLE: Record<NonNullable<OnixusPromo["badge"]>, string> = {
  LIVE: "text-emerald-300 border-emerald-400/30 bg-emerald-400/10",
  BETA: "text-violet-300 border-violet-400/30 bg-violet-400/10",
  NEW: "text-cyan-300 border-cyan-400/30 bg-cyan-400/10",
};

export function OnixusShowcase() {
  const promos = getVisiblePromos();

  if (promos.length === 0) return null;

  return (
    <section aria-labelledby="onixus-showcase-heading">
      <div className="flex items-baseline justify-between">
        <p
          id="onixus-showcase-heading"
          className="text-[11px] font-semibold uppercase tracking-[0.18em] text-white/50"
        >
          From the Onixus Lab
        </p>
      </div>

      <div className="mt-2.5">
        <ul className="grid gap-2 sm:grid-cols-2 lg:grid-cols-1 xl:grid-cols-2">
          {promos.map((p) => (
            <li key={p.id}>
              <PromoCard promo={p} />
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}

function PromoCard({ promo }: { promo: OnixusPromo }) {
  return (
    <a
      href={promo.url}
      target="_blank"
      rel="noopener noreferrer"
      className="group relative flex min-h-[92px] overflow-hidden rounded-[18px] bg-white/[0.05] transition hover:-translate-y-0.5 hover:bg-white/[0.09] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300/60"
      style={{
        boxShadow: `inset 0 0 0 1px rgba(255,255,255,0.04)`,
      }}
    >
      {/* accent top edge */}
      <span
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 z-10 h-[2px] opacity-70"
        style={{
          background: `linear-gradient(90deg, transparent, ${promo.accent}, transparent)`,
        }}
      />

      {promo.image ? (
        <div className="relative w-[66px] shrink-0 overflow-hidden bg-black/40">
          <img
            src={promo.image}
            alt=""
            loading="lazy"
            referrerPolicy="no-referrer"
            className="h-full w-full object-cover transition duration-500 group-hover:scale-[1.05]"
          />
          <span
            aria-hidden
            className="pointer-events-none absolute inset-0"
            style={{
              background: `linear-gradient(90deg, transparent 35%, rgba(10,10,20,0.92) 100%), radial-gradient(120% 100% at 0% 0%, ${promo.accent}33, transparent 60%)`,
            }}
          />
        </div>
      ) : null}

      <div className="relative flex min-w-0 flex-1 flex-col justify-between p-3">
        {/* accent hover glow (fallback for image-less cards) */}
        <span
          aria-hidden
          className="pointer-events-none absolute inset-0 opacity-0 transition-opacity duration-300 group-hover:opacity-100"
          style={{
            background: `radial-gradient(120% 80% at 0% 0%, ${promo.accent}22, transparent 60%)`,
          }}
        />

        <div className="relative flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p
              className="truncate text-[13px] font-semibold text-white"
              style={{ letterSpacing: "-0.01em" }}
            >
              {promo.name}
            </p>
            <p className="mt-0.5 line-clamp-2 text-[11px] leading-snug text-white/60">
              {promo.tagline}
            </p>
          </div>
          <span className="tb-neu-raised inline-flex shrink-0 items-center gap-1.5 rounded-full px-2.5 py-1.5 text-[9px] font-semibold uppercase tracking-[0.12em] text-white/75">
            {promo.logo ? (
              <img
                src={promo.logo}
                alt=""
                loading="lazy"
                referrerPolicy="no-referrer"
                className="h-4 w-4 rounded-full object-contain"
              />
            ) : null}
            Visit
            <ArrowUpRight className="h-3 w-3 text-white/60 transition group-hover:text-white" />
          </span>
        </div>

        <div className="relative mt-2 flex items-center justify-between">
          {promo.badge ? (
            <span
              className={`inline-flex items-center rounded-full border px-1.5 py-px text-[8.5px] font-semibold uppercase tracking-[0.14em] ${BADGE_STYLE[promo.badge]}`}
            >
              {promo.badge}
            </span>
          ) : (
            <span />
          )}
          <span className="text-[9px] text-white/35">
            {new URL(promo.url).hostname.replace(/^www\./, "")}
          </span>
        </div>
      </div>
    </a>
  );
}
