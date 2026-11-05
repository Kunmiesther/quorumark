import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import type { ActivationPolicy, ActivationScope, ActivationStep } from "./activation";
import { assertLegacyExecutionDisabled } from "@/lib/quorumark-mvp-policy.server";
const amount = z.string().regex(/^(?:0|[1-9]\d{0,3})(?:\.\d{1,6})?$/);
const policy = z
  .object({
    marginUsdc: amount,
    sessionBudgetUsdc: amount,
    takeProfitBps: z.number().int().min(1).max(9999),
    lossLimitUsdc: amount,
    maxDailyEntries: z.number().int().min(1).max(100),
    acceptMonitoredExits: z.literal(true),
  })
  .strict();
const input = z.discriminatedUnion("operation", [
  z.object({ walletId: z.string().uuid(), operation: z.literal("plan"), policy }).strict(),
  z.object({ walletId: z.string().uuid(), operation: z.literal("finish"), policy }).strict(),
  z
    .object({
      walletId: z.string().uuid(),
      operation: z.literal("receipt"),
      txHash: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
      step: z.unknown(),
    })
    .strict(),
]);
export type ActivationResult = {
  status: "step" | "ready" | "active" | "unknown" | "mined" | "reverted";
  scope: ActivationScope;
  step?: ActivationStep;
};
export const synFuturesActivation = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((value: unknown) => input.parse(value))
  .handler(async ({ data, context: { supabase, userId } }): Promise<ActivationResult> => {
    assertLegacyExecutionDisabled("synfutures-activation");
    const role = await supabase.rpc("has_role", { _user_id: userId, _role: "admin" });
    if (role.error || role.data !== true) throw new Error("Owner activation required");
    const registration = await supabase
      .from("synfutures_account_registrations")
      .select("id,owner_address,safe_address,module_address,wallet_id")
      .eq("user_id", userId)
      .eq("wallet_id", data.walletId)
      .maybeSingle();
    const saved = registration.data;
    if (registration.error || !saved) throw new Error("Registered account required");
    const wallet = await supabase
      .from("wallet_connections")
      .select("public_address")
      .eq("id", data.walletId)
      .eq("user_id", userId)
      .eq("status", "verified")
      .eq("is_active", true)
      .maybeSingle();
    if (wallet.error || wallet.data?.public_address.toLowerCase() !== saved.owner_address)
      throw new Error("Verified owner wallet required");
    let binding: { user_id: string; address: string };
    try {
      binding = JSON.parse(process.env.SYNFUTURES_OPERATOR_ADDRESSES ?? "{}")[saved.id];
      if (binding?.user_id !== userId || !/^0x[0-9a-f]{40}$/i.test(binding.address))
        throw new Error();
    } catch {
      throw new Error("Operator setup is unavailable for this account");
    }
    const scope = {
      owner: saved.owner_address,
      safe: saved.safe_address,
      module: saved.module_address,
      operator: binding.address,
    };
    const { activationPlan, activationReceipt, finishActivation } =
      await import("./activation.server");
    if (data.operation === "receipt")
      return {
        scope,
        status: await activationReceipt(data.txHash, data.step as ActivationStep, scope),
      };
    if (data.operation === "finish") {
      await finishActivation({
        userId,
        connectionId: saved.id,
        walletId: data.walletId,
        scope,
        policy: data.policy,
      });
      return { scope, status: "active" };
    }
    const step = await activationPlan({
      userId,
      connectionId: saved.id,
      walletId: data.walletId,
      scope,
      policy: data.policy,
    });
    return { scope, status: step ? "step" : "ready", ...(step ? { step } : {}) };
  });
