import { createServerFn } from "@tanstack/react-start";

type BrokerFlags = {
  reads: boolean;
  signer: boolean;
  canary: boolean;
  automation: boolean;
  capital: boolean;
};

export type ExecutionRuntimeHealth = {
  configured: boolean;
  brokerReachable: boolean;
  signerReachable: boolean;
  flags: BrokerFlags;
  manualTradingReady: boolean;
  automationTradingReady: boolean;
  automationVenues?: Record<string, boolean>;
  capitalFlowReady: boolean;
  checkedAt: string;
  reason: string;
};

const EMPTY_FLAGS: BrokerFlags = {
  reads: false,
  signer: false,
  canary: false,
  automation: false,
  capital: false,
};

async function readJson(
  url: string,
  timeoutMs = 4_000,
): Promise<{
  ok: boolean;
  status: number;
  body: Record<string, unknown> | null;
}> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      headers: { accept: "application/json" },
      cache: "no-store",
      signal: controller.signal,
    });
    let body: Record<string, unknown> | null = null;
    try {
      const parsed: unknown = await response.json();
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        body = parsed as Record<string, unknown>;
      }
    } catch {
      body = null;
    }
    return { ok: response.ok, status: response.status, body };
  } catch {
    return { ok: false, status: 0, body: null };
  } finally {
    clearTimeout(timer);
  }
}

function readFlags(value: unknown): BrokerFlags {
  const flags = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  return {
    reads: flags.reads === true,
    signer: flags.signer === true,
    canary: flags.canary === true,
    automation: flags.automation === true,
    capital: flags.capital === true,
  };
}

/**
 * Server-side live execution probe.
 *
 * This is deliberately separate from the Railway market worker heartbeat.
 * A healthy scanner is not proof that the public broker can reach the private
 * signer, and neither fact proves that an automated order endpoint exists.
 */
export const getExecutionRuntimeHealth = createServerFn({ method: "GET" }).handler(
  async (): Promise<ExecutionRuntimeHealth> => {
    const checkedAt = new Date().toISOString();
    const base = process.env["TURTLE_BROKER_BASE_URL"]?.trim().replace(/\/$/, "");
    if (!base) {
      return {
        configured: false,
        brokerReachable: false,
        signerReachable: false,
        flags: EMPTY_FLAGS,
        manualTradingReady: false,
        automationTradingReady: false,
        automationVenues: { apex_omni: false, aster: false },
        capitalFlowReady: false,
        checkedAt,
        reason: "TURTLE_BROKER_BASE_URL is not configured.",
      };
    }

    const [health, ready, automation] = await Promise.all([
      readJson(`${base}/healthz`),
      readJson(`${base}/readyz`),
      // A 404 is meaningful: the broker is alive, but the worker-safe
      // automation transport has not been deployed. Never infer automation
      // readiness from a feature flag alone.
      readJson(`${base}/v1/automation/capabilities`),
    ]);
    const flags = readFlags(health.body?.flags);
    const brokerReachable = health.ok && health.body?.ok === true;
    const signerReachable = ready.ok && ready.body?.ok === true && ready.body?.signer === "ok";
    const automationRouteAccepting =
      automation.ok && automation.body?.ok === true && automation.body?.accepting_orders === true;
    const fiveRungSupported =
      Array.isArray(automation.body?.supported_campaign_rung_counts) &&
      automation.body.supported_campaign_rung_counts.includes(5);
    // The user-defined live strategy is five rungs. A one-order transport is
    // not a ready automated execution path for that strategy.
    const automationEndpoint = automationRouteAccepting && fiveRungSupported;
    const manualTradingReady = brokerReachable && signerReachable && flags.signer && flags.canary;
    const apexAutomationReady = manualTradingReady && flags.automation && automationEndpoint &&
      (automation.body?.venues as Record<string, unknown> | undefined)?.apex_omni === true;
    const venueFlags = automation.body?.venues as Record<string, unknown> | undefined;
    const automationVenues = {
      apex_omni: apexAutomationReady,
      aster: brokerReachable && signerReachable && automation.ok &&
        automation.body?.ok === true && fiveRungSupported &&
        venueFlags?.aster === true && ready.body?.aster_automation_enabled === true,
    };
    const automationTradingReady = Object.values(automationVenues).some(Boolean);
    const capitalFlowReady = brokerReachable && signerReachable && flags.signer && flags.capital;

    let reason = "Execution broker and private signer are ready.";
    if (!brokerReachable) reason = "The public execution broker is unreachable.";
    else if (!signerReachable) reason = "The execution broker cannot reach the private signer.";
    else if (automationTradingReady) reason = "At least one authenticated automation venue is ready; account and strategy checks still apply.";
    else if (!flags.signer) reason = "The mainnet signer gate is disabled.";
    else if (!flags.canary) reason = "The owner-only mainnet canary gate is disabled.";
    else if (!automationRouteAccepting)
      reason = "Manual live trading is ready; the automation route is not accepting orders.";
    else if (!fiveRungSupported)
      reason = "Manual live trading is ready; five-rung automated execution is not supported yet.";
    else if (!flags.automation)
      reason = "Manual live trading is ready; automated execution is disabled.";

    return {
      configured: true,
      brokerReachable,
      signerReachable,
      flags,
      manualTradingReady,
      automationTradingReady,
      automationVenues,
      capitalFlowReady,
      checkedAt,
      reason,
    };
  },
);
