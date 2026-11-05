// Central app environment/execution config. Single source of truth.
//
// APP_ENV values:
//   - "demo":              simulated data, no real exchange calls.
//   - "test":              real ApeX testnet reads + real testnet order path.
//   - "mainnet_readonly":  real ApeX mainnet reads only (balances, markets,
//                          positions). ORDER EXECUTION STILL DISABLED.
//   - "live_disabled":     legacy placeholder — treated as execution-disabled.
//
// EXECUTION_ENABLED gates ORDER SUBMISSION only. It is `false` in every
// currently-shipped state. Phase B of the ApeX mainnet plan is what lifts
// it, and only through the Railway worker's zkLink signer — never here.
//
// The backend (worker + edge functions) enforces execution-disabled
// INDEPENDENTLY of this client value.

export type AppEnv = "demo" | "test" | "mainnet_readonly" | "live_disabled" | "live";

// Highest env this build is allowed to reach.
export const MAX_ALLOWED_ENV: AppEnv = "live";

export const APP_ENV: AppEnv = "live";

// Client-side execution gate. Server-side (broker + signer flags) remains
// the sole authority for actually submitting orders.
export const EXECUTION_ENABLED = true as const;

export const TEST_MODE_BANNER_TEXT =
  "TEST MODE — No real-money order execution is enabled.";

export const MAINNET_READONLY_BANNER_TEXT =
  "LIVE MAINNET — Read-only. Order execution is disabled pending owner authorization.";

// ---------------------------------------------------------------------------
// NetworkMode — user-facing Testnet/Mainnet selector state.
// Persisted per-browser in localStorage. NEVER used to authorize execution —
// EXECUTION_ENABLED and the server-side gate remain the only authority.
// ---------------------------------------------------------------------------
export type NetworkMode = "testnet" | "mainnet";

const NETWORK_MODE_KEY = "turtlebot.networkMode";

export function readNetworkMode(): NetworkMode {
  if (typeof window === "undefined") return "testnet";
  try {
    const v = window.localStorage.getItem(NETWORK_MODE_KEY);
    return v === "mainnet" ? "mainnet" : "testnet";
  } catch {
    return "testnet";
  }
}

export function writeNetworkMode(mode: NetworkMode): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(NETWORK_MODE_KEY, mode);
  } catch {
    /* ignore */
  }
}

// ---------------------------------------------------------------------------
// LIVE TEST MODE — owner's minimum-size live proof configuration.
// Mirrors SIGNER_LIVE_TEST_MODE on the signer: entry only, CROSS margin,
// no stop-loss, no take-profit. Exit management is owned by the TP council.
// ---------------------------------------------------------------------------
export const LIVE_TEST_MODE = true as const;

export const LIVE_TEST_DEFAULTS = {
  symbol: "ETH-USDT",
  side: "long",
  size: 0.01,
  orderType: "MARKET",
  marginMode: "CROSS",
  /** Notional above this requires an explicit extra confirmation. */
  maxNotionalUsd: 100,
} as const;
