import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useAuth } from "@/hooks/useAuth";
import { supabase } from "@/integrations/supabase/client";
import { Dialog, DialogContent, DialogTitle, DialogDescription } from "@/components/ui/dialog";

type Plan = {
  id: string;
  name: string;
  enabled_turtles: string[];
  status: string;
  proposal: unknown;
  updated_at: string;
  max_daily_entries: number;
  max_open_positions: number;
};
export function TurtlePlanEditor({
  choices,
  book,
}: {
  choices: { key: string; label: string }[];
  book: "paper" | "live";
}) {
  const { user } = useAuth();
  const cache = useQueryClient();
  const [plan, setPlan] = useState<Plan | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [leverage, setLeverage] = useState("");
  const [dailyLimit, setDailyLimit] = useState("1");
  const [positionLimit, setPositionLimit] = useState("1");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const plans = useQuery({
    queryKey: ["turtle-editable-plans", user?.id, book],
    enabled: Boolean(user),
    queryFn: async () => {
      const [plans, rows] = await Promise.all([
        supabase
          .from("autopilot_workflows")
          .select("id,name,enabled_turtles,status,proposal,updated_at,max_daily_entries,max_open_positions")
          .eq("user_id", user!.id)
          .neq("status", "archived")
          .order("created_at", { ascending: false }),
        supabase.from("user_strategy").select("mode,params").eq("user_id", user!.id),
      ]);
      if (plans.error || rows.error) throw plans.error ?? rows.error;
      return ((plans.data ?? []) as Plan[]).filter((item) => {
        const isLive =
          (item.proposal as { setupBook?: string } | null)?.setupBook === "live" ||
          rows.data?.some(
            (row) =>
              row.mode === "live" &&
              (row.params as { autopilot_workflow_id?: string } | null)?.autopilot_workflow_id ===
                item.id,
          );
        return book === "live" ? isLive : !isLive;
      });
    },
  });
  async function save(executionSettings = false) {
    if (!plan || saving) return;
    setSaving(true);
    setError(null);
    try {
      if (executionSettings) {
        const {data,error} = await supabase.functions.invoke("autopilot-plan", {body:{
          action:"update_execution_settings",workflow_id:plan.id,expected_updated_at:plan.updated_at,
          leverage:Number(leverage),max_daily_entries:Number(dailyLimit),max_open_positions:Number(positionLimit),
        }});
        if (error || !data?.ok) throw new Error(data?.message ?? error?.message ?? "Could not save execution settings.");
      } else {
        const {error} = await supabase.rpc("edit_autopilot_turtles", {
          workflow_id:plan.id,expected_turtles:plan.enabled_turtles,selected_turtles:selected,
        });
        if (error) throw error;
      }
      await Promise.all(
        [
          "turtle-editable-plans",
          "configured-strategies",
          "automation-strategy-config",
          "autopilot-workflows",
          "automation-mandates-live",
        ].map((key) => cache.invalidateQueries({ queryKey: [key] })),
      );
      setPlan(null);
    } catch (failure) {
      setError(
        failure instanceof Error
          ? failure.message
          : String(
              (failure as { message?: string })?.message ?? "Could not save Turtle selection.",
            ),
      );
    } finally {
      setSaving(false);
    }
  }
  return (
    <div className="mt-3 space-y-2">
      {plans.isError && (
        <p role="alert" className="text-xs text-amber-200">
          Saved plans could not be loaded.{" "}
          <button onClick={() => void plans.refetch()} className="underline">
            Retry
          </button>
        </p>
      )}
      {plans.data?.map((item) => (
        <div
          key={item.id}
          className="tb-neu-inset flex flex-wrap items-center justify-between gap-2 rounded-xl p-3 text-xs"
        >
          <span className="min-w-0">
            <strong className="block break-words text-white/80">{item.name}</strong>
            <span className="text-white/45">{item.enabled_turtles.join(" · ")}</span>
            {book === "live" && <span className="block text-white/60">
              {item.max_daily_entries} daily entries · {item.max_open_positions} concurrent · {
                (item.proposal as {leverage?:number} | null)?.leverage
                  ? `${(item.proposal as {leverage:number}).leverage}× ceiling` : "Leverage choice required"}
            </span>}
          </span>
          <button
            type="button"
            className="tb-neu-raised rounded-lg px-3 py-2 text-violet-200"
            onClick={() => {
              setPlan(item);
              setSelected([...item.enabled_turtles]);
              setLeverage(String((item.proposal as {leverage?:number} | null)?.leverage ?? ""));
              setDailyLimit(String(item.max_daily_entries));
              setPositionLimit(String(item.max_open_positions));
              setError(null);
            }}
          >
            Edit plan
          </button>
        </div>
      ))}
      <Dialog
        open={Boolean(plan)}
        onOpenChange={(open) => {
          if (!open && !saving) setPlan(null);
        }}
      >
        <DialogContent className="tb-neu-panel max-w-lg rounded-2xl">
          <DialogTitle>Edit plan · {plan?.name}</DialogTitle>
          <DialogDescription>
            Choose which Turtles execute this plan. Sweep runs inside Accumulator or Sniper. Turtle selection preserves sizing;
            execution settings apply to new entries. Exchange, wallet, schedule and armed/paused state stay unchanged. For an armed plan, changes apply to subsequent
            automated decisions.
          </DialogDescription>
          <div className="grid grid-cols-2 gap-2">
            {choices.map((choice) => (
              <label
                key={choice.key}
                className="tb-neu-inset flex items-center gap-2 rounded-xl p-3 text-sm"
              >
                <input
                  type="checkbox"
                  checked={selected.includes(choice.key)}
                  disabled={saving}
                  onChange={(event) =>
                    setSelected((current) =>
                      event.target.checked
                        ? [...current, choice.key]
                        : current.filter((key) => key !== choice.key),
                    )
                  }
                />
                {choice.label}
              </label>
            ))}
          </div>
          {book === "live" && <div className="space-y-3 rounded-xl border border-white/10 p-3">
            <p className="text-xs text-white/60">Execution settings apply to new entries. Saving does not resume a paused exchange.</p>
            {[["Leverage ceiling (1–125×)",leverage,setLeverage],["Daily entry limit (1–100)",dailyLimit,setDailyLimit],["Concurrent position limit (1–6)",positionLimit,setPositionLimit]].map(([label,value,setter]) => (
              <label key={label as string} className="block text-xs text-white/70">{label as string}
                <input type="number" step="1" min="1" value={value as string} disabled={saving}
                  onChange={event => (setter as (value:string)=>void)(event.target.value)}
                  className="tb-neu-inset mt-1 block w-full rounded-lg p-2" />
              </label>
            ))}
            <p className="text-xs text-white/50">ApeX ceiling: 100×. Aster ceiling: 125×. Symbol and collateral checks may lower execution.</p>
            <button type="button" disabled={saving || !leverage || ![leverage,dailyLimit,positionLimit].every(value => Number.isInteger(Number(value)) && Number(value)>0)}
              onClick={() => void save(true)} className="tb-neu-raised rounded-lg p-2 text-xs text-violet-100 disabled:opacity-40">
              {saving ? "Saving…" : "Save execution settings"}
            </button>
          </div>}
          {error && (
            <p role="alert" className="text-xs text-amber-200">
              {error}
            </p>
          )}
          <button
            type="button"
            disabled={saving || selected.length === 0}
            onClick={() => void save()}
            className="tb-neu-raised rounded-xl p-3 text-violet-100 disabled:opacity-40"
          >
            {saving ? "Saving…" : "Save Turtle selection"}
          </button>
        </DialogContent>
      </Dialog>
    </div>
  );
}
