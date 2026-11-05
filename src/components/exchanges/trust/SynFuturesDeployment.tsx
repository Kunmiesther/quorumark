import { useEffect, useRef, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { inspectSynFuturesDeployment } from "@/lib/exchanges/synfutures/deployment.functions";
import type { SynDeploymentPlan } from "@/lib/exchanges/synfutures/deployment";
import {
  readPendingDeployment,
  deploymentPendingResolved,
  type PendingDeployment,
} from "@/lib/exchanges/synfutures/deploymentRecovery";

export function SynFuturesDeployment({
  userId,
  walletId,
  provider,
  owner,
}: {
  userId: string;
  walletId: string;
  provider: string;
  owner: string;
}) {
  const [plan, setPlan] = useState<SynDeploymentPlan | null>(null);
  const [pending, setPending] = useState<PendingDeployment | null>(null);
  const [storageReady, setStorageReady] = useState(false);
  const [storageError, setStorageError] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const mounted = useRef(true);
  const wrotePending = useRef(false);
  const key = `turtlebot:syn-deploy:v1:${userId}:${walletId}`;
  useEffect(() => {
    mounted.current = true;
    try {
      const raw = localStorage.getItem(key);
      setPending(readPendingDeployment(raw));
      setStorageReady(true);
    } catch {
      setStorageError(true);
    }
    return () => {
      mounted.current = false;
    };
  }, [key]);
  const check = useMutation({
    mutationFn: async () => {
      const pendingRaw = localStorage.getItem(key);
      const savedPending = readPendingDeployment(pendingRaw);
      const { data } = await supabase.auth.getSession();
      if (!data.session) throw new Error("Sign in to check deployment.");
      const value = await inspectSynFuturesDeployment({
        data: {
          walletId,
          ...(savedPending?.hash
            ? {
                pending: { stage: savedPending.stage, hash: savedPending.hash },
              }
            : {}),
        },
        headers: { Authorization: `Bearer ${data.session.access_token}` },
      });
      return { value, pendingRaw, savedPending };
    },
    onSuccess: async ({ value, pendingRaw, savedPending }) => {
      if (!mounted.current) return;
      setPlan(value);
      setConfirmed(false);
      if (savedPending && deploymentPendingResolved(value, savedPending)) {
        try {
          if (!navigator.locks) throw new Error("Wallet transaction locking unavailable.");
          await navigator.locks.request(key, { ifAvailable: true }, async (lock) => {
            // A stale read must not erase another tab's newer wallet submission.
            if (!lock || !mounted.current || localStorage.getItem(key) !== pendingRaw) return;
            localStorage.removeItem(key);
            setPending(null);
          });
        } catch {
          setStorageError(true);
        }
      }
    },
  });
  const submit = useMutation({
    mutationFn: async () => {
      wrotePending.current = false;
      if (
        !plan ||
        !confirmed ||
        pending ||
        !storageReady ||
        storageError ||
        plan.stage === "deployed"
      )
        throw new Error("Refresh and confirm the deployment review first.");
      const [{ getTransactionProvider }, { submitSynDeployment }] = await Promise.all([
        import("@/lib/wallet/providers"),
        import("@/lib/exchanges/synfutures/deploymentWallet"),
      ]);
      const stage = plan.stage;
      if (!navigator.locks) throw new Error("Use a browser supporting wallet transaction locking.");
      return navigator.locks.request(key, { ifAvailable: true }, async (lock) => {
        if (!lock || localStorage.getItem(key))
          throw new Error(
            "A deployment is already pending. Check wallet activity and refresh its status.",
          );
        const wallet = await getTransactionProvider(provider);
        const hash = await submitSynDeployment(
          wallet,
          plan,
          owner,
          () => {
            localStorage.setItem(key, JSON.stringify({ stage }));
            wrotePending.current = true;
            setPending({ stage });
          },
          () => mounted.current,
        );
        localStorage.setItem(key, JSON.stringify({ stage, hash }));
        if (mounted.current) setPending({ stage, hash });
        return hash;
      });
    },
    onError: (error) => {
      if (wrotePending.current && (error as { definitelyNotSent?: boolean }).definitelyNotSent) {
        try {
          localStorage.removeItem(key);
          setPending(null);
        } catch {
          setStorageError(true);
        }
      }
    },
  });
  return (
    <div className="mt-4 border-t border-white/10 pt-3">
      <h3 className="text-sm font-medium text-cyan-200">Owner wallet deployment · Base</h3>
      <p className="mt-2 text-xs leading-5 text-white/55">
        Create an empty, owner-controlled Safe, then deploy its restricted trading module. These two
        wallet transactions cost Base ETH gas. They do not approve USDC, deposit your allocation,
        enable the module, or start trading.
      </p>
      <button
        type="button"
        disabled={check.isPending || submit.isPending}
        onClick={() => check.mutate()}
        className="tb-neu-raised mt-2 rounded-xl px-3 py-2 text-xs text-white/65 disabled:opacity-50"
      >
        {check.isPending ? "Verifying Base contracts…" : "Check wallet deployment"}
      </button>
      {check.isError ? (
        <p role="alert" className="mt-2 text-xs text-amber-200">
          {check.error.message}
        </p>
      ) : null}
      {plan ? (
        <div className="mt-3 space-y-2 text-xs">
          <p className="break-all text-white/65">Owner: {plan.owner}</p>
          <p className="break-all text-white/65">Trading account: {plan.safe}</p>
          <p className="break-all text-white/65">Module: {plan.module}</p>
          <p role="status" className="text-cyan-200">
            {plan.stage === "deployed"
              ? "Both contracts verified · trading not activated"
              : plan.stage === "deploy_safe"
                ? "Step 1 of 2 · trading account not deployed"
                : "Step 2 of 2 · account verified; deploy module"}
          </p>
          {plan.pendingObservation?.status === "reverted" && !pending ? (
            <p role="status" className="text-amber-200">
              The previous deployment reverted on Base. Nothing was deployed by that transaction.
              Review again to retry; another wallet approval is required.
            </p>
          ) : null}
          {plan.transaction && !pending ? (
            <>
              <label className="flex items-start gap-2 text-white/65">
                <input
                  type="checkbox"
                  checked={confirmed}
                  onChange={(event) => setConfirmed(event.target.checked)}
                  disabled={submit.isPending}
                />
                <span>
                  I reviewed the owner and account above. This deploys empty contracts only and
                  requires my wallet approval and Base gas.
                </span>
              </label>
              <button
                type="button"
                disabled={
                  !confirmed || submit.isPending || check.isPending || !storageReady || storageError
                }
                onClick={() => submit.mutate()}
                className="tb-neu-raised rounded-xl px-4 py-2 text-xs text-violet-200 disabled:opacity-50"
              >
                {submit.isPending
                  ? "Waiting for your wallet…"
                  : plan.stage === "deploy_safe"
                    ? "Review account deployment in wallet"
                    : "Review module deployment in wallet"}
              </button>
            </>
          ) : null}
        </div>
      ) : null}
      {pending ? (
        <p role="status" className="mt-2 break-words text-xs text-amber-200">
          Deployment awaiting verification. Do not send again.{" "}
          {pending.hash ? (
            <a
              className="underline"
              href={`https://basescan.org/tx/${pending.hash}`}
              target="_blank"
              rel="noreferrer"
            >
              View transaction
            </a>
          ) : (
            "Check your wallet activity for the transaction hash."
          )}{" "}
          Use “Check wallet deployment” after confirmation.
        </p>
      ) : null}
      {storageError ? (
        <p role="alert" className="mt-2 text-xs text-amber-200">
          Pending transaction storage is unavailable. Deployment is disabled to avoid duplicate
          submissions. Check wallet activity.
        </p>
      ) : null}
      {submit.isError ? (
        <p role="alert" className="mt-2 text-xs text-amber-200">
          {submit.error.message}
        </p>
      ) : null}
      <p className="mt-2 text-xs leading-5 text-white/55">
        Funding and trading permission are separate steps. Execution, protective exits, and module
        security review must be completed before activation.
      </p>
    </div>
  );
}
