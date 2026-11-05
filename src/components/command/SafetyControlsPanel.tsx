import { useEffect, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { CommandPanel } from "@/components/command/CommandPanel";

interface Limits {
  max_leverage: number;
  max_order_size_usd: number;
  max_total_exposure_usd: number;
  daily_loss_limit_usd: number;
}

const DEFAULTS: Limits = {
  max_leverage: 5,
  max_order_size_usd: 25,
  max_total_exposure_usd: 100,
  daily_loss_limit_usd: 25,
};

/**
 * User-configurable safety limits. Persisted to `user_trading_limits`.
 * Phase A: stores values only. The mainnet order path (Phase B) will read
 * these before authorizing any live intent.
 */
export function SafetyControlsPanel() {
  const { user } = useAuth();
  const qc = useQueryClient();

  const { data } = useQuery({
    queryKey: ["user-trading-limits", user?.id],
    enabled: !!user,
    queryFn: async (): Promise<Limits> => {
      const { data, error } = await supabase
        .from("user_trading_limits")
        .select("max_leverage,max_order_size_usd,max_total_exposure_usd,daily_loss_limit_usd")
        .eq("user_id", user!.id)
        .maybeSingle();
      if (error) throw error;
      if (!data) return DEFAULTS;
      return {
        max_leverage: Number(data.max_leverage),
        max_order_size_usd: Number(data.max_order_size_usd),
        max_total_exposure_usd: Number(data.max_total_exposure_usd),
        daily_loss_limit_usd: Number(data.daily_loss_limit_usd),
      };
    },
  });

  const [form, setForm] = useState<Limits>(DEFAULTS);
  useEffect(() => {
    if (data) setForm(data);
  }, [data]);

  const save = useMutation({
    mutationFn: async (next: Limits) => {
      if (!user) throw new Error("Not signed in");
      const { error } = await supabase
        .from("user_trading_limits")
        .upsert({ user_id: user.id, ...next }, { onConflict: "user_id" });
      if (error) throw error;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["user-trading-limits", user?.id] }),
  });

  const halt = useMutation({
    mutationFn: async () => {
      if (!user) throw new Error("Not signed in");
      const { error } = await supabase.from("kill_switches").insert({
        user_id: user.id,
        scope: "user",
        active: true,
        reason: "user_ui_halt",
      });
      if (error) throw error;
    },
  });

  return (
    <CommandPanel
      title="Safety controls"
      subtitle="Personal risk limits and emergency stop. Enforced server-side once mainnet execution is enabled."
    >
      <div className="space-y-3">
        <NumField
          label="Maximum leverage"
          value={form.max_leverage}
          min={1}
          max={100}
          onChange={(v) => setForm((f) => ({ ...f, max_leverage: Math.min(100, Math.max(1, v)) }))}
        />
        <NumField
          label="Max single order (USD)"
          value={form.max_order_size_usd}
          onChange={(v) => setForm((f) => ({ ...f, max_order_size_usd: v }))}
        />
        <NumField
          label="Max total exposure (USD)"
          value={form.max_total_exposure_usd}
          onChange={(v) => setForm((f) => ({ ...f, max_total_exposure_usd: v }))}
        />
        <NumField
          label="Daily loss limit (USD)"
          value={form.daily_loss_limit_usd}
          onChange={(v) => setForm((f) => ({ ...f, daily_loss_limit_usd: v }))}
        />
        <div className="flex flex-wrap gap-2 pt-2">
          <button
            onClick={() => save.mutate(form)}
            disabled={save.isPending}
            className="rounded bg-[color:var(--intel-cyan)] px-3 py-1.5 text-[12px] font-bold uppercase tracking-[0.14em] text-black disabled:opacity-50"
          >
            {save.isPending ? "Saving…" : "Save limits"}
          </button>
          <button
            onClick={() => {
              if (
                confirm(
                  "Halt TurtleBot for your account? This activates the user-scope kill switch.",
                )
              ) {
                halt.mutate();
              }
            }}
            disabled={halt.isPending}
            className="rounded bg-[color:var(--danger-red)] px-3 py-1.5 text-[12px] font-bold uppercase tracking-[0.14em] text-white disabled:opacity-50"
          >
            {halt.isPending ? "Halting…" : "Stop TurtleBot"}
          </button>
        </div>
        {save.isError && (
          <p className="text-[11px] text-[color:var(--danger-red)]">
            {(save.error as Error).message}
          </p>
        )}
        {halt.isSuccess && (
          <p className="text-[11px] text-[color:var(--warn-amber)]">
            Kill switch activated. All bays halted until it is cleared.
          </p>
        )}
      </div>
    </CommandPanel>
  );
}

function NumField({
  label,
  value,
  min = 0,
  max,
  onChange,
}: {
  label: string;
  value: number;
  min?: number;
  max?: number;
  onChange: (v: number) => void;
}) {
  return (
    <label className="flex items-center justify-between gap-3">
      <span className="text-[12px] text-[color:var(--text-secondary)]">{label}</span>
      <input
        type="number"
        min={min}
        max={max}
        step="1"
        value={Number.isFinite(value) ? value : 0}
        onChange={(e) => onChange(Number(e.target.value))}
        className="w-28 rounded border border-[color:var(--border)] bg-[color:var(--surface-2)] px-2 py-1 text-right font-mono text-[12px] text-[color:var(--text-primary)]"
      />
    </label>
  );
}
