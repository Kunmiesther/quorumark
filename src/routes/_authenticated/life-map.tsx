/**
 * Life Map v3 — /life-map route.
 *
 * Customer story (top to bottom):
 *   1. Header — level + points (`useLifeProgress`).
 *   2. "How it works" — 3-step instructions.
 *   3. Category grid — click a tile → drawer with bills in that category
 *      + inline BillForm (category preselected).
 *   5. Charts — obligation mix + coverage bars (matches /paper aesthetic).
 *   6. Recent-allocation history is still accessible per bill inside the
 *      drawer.
 *
 * All schema/data hooks from v2 stay authoritative — this file is a
 * composition rewrite around them.
 */
import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import {
  Plus,
  RefreshCw,
  X,
  Pencil,
  Trash2,
  CheckCircle2,
  Upload,
  ChevronRight,
  ChevronDown,
  Sparkles,
} from "lucide-react";
import {
  listBills,
  getLifeMapSnapshot,
  syncBillAllocations,
  archiveBill,
  assignBillStrategy,
} from "@/lib/bills/bills.functions";
import { BillForm } from "@/components/lifemap/BillForm";
import { BillAllocationsList } from "@/components/lifemap/BillAllocationsList";
import { LifeMapCharts } from "@/components/lifemap/LifeMapCharts";
import { ReallocationSuggestionBanner } from "@/components/lifemap/ReallocationSuggestionBanner";
import { ProofUploadDialog } from "@/components/lifemap/ProofUploadDialog";
import {
  CATEGORIES,
  STRATEGIES,
  categoryByKey,
  strategyByKey,
  type LifeCategory,
} from "@/lib/lifemap/catalog";

export const Route = createFileRoute("/_authenticated/life-map")({
  component: LifeMapPage,
  head: () => ({
    meta: [
      { title: "Life Map — TurtleBot" },
      {
        name: "description",
        content:
          "Track real-life bills by category and keep simulated and live trading allocations separate.",
      },
      { property: "og:title", content: "Life Map — TurtleBot" },
      {
        property: "og:description",
        content:
          "Categories, trading plans, and separately labeled live and simulated bill targets.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
});

function fmtUsd(n: number): string {
  const sign = n < 0 ? "-" : "";
  return `${sign}$${Math.abs(n).toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

type BillRow = Awaited<ReturnType<typeof listBills>>[number];

function LifeMapPage() {
  const fetchSnap = useServerFn(getLifeMapSnapshot);
  const fetchBills = useServerFn(listBills);
  const sync = useServerFn(syncBillAllocations);
  const qc = useQueryClient();
  const [openCategory, setOpenCategory] = useState<string | null>(null);

  const snapQ = useQuery({
    queryKey: ["life-map-snapshot"],
    queryFn: () => fetchSnap(),
    staleTime: 10_000,
    refetchInterval: 15_000,
    refetchIntervalInBackground: false,
  });
  const billsQ = useQuery({
    queryKey: ["bills"],
    queryFn: () => fetchBills(),
    staleTime: 10_000,
    refetchInterval: 30_000,
  });

  const syncMut = useMutation({
    mutationFn: () => sync(),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["life-map-snapshot"] });
    },
  });

  const bills = useMemo(() => (billsQ.data ?? []) as BillRow[], [billsQ.data]);

  // Kick a sync on mount, then every 30s while the tab is visible so the
  // charts illustrate results as trades close in real time.
  useEffect(() => {
    if (billsQ.isLoading || bills.length === 0) return;
    syncMut.mutate();
    const id = setInterval(() => {
      if (document.visibilityState === "visible") syncMut.mutate();
    }, 30_000);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bills.length, billsQ.isLoading]);
  const snap = snapQ.data;
  const coverageByBill = useMemo(() => {
    const m = new Map<string, number>();
    for (const r of snap?.bills ?? []) m.set(r.bill.id, r.covered_usd);
    return m;
  }, [snap]);

  const byCategory = useMemo(() => {
    const m = new Map<string, BillRow[]>();
    for (const c of CATEGORIES) m.set(c.key, []);
    m.set("__other", []);
    for (const b of bills) {
      const key = b.category && m.has(b.category) ? b.category : "__other";
      m.get(key)!.push(b);
    }
    return m;
  }, [bills]);

  const totalPct =
    snap && snap.total_amount_usd > 0
      ? Math.min(100, (snap.total_covered_usd / snap.total_amount_usd) * 100)
      : 0;
  const remainingUsd = Math.max(0, (snap?.total_amount_usd ?? 0) - (snap?.total_covered_usd ?? 0));

  return (
    <div className="min-h-screen bg-black text-white">
      <div className="mx-auto max-w-6xl px-4 pb-4 pt-6 sm:px-6 lg:px-8">
        {/* Header */}
        <div className="mb-6 flex flex-wrap items-baseline justify-between gap-3">
          <div>
            <p className="text-[10px] font-semibold uppercase tracking-[0.2em] text-[#9945FF]">
              Life Map
            </p>
            <h1 className="mt-1 text-[26px] font-bold tracking-tight text-white">
              Track trading income against your bills
            </h1>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => syncMut.mutate()}
              disabled={syncMut.isPending}
              className="flex items-center gap-2 rounded-lg bg-white/[0.05] px-3 py-2 text-[11px] font-semibold uppercase tracking-wider text-white/70 transition hover:bg-white/[0.08] disabled:opacity-50"
            >
              <RefreshCw className={`h-3.5 w-3.5 ${syncMut.isPending ? "animate-spin" : ""}`} />
              Sync
            </button>
          </div>
        </div>

        {/* Coverage summary */}
        <div className="mb-4 overflow-hidden rounded-3xl bg-gradient-to-br from-[#9945FF]/15 via-white/[0.02] to-black p-5 shadow-[0_0_60px_-24px_#9945FF]">
          <div className="flex items-baseline justify-between">
            <div>
              <p className="text-[10px] font-semibold uppercase tracking-widest text-white/50">
                Live income allocated this period
              </p>
              <p className="mt-1 font-mono text-[28px] font-bold tabular-nums text-white">
                {fmtUsd(snap?.total_covered_usd ?? 0)}
                <span className="ml-2 text-[14px] font-normal text-white/50">
                  of {fmtUsd(snap?.total_amount_usd ?? 0)}
                </span>
              </p>
            </div>
            <p className="text-right text-[10px] uppercase tracking-widest text-white/40">
              Live realized P&amp;L · priority order
            </p>
          </div>
          <div className="mt-4 h-2 overflow-hidden rounded-full bg-white/[0.06]">
            <div
              className="h-full rounded-full bg-gradient-to-r from-[#9945FF] to-[#14F195] transition-all duration-700"
              style={{ width: `${totalPct}%` }}
            />
          </div>
          <div className="mt-4 flex items-center justify-between gap-3">
            <p className="font-mono text-xs text-white/55">Remaining {fmtUsd(remainingUsd)}</p>
            {bills.length === 0 ? (
              <button type="button" onClick={() => setOpenCategory("roof")} className="rounded-xl bg-white/[0.06] px-3 py-2 text-xs font-semibold text-white/75">Add first bill</button>
            ) : (
              <Link to="/automation" className="rounded-xl bg-white/[0.06] px-3 py-2 text-xs font-semibold text-white/75">Use target in Autopilot</Link>
            )}
          </div>
          <p className="mt-3 text-xs leading-5 text-white/55">
            Paper simulation: {fmtUsd(snap?.total_paper_covered_usd ?? 0)} toward these targets.
            Neither figure is a transfer or bill payment; confirm payment separately with proof.
          </p>
        </div>

        {/* Surplus reallocation — click "Apply" to send accumulated excess to smaller uncovered bills */}
        <ReallocationSuggestionBanner />

        {/* How it works */}
        <HowItWorks />

        {/* Category grid */}
        <div className="mt-6 mb-3 flex items-baseline justify-between">
          <h2 className="text-[16px] font-semibold text-white">Pick a category</h2>
          <span className="text-[10px] uppercase tracking-widest text-white/40">
            Click a tile to add or manage bills
          </span>
        </div>
        <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3">
          {CATEGORIES.map((c) => {
            const list = byCategory.get(c.key) ?? [];
            const target = list.reduce((a, b) => a + Number(b.amount_usd), 0);
            const covered = list.reduce(
              (a, b) => a + Math.min(Number(b.amount_usd), coverageByBill.get(b.id) ?? 0),
              0,
            );
            const pct = target > 0 ? Math.min(100, (covered / target) * 100) : 0;
            return (
              <CategoryTile
                key={c.key}
                cat={c}
                billCount={list.length}
                target={target}
                pct={pct}
                onClick={() => setOpenCategory(c.key)}
              />
            );
          })}
        </div>

        {/* Charts */}
        <div className="mt-6 mb-3 flex items-baseline justify-between">
          <h2 className="text-[16px] font-semibold text-white">Where your money goes</h2>
        </div>
        <LifeMapCharts
          bills={bills.map((b) => ({
            id: b.id,
            amount_usd: Number(b.amount_usd),
            category: b.category ?? null,
          }))}
          allocations={(snap?.bills ?? []).map((r) => ({
            bill_id: r.bill.id,
            covered_usd: r.covered_usd,
          }))}
        />

        {openCategory && (
          <CategoryDrawer
            category={CATEGORIES.find((c) => c.key === openCategory)!}
            bills={byCategory.get(openCategory) ?? []}
            coverage={coverageByBill}
            onClose={() => setOpenCategory(null)}
          />
        )}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Instructions */
/* ------------------------------------------------------------------ */

function HowItWorks() {
  const steps = [
    {
      n: "1",
      t: "Add your bills",
      d: "Pick a category and drop in what you owe — rent, phone, gym.",
    },
    {
      n: "2",
      t: "Build an Autopilot plan",
      d: "Select a bill to track inside Onyx setup, then set venue, capital, and pause limits. Allocation follows Life Map priority.",
    },
    {
      n: "3",
      t: "Earn life points",
      d: "Correct Scout calls, funded bills, and paid-with-proof all reward you.",
    },
  ];
  return (
    <section className="rounded-3xl bg-white/[0.04] p-5">
      <div className="mb-3 flex items-baseline gap-2">
        <Sparkles className="h-4 w-4 text-[#9945FF]" />
        <h2 className="text-[13px] font-semibold text-white">How Life Map works</h2>
      </div>
      <ol className="grid gap-2 sm:grid-cols-3">
        {steps.map((s) => (
          <li
            key={s.n}
            className="rounded-2xl bg-black/40 p-3 ring-1 ring-white/[0.05]"
          >
            <div className="flex items-center gap-2">
              <span className="flex h-6 w-6 items-center justify-center rounded-full bg-[#9945FF]/20 text-[11px] font-bold text-[#9945FF]">
                {s.n}
              </span>
              <p className="text-[13px] font-semibold text-white">{s.t}</p>
            </div>
            <p className="mt-1.5 text-[11.5px] leading-relaxed text-white/60">{s.d}</p>
          </li>
        ))}
      </ol>
    </section>
  );
}

/* ------------------------------------------------------------------ */
/* Category tile */
/* ------------------------------------------------------------------ */

function CategoryTile({
  cat,
  billCount,
  target,
  pct,
  onClick,
}: {
  cat: LifeCategory;
  billCount: number;
  target: number;
  pct: number;
  onClick: () => void;
}) {
  const Icon = cat.icon;
  return (
    <button
      type="button"
      onClick={onClick}
      className="group relative overflow-hidden rounded-2xl bg-white/[0.04] p-3 text-left transition hover:bg-white/[0.07]"
      style={{ boxShadow: `inset 0 0 0 1px ${cat.accent}22` }}
    >
      <div className="flex items-center gap-2">
        <div
          className="flex h-8 w-8 items-center justify-center rounded-xl"
          style={{ background: `${cat.accent}20` }}
        >
          <Icon className="h-4 w-4" style={{ color: cat.accent }} />
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-[13px] font-semibold text-white">{cat.label}</p>
          <p className="text-[10px] uppercase tracking-widest text-white/40">
            {billCount === 0 ? "no bills" : `${billCount} bill${billCount === 1 ? "" : "s"}`}
          </p>
        </div>
        <ChevronRight className="h-3.5 w-3.5 text-white/30 transition group-hover:text-white/60" />
      </div>
      <div className="mt-2.5 h-1 overflow-hidden rounded-full bg-white/[0.06]">
        <div
          className="h-full rounded-full transition-all duration-500"
          style={{ width: `${pct}%`, background: cat.accent }}
        />
      </div>
      <div className="mt-1.5 flex items-baseline justify-between font-mono tabular-nums">
        <span className="text-[11px] text-white/50">{fmtUsd(target)}</span>
        <span className="text-[10px] text-white/40">{Math.round(pct)}%</span>
      </div>
    </button>
  );
}

/* ------------------------------------------------------------------ */
/* Category drawer */
/* ------------------------------------------------------------------ */

function CategoryDrawer({
  category,
  bills,
  coverage,
  onClose,
}: {
  category: LifeCategory;
  bills: BillRow[];
  coverage: Map<string, number>;
  onClose: () => void;
}) {
  const [adding, setAdding] = useState(bills.length === 0);
  const [preset, setPreset] = useState<{ name: string; amount_usd: number } | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const Icon = category.icon;

  // Presets already added (by name, case-insensitive) get a subtle "added" chip
  // treatment so users don't add duplicates.
  const existingNames = useMemo(
    () => new Set(bills.map((b) => b.name.trim().toLowerCase())),
    [bills],
  );

  function pickPreset(p: { name: string; amount: number }) {
    setPreset({ name: p.name, amount_usd: p.amount });
    setAdding(true);
  }

  return (
    <div
      className="fixed inset-0 z-40 flex justify-end bg-black/70"
      role="dialog"
      aria-modal="true"
      onClick={onClose}
    >
      <div
        className="flex h-full w-full max-w-lg flex-col overflow-y-auto bg-[#0b0b12] p-5 ring-1 ring-white/10"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-start justify-between">
          <div className="flex items-center gap-3">
            <div
              className="flex h-10 w-10 items-center justify-center rounded-2xl"
              style={{ background: `${category.accent}20` }}
            >
              <Icon className="h-5 w-5" style={{ color: category.accent }} />
            </div>
            <div>
              <p className="text-[10px] font-semibold uppercase tracking-widest text-white/50">
                Category
              </p>
              <h3 className="text-[18px] font-bold text-white">{category.label}</h3>
              <p className="mt-0.5 text-[11px] text-white/50">{category.blurb}</p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="rounded p-1 text-white/50 hover:bg-white/[0.06] hover:text-white"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* One-tap presets — click to prefill the form, no typing needed. */}
        {category.presets.length > 0 && (
          <div className="mb-3 rounded-2xl bg-white/[0.03] p-3 ring-1 ring-white/[0.06]">
            <p className="mb-2 text-[10px] font-semibold uppercase tracking-widest text-white/50">
              Quick add
            </p>
            <div className="flex flex-wrap gap-1.5">
              {category.presets.map((p) => {
                const already = existingNames.has(p.name.trim().toLowerCase());
                return (
                  <button
                    key={p.name}
                    type="button"
                    onClick={() => pickPreset(p)}
                    className="group inline-flex items-center gap-1.5 rounded-full border border-white/10 bg-white/[0.04] px-2.5 py-1 text-[11px] font-medium text-white/80 transition hover:border-[color:var(--accent)] hover:bg-white/[0.08]"
                    style={{ ["--accent" as string]: category.accent }}
                    aria-label={`Add ${p.name} preset`}
                  >
                    <Plus className="h-3 w-3 opacity-60 group-hover:opacity-100" />
                    <span>{p.name}</span>
                    <span className="font-mono tabular-nums text-white/40">
                      ${p.amount}
                    </span>
                    {already && (
                      <span className="ml-0.5 text-[9px] uppercase tracking-widest text-[#14F195]">
                        added
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {!adding && (
          <button
            type="button"
            onClick={() => {
              setPreset(null);
              setAdding(true);
            }}
            className="mb-3 flex items-center justify-center gap-1.5 rounded-xl bg-[#9945FF] py-2 text-[12px] font-semibold text-white shadow-[0_0_20px_-4px_#9945FF] transition hover:brightness-110"
          >
            <Plus className="h-3.5 w-3.5" />
            Add custom bill
          </button>
        )}

        {adding && (
          <div className="mb-3 rounded-2xl bg-white/[0.03] p-3 ring-1 ring-white/[0.06]">
            <BillForm
              // Force a fresh form instance when the user taps a different
              // preset so `useState`'s initial value is re-read.
              key={preset?.name ?? "custom"}
              compact
              initial={{
                category: category.key,
                ...(preset ?? {}),
              }}
              onSaved={() => {
                setAdding(false);
                setPreset(null);
              }}
              onCancel={() => {
                setPreset(null);
                setAdding(bills.length === 0 ? true : false);
              }}
            />
          </div>
        )}


        {bills.length === 0 && !adding && (
          <p className="rounded-2xl bg-white/[0.03] p-4 text-center text-[12px] text-white/50">
            No bills yet in {category.label}.
          </p>
        )}

        <ul className="space-y-2.5">
          {bills.map((b) => (
            <BillCard
              key={b.id}
              bill={b}
              covered={coverage.get(b.id) ?? 0}
              accent={category.accent}
              isEditing={editing === b.id}
              onEdit={() => setEditing(b.id)}
              onCloseEdit={() => setEditing(null)}
            />
          ))}
        </ul>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Bill card (inside drawer) */
/* ------------------------------------------------------------------ */

function BillCard({
  bill,
  covered,
  accent,
  isEditing,
  onEdit,
  onCloseEdit,
}: {
  bill: BillRow;
  covered: number;
  accent: string;
  isEditing: boolean;
  onEdit: () => void;
  onCloseEdit: () => void;
}) {
  const [expandAlloc, setExpandAlloc] = useState(false);
  const [showProof, setShowProof] = useState(false);
  const [assignOpen, setAssignOpen] = useState(false);
  const qc = useQueryClient();
  const archive = useServerFn(archiveBill);
  const assign = useServerFn(assignBillStrategy);

  const archiveMut = useMutation({
    mutationFn: () => archive({ data: { id: bill.id } }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["bills"] });
      qc.invalidateQueries({ queryKey: ["life-map-snapshot"] });
    },
  });
  const assignMut = useMutation({
    mutationFn: (strategy: string | null) => assign({ data: { id: bill.id, strategy } }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["bills"] });
      setAssignOpen(false);
    },
  });

  const cap = Number(bill.amount_usd);
  const pct = cap > 0 ? Math.min(100, (covered / cap) * 100) : 0;
  const isFull = covered >= cap && cap > 0;
  const strategy = strategyByKey(bill.assigned_strategy);
  const paid = !!bill.paid_at;

  if (isEditing) {
    return (
      <li className="rounded-2xl bg-white/[0.03] p-3 ring-1 ring-white/[0.06]">
        <BillForm
          compact
          initial={{
            id: bill.id,
            name: bill.name,
            amount_usd: Number(bill.amount_usd),
            cadence: bill.cadence as "monthly" | "weekly" | "one_time",
            due_day: bill.due_day,
            priority: bill.priority,
            category: bill.category ?? null,
          }}
          onSaved={onCloseEdit}
          onCancel={onCloseEdit}
        />
      </li>
    );
  }

  return (
    <li className="overflow-hidden rounded-2xl bg-white/[0.03] p-3 ring-1 ring-white/[0.06]">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <p className="truncate text-[14px] font-semibold text-white">{bill.name}</p>
            {paid && (
              <span className="inline-flex items-center gap-1 rounded-full bg-[#14F195]/15 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-widest text-[#14F195]">
                <CheckCircle2 className="h-2.5 w-2.5" />
                Paid
              </span>
            )}
          </div>
          <p className="mt-0.5 text-[10px] uppercase tracking-widest text-white/40">
            {bill.cadence}
            {bill.due_day ? ` · day ${bill.due_day}` : ""} · priority {bill.priority}
          </p>
        </div>
        <div className="flex items-center gap-1">
          <button
            type="button"
            aria-label="Edit"
            onClick={onEdit}
            className="rounded p-1 text-white/50 hover:bg-white/[0.06] hover:text-white"
          >
            <Pencil className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            aria-label="Remove"
            onClick={() => {
              if (confirm(`Remove "${bill.name}"?`)) archiveMut.mutate();
            }}
            className="rounded p-1 text-white/50 hover:bg-[#ff5c8a]/20 hover:text-[#ff5c8a]"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      <div className="mt-2 flex items-baseline justify-between font-mono tabular-nums">
        <span className={`text-[15px] font-bold ${isFull ? "text-[#14F195]" : "text-white"}`}>
          {fmtUsd(covered)}
        </span>
        <span className="text-[11px] text-white/50">/ {fmtUsd(cap)}</span>
      </div>
      <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-white/[0.06]">
        <div
          className="h-full rounded-full transition-all duration-500"
          style={{ width: `${pct}%`, background: isFull ? "#14F195" : accent }}
        />
      </div>

      {/* Turtle assignment */}
      <div className="mt-3 flex items-center gap-2">
        <button
          type="button"
          onClick={() => setAssignOpen((v) => !v)}
          className="flex-1 rounded-lg bg-white/[0.04] px-2.5 py-1.5 text-left text-[11px] text-white/70 transition hover:bg-white/[0.07]"
        >
          {strategy ? (
            <>
              <span className="text-white/50">Bot ·</span>{" "}
              <span className="font-semibold text-white" style={{ color: strategy.accent }}>
                {strategy.label}
              </span>
            </>
          ) : (
            <span className="text-white/50">Assign a turtle bot</span>
          )}
        </button>
        <button
          type="button"
          onClick={() => setShowProof(true)}
          disabled={!isFull && !paid}
          className={`rounded-lg px-2.5 py-1.5 text-[11px] font-semibold transition ${
            paid
              ? "bg-[#14F195]/15 text-[#14F195] hover:bg-[#14F195]/25"
              : isFull
                ? "bg-[#9945FF] text-white hover:brightness-110"
                : "cursor-not-allowed bg-white/[0.04] text-white/30"
          }`}
        >
          <Upload className="mr-1 -mt-0.5 inline h-3 w-3" />
          {paid ? "View proof" : "Mark paid"}
        </button>
      </div>

      {assignOpen && (
        <div className="mt-2 grid grid-cols-2 gap-1.5 rounded-xl bg-black/40 p-2 ring-1 ring-white/[0.05]">
          {STRATEGIES.map((s) => {
            const S = s.icon;
            const active = bill.assigned_strategy === s.key;
            return (
              <button
                key={s.key}
                type="button"
                onClick={() => assignMut.mutate(active ? null : s.key)}
                disabled={assignMut.isPending}
                className="flex items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[11px] transition hover:bg-white/[0.06] disabled:opacity-50"
                style={{
                  boxShadow: active ? `inset 0 0 0 1px ${s.accent}66` : undefined,
                  background: active ? `${s.accent}12` : undefined,
                }}
              >
                <S className="h-3.5 w-3.5" style={{ color: s.accent }} />
                <span className="font-medium text-white">{s.label}</span>
                {active && (
                  <CheckCircle2
                    className="ml-auto h-3 w-3"
                    style={{ color: s.accent }}
                  />
                )}
              </button>
            );
          })}
          {bill.assigned_strategy && (
            <button
              type="button"
              onClick={() => assignMut.mutate(null)}
              className="col-span-2 rounded-lg px-2 py-1 text-[10px] uppercase tracking-widest text-white/40 hover:text-white/70"
            >
              Clear assignment
            </button>
          )}
        </div>
      )}

      <button
        type="button"
        onClick={() => setExpandAlloc((v) => !v)}
        className="mt-3 flex w-full items-center justify-between rounded-md px-1 py-1 text-[10px] font-semibold uppercase tracking-widest text-white/40 transition hover:text-white/70"
        aria-expanded={expandAlloc}
      >
        <span>Recent allocations</span>
        {expandAlloc ? (
          <ChevronDown className="h-3.5 w-3.5" />
        ) : (
          <ChevronRight className="h-3.5 w-3.5" />
        )}
      </button>
      {expandAlloc && <BillAllocationsList billId={bill.id} />}

      {showProof && (
        <ProofUploadDialog
          billId={bill.id}
          billName={bill.name}
          paidAt={bill.paid_at ?? null}
          onClose={() => setShowProof(false)}
        />
      )}
    </li>
  );
}

// Suppress unused-import complaint — helper re-exported for downstream files.
void categoryByKey;
