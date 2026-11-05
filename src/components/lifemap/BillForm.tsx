/**
 * Shared bill entry form — used on /life-map, in the /paper prompt card,
 * and (later) in the welcome onboarding step.
 *
 * Owns validation only. Persistence is delegated to `upsertBill` so every
 * surface writes to the same durable row with the same ownership rules.
 */
import { useState } from "react";
import { z } from "zod";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { upsertBill } from "@/lib/bills/bills.functions";

import { CATEGORIES } from "@/lib/lifemap/catalog";

const schema = z.object({
  name: z.string().trim().min(1, "Name required").max(120),
  amount_usd: z
    .number({ invalid_type_error: "Amount required" })
    .positive("Must be positive")
    .max(1_000_000),
  cadence: z.enum(["monthly", "weekly", "one_time"]),
  due_day: z.number().int().min(1).max(31).nullable(),
  priority: z.number().int().min(0).max(10_000),
  category: z.string().min(1).max(40).nullable(),
});

export interface BillFormValue {
  id?: string;
  name: string;
  amount_usd: number;
  cadence: "monthly" | "weekly" | "one_time";
  due_day: number | null;
  priority: number;
  category: string | null;
}

const EMPTY: BillFormValue = {
  name: "",
  amount_usd: 0,
  cadence: "monthly",
  due_day: 1,
  priority: 100,
  category: null,
};


export function BillForm({
  initial,
  onSaved,
  onCancel,
  compact = false,
}: {
  initial?: Partial<BillFormValue>;
  onSaved?: (id: string) => void;
  onCancel?: () => void;
  compact?: boolean;
}) {
  const [value, setValue] = useState<BillFormValue>({ ...EMPTY, ...initial });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const upsert = useServerFn(upsertBill);
  const qc = useQueryClient();

  const mut = useMutation({
    mutationFn: async (v: BillFormValue) => upsert({ data: v }),
    onSuccess: (res) => {
      qc.invalidateQueries({ queryKey: ["bills"] });
      qc.invalidateQueries({ queryKey: ["life-map-snapshot"] });
      onSaved?.(res.id);
    },
  });

  function submit(e: React.FormEvent) {
    e.preventDefault();
    const parsed = schema.safeParse(value);
    if (!parsed.success) {
      const errs: Record<string, string> = {};
      for (const issue of parsed.error.issues) {
        errs[issue.path.join(".")] = issue.message;
      }
      setErrors(errs);
      return;
    }
    setErrors({});
    mut.mutate(parsed.data);
  }

  const inputCls =
    "w-full rounded-lg border border-white/10 bg-black/40 px-3 py-2 text-[13px] text-white placeholder:text-white/30 focus:border-[#9945FF]/60 focus:outline-none focus:ring-1 focus:ring-[#9945FF]/40";

  return (
    <form onSubmit={submit} className={compact ? "space-y-2.5" : "space-y-3"}>
      <div>
        <label className="mb-1 block text-[10px] font-semibold uppercase tracking-widest text-white/50">
          Bill name
        </label>
        <input
          className={inputCls}
          placeholder="Rent, car payment, phone…"
          value={value.name}
          onChange={(e) => setValue({ ...value, name: e.target.value })}
          maxLength={120}
        />
        {errors.name && <p className="mt-1 text-[11px] text-[#ff5c8a]">{errors.name}</p>}
      </div>

      <div className="grid grid-cols-2 gap-2.5">
        <div>
          <label className="mb-1 block text-[10px] font-semibold uppercase tracking-widest text-white/50">
            Amount (USD)
          </label>
          <input
            type="number"
            step="0.01"
            min="0"
            className={inputCls}
            value={value.amount_usd || ""}
            onChange={(e) =>
              setValue({ ...value, amount_usd: Number(e.target.value) || 0 })
            }
          />
          {errors.amount_usd && (
            <p className="mt-1 text-[11px] text-[#ff5c8a]">{errors.amount_usd}</p>
          )}
        </div>
        <div>
          <label className="mb-1 block text-[10px] font-semibold uppercase tracking-widest text-white/50">
            Cadence
          </label>
          <select
            className={inputCls}
            value={value.cadence}
            onChange={(e) =>
              setValue({ ...value, cadence: e.target.value as BillFormValue["cadence"] })
            }
          >
            <option value="monthly">Monthly</option>
            <option value="weekly">Weekly</option>
            <option value="one_time">One time</option>
          </select>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-2.5">
        <div>
          <label className="mb-1 block text-[10px] font-semibold uppercase tracking-widest text-white/50">
            Due day {value.cadence === "monthly" ? "(1–31)" : "(optional)"}
          </label>
          <input
            type="number"
            min="1"
            max="31"
            className={inputCls}
            value={value.due_day ?? ""}
            onChange={(e) =>
              setValue({
                ...value,
                due_day: e.target.value ? Number(e.target.value) : null,
              })
            }
          />
        </div>
        <div>
          <label className="mb-1 block text-[10px] font-semibold uppercase tracking-widest text-white/50">
            Priority (lower = paid first)
          </label>
          <input
            type="number"
            min="0"
            max="10000"
            className={inputCls}
            value={value.priority}
            onChange={(e) =>
              setValue({ ...value, priority: Number(e.target.value) || 0 })
            }
          />
        </div>
      </div>

      <div>
        <label className="mb-1 block text-[10px] font-semibold uppercase tracking-widest text-white/50">
          Category
        </label>
        <select
          className={inputCls}
          value={value.category ?? ""}
          onChange={(e) => setValue({ ...value, category: e.target.value || null })}
        >
          <option value="">Uncategorized</option>
          {CATEGORIES.map((c) => (
            <option key={c.key} value={c.key}>
              {c.label} — {c.blurb}
            </option>
          ))}
        </select>
        {errors.category && (
          <p className="mt-1 text-[11px] text-[#ff5c8a]">{errors.category}</p>
        )}
      </div>


      <div className="flex items-center gap-2 pt-1">
        <button
          type="submit"
          disabled={mut.isPending}
          className="rounded-lg bg-[#9945FF] px-4 py-2 text-[12px] font-semibold text-white shadow-[0_0_20px_-4px_#9945FF] transition hover:brightness-110 disabled:opacity-50"
        >
          {mut.isPending ? "Saving…" : initial?.id ? "Save changes" : "Add bill"}
        </button>
        {onCancel && (
          <button
            type="button"
            onClick={onCancel}
            className="rounded-lg border border-white/10 px-4 py-2 text-[12px] font-semibold text-white/70 transition hover:bg-white/[0.04]"
          >
            Cancel
          </button>
        )}
        {mut.isError && (
          <span className="text-[11px] text-[#ff5c8a]">
            {(mut.error as Error).message}
          </span>
        )}
      </div>
    </form>
  );
}
