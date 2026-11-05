import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { z } from "zod";
import type { SynRecovery } from "./recoveryWallet";
import { assertLegacyExecutionDisabled } from "@/lib/quorumark-mvp-policy.server";
export type SynSnapshot = {
  chain_id: 8453;
  owner_address: string;
  safe_address: string;
  module_address: string;
  operator_address: string;
  module_enabled: boolean;
  operator_exit_available: boolean;
  live_entry_allowed: boolean;
  session_valid_until: number;
  timestamp: number;
  observed_block: string;
  block_hash: string;
  positions: Record<
    "BTC-USDC" | "ETH-USDC",
    { signed_size: string; balance: string; entry_notional: string; mark: string }
  >;
};
const scope = { connectionId: z.string().uuid() };
const symbol = z.enum(["BTC-USDC", "ETH-USDC"]);
const phase = z.enum(["enable_module", "authorize_owner_exit", "close_position"]);
const input = z.discriminatedUnion("operation", [
  z.object({ ...scope, operation: z.literal("positions") }).strict(),
  z
    .object({
      ...scope,
      operation: z.literal("owner-recovery"),
      symbol,
      slippage_bps: z.number().int().min(1).max(1000),
    })
    .strict(),
  z
    .object({
      ...scope,
      operation: z.literal("owner-recovery-status"),
      symbol,
      phase,
      tx_hash: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
      calldata_hash: z.string().regex(/^0x[0-9a-f]{64}$/),
    })
    .strict(),
]);
export type SynLifecycleInput = z.infer<typeof input>;
export type SynLifecycleResult = {
  status: string;
  snapshot?: SynSnapshot;
  recovery?: SynRecovery;
  phase?: SynRecovery["phase"];
  reconciliation_required?: boolean;
};
export const synFuturesLifecycle = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((value: unknown) => input.parse(value))
  .handler(async ({ data }): Promise<SynLifecycleResult> => {
    assertLegacyExecutionDisabled("synfutures-lifecycle");
    const { getRequest } = await import("@tanstack/react-start/server");
    const authorization = getRequest().headers.get("authorization");
    const base = process.env.TURTLE_BROKER_BASE_URL?.trim().replace(/\/$/, "");
    if (!authorization || !base)
      throw new Error("SynFutures account monitor is unavailable. Retry shortly.");
    const { connectionId, operation, ...fields } = data;
    try {
      const response = await fetch(`${base}/v1/synfutures/${operation}`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization },
        body: JSON.stringify({ connection_id: connectionId, ...fields }),
        signal: AbortSignal.timeout(45_000),
        redirect: "error",
      });
      if (!response.ok) throw new Error("read failed");
      return (await response.json()) as SynLifecycleResult;
    } catch {
      throw new Error("SynFutures account read could not be verified. Refresh before proceeding.");
    }
  });
