import { useId, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { SynFuturesRegistration } from "./SynFuturesRegistration";
import {
  readSynFuturesSetup,
  saveSynFuturesSetup,
} from "@/lib/exchanges/synfutures/setup.functions";
import {
  setupMatchesInput,
  synFuturesSetupInput,
  type SynFuturesSetupDraft,
} from "@/lib/exchanges/synfutures/setup";

async function sessionHeaders() {
  const { data } = await supabase.auth.getSession();
  if (!data.session) throw new Error("Sign in to manage your SynFutures setup.");
  return { Authorization: `Bearer ${data.session.access_token}` };
}

export function SynFuturesSetupForm({ walletId, userId }: { walletId: string; userId: string }) {
  const client = useQueryClient();
  const key = ["synfutures-setup-draft", userId, walletId];
  const draft = useQuery({
    queryKey: key,
    queryFn: async () =>
      readSynFuturesSetup({ data: { walletId }, headers: await sessionHeaders() }),
    retry: false,
    refetchOnWindowFocus: false,
  });
  return (
    <div className="mt-4 border-t border-white/10 pt-3">
      <h3 className="text-sm font-medium text-cyan-200">Allocation &amp; leverage ceiling</h3>
      {draft.isPending ? (
        <p role="status" className="mt-2 text-xs text-white/60">
          Loading saved setup…
        </p>
      ) : null}
      {draft.isError ? (
        <p role="alert" className="mt-2 text-xs text-amber-200">
          Saved setup unavailable. Reload before making changes.
        </p>
      ) : null}
      {draft.isSuccess ? (
        <DraftFields
          key={`${userId}:${walletId}:${draft.data?.revision ?? 0}`}
          walletId={walletId}
          draft={draft.data}
          onSaved={(value) => client.setQueryData(key, value)}
        />
      ) : null}
      <button
        type="button"
        disabled={draft.isFetching}
        onClick={() => void draft.refetch()}
        className="tb-neu-raised mt-2 rounded-xl px-3 py-2 text-xs text-white/65 disabled:opacity-50"
      >
        Reload saved setup
      </button>
      {draft.isSuccess && draft.data ? (
        <SynFuturesRegistration
          key={`registration:${userId}:${walletId}:${draft.data.revision}`}
          userId={userId}
          walletId={walletId}
          revision={draft.data.revision}
        />
      ) : null}
    </div>
  );
}

function DraftFields({
  walletId,
  draft,
  onSaved,
}: {
  walletId: string;
  draft: SynFuturesSetupDraft | null;
  onSaved: (value: SynFuturesSetupDraft) => void;
}) {
  const id = useId();
  const [amount, setAmount] = useState(draft ? String(draft.allocation_usdc) : "");
  const [leverage, setLeverage] = useState(draft ? String(draft.max_leverage) : "");
  const input = synFuturesSetupInput.safeParse({
    walletId,
    allocationUsdc: amount,
    maxLeverage: Number(leverage),
    expectedRevision: draft?.revision ?? 0,
  });
  const saved = !!draft && setupMatchesInput(draft, amount, leverage);
  const save = useMutation({
    mutationFn: async () => {
      if (!input.success)
        throw new Error("Enter a positive USDC amount and a whole-number leverage ceiling.");
      return saveSynFuturesSetup({ data: input.data, headers: await sessionHeaders() });
    },
    onSuccess: onSaved,
  });
  return (
    <form
      className="mt-3 space-y-3"
      onSubmit={(event) => {
        event.preventDefault();
        if (input.success && !save.isPending) save.mutate();
      }}
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <label htmlFor={`${id}-allocation`} className="block text-xs text-white/65">
          Total allocation (USDC)
          <input
            id={`${id}-allocation`}
            inputMode="decimal"
            value={amount}
            disabled={save.isPending}
            onChange={(event) => setAmount(event.target.value)}
            placeholder="Enter allocation"
            className="tb-neu-inset mt-1 w-full rounded-xl bg-[#101118] px-3 py-2 text-xs text-white"
          />
        </label>
        <label htmlFor={`${id}-leverage`} className="block text-xs text-white/65">
          Maximum leverage (×)
          <input
            id={`${id}-leverage`}
            inputMode="numeric"
            value={leverage}
            disabled={save.isPending}
            onChange={(event) => setLeverage(event.target.value)}
            placeholder="Enter ceiling"
            className="tb-neu-inset mt-1 w-full rounded-xl bg-[#101118] px-3 py-2 text-xs text-white"
          />
        </label>
      </div>
      <p className="text-xs leading-5 text-white/55">
        Total intended capital, not margin per order. Leverage is a ceiling, not a target; each
        market’s supported limit must be checked before trading. Paper allocations stay unchanged.
      </p>
      <p role="status" className={`text-xs ${saved ? "text-cyan-200" : "text-white/60"}`}>
        {saved ? "Setup saved · wallet approval pending · not live" : "Unsaved setup · not live"}
      </p>
      {draft ? (
        <p className="text-[10px] text-white/45">
          Revision {draft.revision} · saved {new Date(draft.updated_at).toLocaleString()}
        </p>
      ) : null}
      {save.isError ? (
        <p role="alert" className="text-xs text-amber-200">
          {save.error.message}
        </p>
      ) : null}
      {!input.success && (amount || leverage) ? (
        <p className="text-xs text-amber-200">
          Enter a positive USDC amount (up to 6 decimals) and a valid whole-number leverage ceiling.
        </p>
      ) : null}
      <button
        type="submit"
        disabled={!input.success || save.isPending || saved}
        className="tb-neu-raised rounded-xl px-4 py-2 text-xs text-violet-200 disabled:opacity-50"
      >
        {save.isPending ? "Saving setup…" : "Save setup draft"}
      </button>
      <p className="text-xs leading-5 text-white/55">
        Saving does not approve tokens, deposit collateral, authorize a signer, or start trading.
      </p>
    </form>
  );
}
