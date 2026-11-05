/**
 * BYDFi connection state machine (pure).
 *
 * States:
 *   NOT_CONNECTED         — no credentials on file
 *   VERIFYING             — handshake in progress
 *   CONNECTED_READ_ONLY   — authenticated read succeeded; capabilities not yet confirmed
 *   CAPABILITIES_VERIFIED — full capability handshake succeeded and cached
 *   DEGRADED              — was verified, currently intermittent (rate limit, transient HTTP)
 *   EXPIRED               — verified data past its expires_at
 *   REJECTED              — hard credential failure (invalid, signature rejected, permission denied)
 *
 * A connection is trade-ready ONLY in CAPABILITIES_VERIFIED. `auth_ok` alone
 * is never trade-ready — matches the launch requirement.
 */

import type { BydfiErrorCode } from "./errors";

export type BydfiConnectionState =
  | "NOT_CONNECTED"
  | "VERIFYING"
  | "CONNECTED_READ_ONLY"
  | "CAPABILITIES_VERIFIED"
  | "DEGRADED"
  | "EXPIRED"
  | "REJECTED";

export interface BydfiStateInput {
  hasCredentials: boolean;
  handshake: null | {
    authOk: boolean;
    capabilitiesOk: boolean;
    verifiedAt: number | null;
    expiresAt: number | null;
    lastErrorCode: BydfiErrorCode | null;
    inFlight: boolean;
  };
  now: number;
}

const REJECTING_ERRORS: readonly BydfiErrorCode[] = [
  "invalid_credentials",
  "signature_rejected",
  "permission_denied",
  "withdrawal_permission_present",
];

export function computeBydfiState(input: BydfiStateInput): BydfiConnectionState {
  if (!input.hasCredentials) return "NOT_CONNECTED";
  const h = input.handshake;
  if (!h) return "VERIFYING";
  if (h.inFlight) return "VERIFYING";
  if (h.lastErrorCode && REJECTING_ERRORS.includes(h.lastErrorCode)) return "REJECTED";
  if (h.capabilitiesOk && h.verifiedAt) {
    if (h.expiresAt && input.now > h.expiresAt) return "EXPIRED";
    if (h.lastErrorCode === "rate_limited" || h.lastErrorCode === "network_timeout" || h.lastErrorCode === "http_error") {
      return "DEGRADED";
    }
    return "CAPABILITIES_VERIFIED";
  }
  if (h.authOk) return "CONNECTED_READ_ONLY";
  return "VERIFYING";
}

/** A connection may participate in the eligible universe / order path only here. */
export function isBydfiTradeReady(state: BydfiConnectionState): boolean {
  return state === "CAPABILITIES_VERIFIED";
}
