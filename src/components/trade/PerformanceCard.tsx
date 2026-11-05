/**
 * PerformanceCard — Trade intelligence card.
 *
 * Sections come from `sections[]` and can render in two shapes:
 *  - Grid of stats (default): compact KPI grid (Overall, Streaks, Best/Worst).
 *  - Rank rows (`rows[]`): table-style rank list (By Strategy, By Symbol).
 *
 * The card never recomputes stats. Callers pass pre-aggregated numbers from
 * the shared `buildPerformanceSections()` helper.
 */
import type { ReactNode } from "react";
import { SurfaceCard } from "@/components/phantom/SurfaceCard";

export type PerformanceTone = "pos" | "neg" | "accent" | "neutral";

export interface PerformanceStat {
  label: string;
  value: string;
  tone?: PerformanceTone;
}

export interface PerformanceRankColumn {
  label: string;
  value: string;
  tone?: PerformanceTone;
}

export interface PerformanceRankRow {
  key: string;
  name: string;
  subtitle?: string;
  columns: PerformanceRankColumn[];
  /** Numeric key used by callers to pre-sort — the card renders rows as-is. */
  sortKey?: number;
}

export interface PerformanceSection {
  /** Stable key — sub-cards keyed by strategy / timeframe / dimension. */
  id: string;
  title: string;
  subtitle?: ReactNode;
  /** Compact KPI grid. Ignored when `rows` is provided. */
  stats?: PerformanceStat[];
  /** Rank-table layout. Takes precedence over `stats` when present. */
  rows?: PerformanceRankRow[];
  /** Soft empty-state note appended under the section. */
  emptyNote?: string;
}

const TONE_CLASS: Record<PerformanceTone, string> = {
  pos: "text-[color:var(--positive)]",
  neg: "text-[color:var(--negative)]",
  accent: "text-[color:var(--accent)]",
  neutral: "text-white",
};

export function PerformanceCard({ sections }: { sections: PerformanceSection[] }) {
  return (
    <SurfaceCard
      as="section"
      className="flex h-full flex-col overflow-hidden p-5"
    >
      <header className="mb-4 flex items-baseline justify-between gap-3">
        <p className="font-mono text-[10px] font-semibold uppercase tracking-[0.22em] text-white/45">
          Trade performance
        </p>
      </header>

      <div className="-mr-2 flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto pr-2">
        {sections.map((s) => (
          <PerformanceSectionView key={s.id} section={s} />
        ))}
      </div>

    </SurfaceCard>
  );
}

function PerformanceSectionView({ section }: { section: PerformanceSection }) {
  const isRank = !!section.rows;
  return (
    <div data-testid={`perf-section-${section.id}`} className="min-w-0">
      <div className="mb-3 flex items-baseline justify-between gap-2">
        <p className="font-mono text-[10px] font-semibold uppercase tracking-[0.18em] text-white/60">
          {section.title}
        </p>
        {section.subtitle ? (
          <p className="font-mono text-[9.5px] uppercase tracking-[0.16em] text-white/40">
            {section.subtitle}
          </p>
        ) : null}
      </div>

      {isRank ? (
        <RankRows rows={section.rows!} />
      ) : (
        <div className="grid grid-cols-2 gap-x-3 gap-y-3 sm:grid-cols-3">
          {(section.stats ?? []).map((it) => (
            <div key={it.label} className="min-w-0">
              <p className="truncate font-mono text-[9.5px] font-semibold uppercase tracking-[0.14em] text-white/45">
                {it.label}
              </p>
              <p
                data-testid={`perf-stat-${it.label.toLowerCase().replace(/\s+/g, "-")}`}
                className={`mt-1 truncate font-mono text-[16px] font-semibold tabular-nums ${
                  TONE_CLASS[it.tone ?? "neutral"]
                }`}
              >
                {it.value}
              </p>
            </div>
          ))}
        </div>
      )}


      {section.emptyNote ? (
        <p className="mt-3 font-mono text-[10px] uppercase tracking-[0.16em] text-white/40">
          {section.emptyNote}
        </p>
      ) : null}
    </div>
  );
}

function RankRows({ rows }: { rows: PerformanceRankRow[] }) {
  const colCount = rows[0]?.columns.length ?? 0;
  // Grid: [rank | name (flex) | one min-content column per metric].
  // Metric columns share a fixed minmax so headers/values never clip
  // and the name column truncates first.
  const templateCols = `18px minmax(0,1fr) ${"minmax(56px,auto) ".repeat(colCount).trim()}`;
  return (
    <ol className="flex flex-col divide-y divide-white/[0.06]">
      {rows.map((row, idx) => (
        <li
          key={row.key}
          data-testid={`perf-rank-row-${row.key}`}
          className="grid items-center gap-x-3 gap-y-1 py-2"
          style={{ gridTemplateColumns: templateCols }}
        >
          <span className="font-mono text-[10px] font-semibold uppercase tracking-[0.16em] text-white/35 tabular-nums">
            {String(idx + 1).padStart(2, "0")}
          </span>
          <div className="min-w-0">
            <p className="truncate text-[13px] font-semibold text-white">{row.name}</p>
            {row.subtitle ? (
              <p className="mt-0.5 truncate font-mono text-[9.5px] uppercase tracking-[0.14em] text-white/40">
                {row.subtitle}
              </p>
            ) : null}
          </div>
          {row.columns.map((c) => (
            <div key={c.label} className="min-w-0 text-right">
              <p className="font-mono text-[9px] font-semibold uppercase tracking-[0.14em] text-white/40">
                {c.label}
              </p>
              <p
                className={`mt-0.5 font-mono text-[13px] font-semibold tabular-nums ${
                  TONE_CLASS[c.tone ?? "neutral"]
                }`}
              >
                {c.value}
              </p>
            </div>
          ))}
        </li>
      ))}
    </ol>
  );
}

