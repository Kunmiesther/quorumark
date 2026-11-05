import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import {
  readSynFuturesRegistration,
  registerSynFuturesAccount,
} from "@/lib/exchanges/synfutures/registration.functions";

async function sessionHeaders() {
  const { data } = await supabase.auth.getSession();
  if (!data.session) throw new Error("Sign in to register your SynFutures account.");
  return { Authorization: `Bearer ${data.session.access_token}` };
}

export function SynFuturesRegistration({
  userId,
  walletId,
  revision,
}: {
  userId: string;
  walletId: string;
  revision: number;
}) {
  const client = useQueryClient();
  const key = ["synfutures-account-registration", userId, walletId, revision];
  const registration = useQuery({
    queryKey: key,
    queryFn: async () =>
      readSynFuturesRegistration({
        data: { walletId },
        headers: await sessionHeaders(),
      }),
    retry: false,
    refetchOnWindowFocus: false,
  });
  const register = useMutation({
    mutationFn: async () =>
      registerSynFuturesAccount({
        data: { walletId, expectedRevision: revision },
        headers: await sessionHeaders(),
      }),
    retry: false,
    onSuccess: (value) => client.setQueryData(key, value),
  });
  const current = registration.data?.setup_revision === revision;
  return (
    <div className="mt-4 border-t border-white/10 pt-3">
      <h3 className="text-sm font-medium text-cyan-200">Verified account registration</h3>
      <p role="status" className="mt-2 text-xs text-cyan-200">
        {registration.isPending
          ? "Loading registration…"
          : registration.isError
            ? "Registration status unavailable · not live"
            : current
              ? "Account registered · operator approval pending · not live"
              : registration.data
                ? "Saved setup changed · re-register this revision · not live"
                : "Account not registered · not live"}
      </p>
      {registration.data ? (
        <div className="mt-2 space-y-1 break-all text-xs text-white/60">
          <p>Trading account: {registration.data.safe_address}</p>
          <p>Module: {registration.data.module_address}</p>
          <p>Verified {new Date(registration.data.verified_at).toLocaleString()}</p>
        </div>
      ) : null}
      <button
        type="button"
        disabled={
          !registration.isSuccess || registration.isFetching || register.isPending || current
        }
        onClick={() => register.mutate()}
        className="tb-neu-raised mt-2 rounded-xl px-4 py-2 text-xs text-violet-200 disabled:opacity-50"
      >
        {register.isPending ? "Verifying and registering…" : "Register verified account"}
      </button>
      <button
        type="button"
        disabled={registration.isFetching || register.isPending}
        onClick={() => void registration.refetch()}
        className="tb-neu-raised mt-2 rounded-xl px-3 py-2 text-xs text-white/65 disabled:opacity-50"
      >
        Reload registration
      </button>
      {register.isError ? (
        <p role="alert" className="mt-2 text-xs text-amber-200">
          {register.error.message}
        </p>
      ) : null}
      <p className="mt-2 text-xs leading-5 text-white/55">
        Register after both contracts are deployed. This checks Base and saves their identity only.
        It does not approve a signer, enable the module, move funds, or start trading.
      </p>
    </div>
  );
}
