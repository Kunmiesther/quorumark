/**
 * Execution status — the single derivation for the status chip.
 *
 * Pure functions only. Never depends on frontend toggles or UI state.
 * Callers must feed values sourced from the backend (user_strategy,
 * exchange_connections, apex_execution_credentials). `hasSigningCredential`
 * must be derived from an active, non-revoked mainnet credential row —
 * never from a local UI flag or the retired run-live-proof artifact.
 */

export type ExecutionStatus =
  | "setup"
  | "paper"
  | "mainnet_locked"
  | "live_routing_off"
  | "mainnet_active"
  | "needs_attention";

export interface ExecutionStatusInput {
  hasVerifiedConnection: boolean;
  hasMainnetConnection: boolean;
  hasSigningCredential: boolean;
  permissionsVerified?: boolean;
  hasRestCredentials?: boolean;
  hasAccountRegistered?: boolean;
  enabled: boolean;
  mode: string | null;
  workerMode?: string | null;
  workerStatus?: string | null;
  workerFresh?: boolean;
}

export interface ExecutionStatusResult {
  status: ExecutionStatus;
  label: string;
  description: string;
  tone: "neutral" | "positive" | "warning";
}

export function deriveExecutionStatus(i: ExecutionStatusInput): ExecutionStatus {
  if (!i.hasVerifiedConnection) return "setup";
  const isLiveMode = i.mode === "live" || i.mode === "mainnet";
  if (i.permissionsVerified === false || i.hasRestCredentials === false || i.hasAccountRegistered === false) {
    return "needs_attention";
  }
  if (i.hasSigningCredential && i.enabled && isLiveMode) return "mainnet_active";
  if (i.hasSigningCredential && i.hasMainnetConnection) return "live_routing_off";
  if (i.hasMainnetConnection) return "mainnet_locked";
  return "paper";
}

/**
 * Human-facing status meta. `mainnet_locked` and `live_routing_off`
 * descriptions are computed dynamically so the badge names the exact
 * missing item (verified connection, signing credential, or strategy mode).
 */
export function describeExecutionStatus(i: ExecutionStatusInput): ExecutionStatusResult {
  const status = deriveExecutionStatus(i);
  switch (status) {
    case "setup":
      return {
        status,
        label: "Setup",
        description: "Connect a verified exchange to begin.",
        tone: "neutral",
      };
    case "paper":
      return {
        status,
        label: "Paper",
        description: "Simulated orders only — no real funds are at risk.",
        tone: "neutral",
      };
    case "mainnet_locked": {
      const description = !i.hasSigningCredential
        ? "No active signing credential. Activate MetaMask signing to enable live orders."
        : "Mainnet connection ready. Complete activation to enable live orders.";
      return { status, label: "Mainnet Locked", description, tone: "warning" };
    }
    case "needs_attention": {
      const description = i.hasRestCredentials === false
        ? "Stored ApeX API credentials are missing. Reconnect or replace keys."
        : i.hasAccountRegistered === false
          ? "ApeX account is not registered yet. Register it, then run proof-of-life."
          : "Connection is not verified yet. Run register/test once, then run proof-of-life.";
      return { status, label: "Needs Attention", description, tone: "warning" };
    }
    case "live_routing_off": {
      const isLiveMode = i.mode === "live" || i.mode === "mainnet";
      const description = !i.enabled
        ? "Signing credential ready. Strategy is paused — enable it to route live."
        : !isLiveMode
          ? "Signing credential ready. Strategy is in paper mode — switch to live to route."
          : "Signing credential ready. Live routing is off.";
      return { status, label: "Live Routing Off", description, tone: "warning" };
    }
    case "mainnet_active":
      return {
        status,
        label: "Mainnet Active",
        description: "Live execution authorized.",
        tone: "positive",
      };
  }
}

/**
 * Static label table kept for legacy callers/tests. Prefer describeExecutionStatus.
 */
export const STATUS_LABELS: Record<
  ExecutionStatus,
  { label: string; description: string; tone: "neutral" | "positive" | "warning" }
> = {
  setup: {
    label: "Setup",
    description: "Connect a verified exchange to begin.",
    tone: "neutral",
  },
  paper: {
    label: "Paper",
    description: "Simulated orders only — no real funds are at risk.",
    tone: "neutral",
  },
  mainnet_locked: {
    label: "Mainnet Locked",
    description: "No active signing credential. Activate MetaMask signing to enable live orders.",
    tone: "warning",
  },
  live_routing_off: {
    label: "Live Routing Off",
    description: "Signing credential ready. Enable live routing to execute.",
    tone: "warning",
  },
  mainnet_active: {
    label: "Mainnet Active",
    description: "Live execution authorized.",
    tone: "positive",
  },
  needs_attention: {
    label: "Needs Attention",
    description: "Connection is not verified yet. Run register/test once, then run proof-of-life.",
    tone: "warning",
  },
};
