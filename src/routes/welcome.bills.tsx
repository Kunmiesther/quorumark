import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { Home, Car, Images, UserRound, Zap, Droplets, Wifi, ShoppingCart, Plus, ChevronRight, Dumbbell, Scissors, Heart, Plane, Cake, UtensilsCrossed, Fuel, Wrench } from "lucide-react";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { useAuth } from "@/hooks/useAuth";
import { useOnboardingRouteDiagnostics } from "@/lib/onboarding-diagnostics";
import { upsertBill } from "@/lib/bills/bills.functions";
import { BillForm } from "@/components/lifemap/BillForm";

export const Route = createFileRoute("/welcome/bills")({ component: BillsStep, head: () => ({ meta: [{ title: "Build your monthly plan — Turtle Bot" }] }) });

const TABS = [
  { id: "Roof", icon: Home }, { id: "Ride", icon: Car }, { id: "Memories", icon: Images }, { id: "Personal", icon: UserRound },
] as const;
type Tab = typeof TABS[number]["id"];
const ITEMS = {
  Roof: [
    { name: "Rent / Mortgage", amount: 1850, cadence: "Monthly", due: 1, icon: Home },
    { name: "Electricity", amount: 145, cadence: "Monthly", due: 15, icon: Zap },
    { name: "Water", amount: 65, cadence: "Monthly", due: 18, icon: Droplets },
    { name: "Internet", amount: 90, cadence: "Monthly", due: 22, icon: Wifi },
    { name: "Groceries", amount: 600, cadence: "Weekly", due: null, icon: ShoppingCart },
  ],
  Ride: [
    { name: "Vehicle payment", amount: 525, cadence: "Monthly", due: 8, icon: Car },
    { name: "Insurance", amount: 180, cadence: "Monthly", due: 12, icon: Heart },
    { name: "Fuel", amount: 240, cadence: "Monthly", due: null, icon: Fuel },
    { name: "Maintenance", amount: 90, cadence: "Monthly", due: null, icon: Wrench },
  ],
  Memories: [
    { name: "Vacation", amount: 300, cadence: "Monthly", due: null, icon: Plane },
    { name: "Birthdays", amount: 100, cadence: "Monthly", due: null, icon: Cake },
    { name: "Date night", amount: 160, cadence: "Monthly", due: null, icon: UtensilsCrossed },
  ],
  Personal: [
    { name: "Gym", amount: 65, cadence: "Monthly", due: 5, icon: Dumbbell },
    { name: "Barber / Hair", amount: 90, cadence: "Monthly", due: null, icon: Scissors },
    { name: "Therapy", amount: 200, cadence: "Monthly", due: null, icon: Heart },
  ],
} satisfies Record<Tab, Array<{name:string;amount:number;cadence:string;due:number|null;icon:typeof Home}>>;

function BillsStep() {
  const navigate = useNavigate();
  const { user, loading } = useAuth();
  const [tab, setTab] = useState<Tab>("Roof");
  const [adding, setAdding] = useState(false);
  const [saving, setSaving] = useState(false);
  const upsert = useServerFn(upsertBill);
  useOnboardingRouteDiagnostics({ source: "bills", loading, userId: user?.id });
  useEffect(() => { if (!loading && !user) navigate({ to: "/welcome" }); }, [loading, user, navigate]);
  const total = useMemo(() => ITEMS[tab].reduce((sum, item) => sum + item.amount, 0), [tab]);
  if (loading || !user) return null;

  async function savePlan() {
    setSaving(true);
    try {
      await Promise.all(ITEMS[tab].map((item, index) => upsert({ data: { name: item.name, amount_usd: item.amount, cadence: item.cadence === "Weekly" ? "weekly" : "monthly", due_day: item.due, priority: (index + 1) * 100, category: tab.toLowerCase() } })));
      toast.success(`${tab} plan saved`);
      navigate({ to: "/welcome/ready" });
    } catch (error) { toast.error(error instanceof Error ? error.message : "Could not save plan."); }
    finally { setSaving(false); }
  }

  return <div className="flex flex-1 flex-col pb-3 pt-3">
    <div className="welcome-lifemap-header flex items-center gap-3 rounded-[24px] px-4 py-3">
      <span className="welcome-wallet-icon flex h-12 w-12 items-center justify-center rounded-full"><Home className="h-6 w-6 text-purple-400"/></span>
      <strong className="font-display text-xl">Life Map</strong>
    </div>
    <h1 className="mt-7 font-display text-[27px] font-bold">Build your monthly plan</h1>
    <p className="mt-2 text-sm text-purple-200/70">Add what matters now. You can update it anytime.</p>
    <div className="welcome-tabs mt-5 grid grid-cols-4 overflow-hidden rounded-[22px]">
      {TABS.map(({id,icon:Icon}) => <button key={id} type="button" onClick={() => {setTab(id);setAdding(false);}} className={`flex flex-col items-center gap-2 px-1 py-4 text-[11px] ${tab===id ? "welcome-tab-active text-purple-300" : "text-purple-200/60"}`}><Icon className="h-6 w-6"/><span>{id}</span></button>)}
    </div>
    <div className="mt-4 space-y-3">
      {ITEMS[tab].map(({name,amount,cadence,due,icon:Icon}) => <div key={name} className="welcome-bill-card flex items-center gap-3 rounded-[24px] px-4 py-4">
        <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full border border-purple-400/70 text-purple-300"><Icon className="h-6 w-6"/></span>
        <span className="min-w-0 flex-1"><strong className="block text-[15px]">{name}</strong><span className="text-xs text-purple-200/65">{cadence}{due ? ` · Due ${due}` : ""}</span></span>
        <strong className="text-[17px]">${amount.toLocaleString()}</strong><ChevronRight className="h-5 w-5 text-purple-400"/>
      </div>)}
    </div>
    {adding ? <div className="welcome-inset-panel mt-4 rounded-[22px] p-4"><BillForm compact initial={{category:tab.toLowerCase()}} onSaved={() => {setAdding(false);toast.success("Item added");}} onCancel={() => setAdding(false)}/></div> :
      <button type="button" onClick={() => setAdding(true)} className="welcome-add-item mt-4 flex h-14 items-center justify-center gap-2 rounded-[20px] text-purple-300"><Plus className="h-5 w-5"/>Add item</button>}
    <div className="welcome-total-card mt-5 rounded-[24px] p-4">
      <div className="flex items-center justify-between"><span className="text-xs uppercase tracking-[.18em] text-purple-200/55">{tab} total</span><strong className="text-2xl">${total.toLocaleString()}</strong></div>
      <button type="button" onClick={savePlan} disabled={saving} className="welcome-primary-action mt-4 flex h-14 w-full items-center justify-center font-semibold disabled:opacity-50">{saving ? "Saving…" : "Save plan"}</button>
    </div>
  </div>;
}
