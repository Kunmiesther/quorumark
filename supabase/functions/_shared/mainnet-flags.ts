// ApeX mainnet feature flags — SERVER-ONLY.
//
// These are read from Deno.env inside edge functions and NEVER returned to
// the browser. The client cannot flip them. Order execution paths must
// consult these at request time; a stale cached value must never enable
// a disabled flag.
//
// Defaults: every flag is FALSE unless explicitly set to "true" (string) in
// the environment. Any other value (including "1", "yes", "TRUE" etc.) is
// treated as false to force explicit, unambiguous enablement.

export type ApexMainnetFlag =
  | "APEX_MAINNET_READS_ENABLED"
  | "APEX_MAINNET_SIGNER_ENABLED"
  | "APEX_MAINNET_CANARY_ENABLED"
  | "APEX_MAINNET_AUTOMATION_ENABLED"
  | "APEX_MAINNET_COMPLIANCE_APPROVED";

type DenoEnvironment = {
  env: { get: (name: string) => string | undefined };
};

export function readFlag(name: ApexMainnetFlag): boolean {
  const deno = (globalThis as typeof globalThis & { Deno?: DenoEnvironment }).Deno;
  const raw = deno?.env.get(name);
  return raw === "true";
}

export interface MainnetFlagSnapshot {
  reads: boolean;
  signer: boolean;
  canary: boolean;
  automation: boolean;
  complianceApproved: boolean;
}

export function readAllFlags(): MainnetFlagSnapshot {
  return {
    reads: readFlag("APEX_MAINNET_READS_ENABLED"),
    signer: readFlag("APEX_MAINNET_SIGNER_ENABLED"),
    canary: readFlag("APEX_MAINNET_CANARY_ENABLED"),
    automation: readFlag("APEX_MAINNET_AUTOMATION_ENABLED"),
    complianceApproved: readFlag("APEX_MAINNET_COMPLIANCE_APPROVED"),
  };
}

/**
 * Anything mutating on ApeX mainnet (create / cancel / close) requires BOTH
 * the signer flag AND the canary flag. Automation on top additionally
 * requires the automation flag. Reads are gated separately.
 *
 * NOTE: This is one of TWO independent gates. `proof-gate.ts` and the
 * per-user `user_trading_limits` row still apply. A `true` here means
 * "the plant switch is on"; it does NOT mean any specific order is allowed.
 */
export function canSubmitMainnetOrder(flags: MainnetFlagSnapshot): boolean {
  return flags.complianceApproved && flags.signer && flags.canary;
}

export function canAutomateMainnet(flags: MainnetFlagSnapshot): boolean {
  return (
    flags.complianceApproved && flags.signer && flags.canary && flags.automation
  );
}
