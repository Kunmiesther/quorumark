// Centralized presentation-label formatter.
// Converts internal codes, enums, and snake_case field names into
// natural-language labels for customer-facing UI. Raw backend values are
// unchanged — this is presentation-only.

const EVENT_LABELS: Record<string, string> = {
  SIGNAL_EVALUATION: "Strategy Signal",
  ACTIVE_CONFIG_READ: "Configuration Check",
  EXECUTION_GUARD_READ: "Safety Check",
  HEARTBEAT_UPSERT: "System Heartbeat",
  BOT_EVENT_INSERT: "Activity Recorded",
  ORDER_INTENT_RESULT: "Order Intent",
  ORDER_INTENT: "Order Intent",
  WORKER_HEARTBEAT: "System Heartbeat",
  KILL_SWITCH: "Safety Halt",
};

const VENUE_LABELS: Record<string, string> = {
  apex_omni: "ApeX Omni",
  apex_omni_testnet: "ApeX Omni (Testnet)",
  apex: "ApeX",
  hyperliquid: "Hyperliquid",
  aster: "Aster",
  synfutures: "SynFutures",
  btcc: "BTCC",
  bitget: "Bitget",
  coinbase: "Coinbase",
  phantom: "Phantom",
  walletconnect: "WalletConnect",
};

const STATUS_LABELS: Record<string, string> = {
  evaluated: "Evaluated",
  skipped: "Skipped",
  error: "Error",
  pending: "Waiting",
  pending_verification: "Pending Verification",
  confirmed: "Confirmed",
  expired_window: "Retest Window Expired",
  expired_breach: "Setup Invalidated",
  expired: "Expired",
  invalidated: "Setup Invalidated",
  rejected: "Rejected",
  watching: "Watching",
  retest: "Retest",
  triggered: "Triggered",
  entry: "Entry",
  active: "Active",
  disconnected: "Disconnected",
  revoked: "Revoked",
  long: "Long",
  short: "Short",
  candidate: "Candidate",
  live: "Live",
  paper: "Paper",
  test: "Testnet",
  mainnet: "Mainnet",
  production: "Live",
  spot: "Spot",
  perp: "Perpetuals",
  perpetuals: "Perpetuals",
  futures: "Futures",
  waiting: "Waiting",
  passed: "Passed",
  blocked: "Blocked",
  failed: "Failed",
  idle: "Idle",
  execution_performed: "Trade Executed",
  reason_code: "Reason",
  newest_completed_candle_ts_ms: "Signal Candle",
  observation_id: "Signal ID",
  permission_trade: "Trading Permission",
  permission_read: "Read Permission",
  permissions_verified: "Permissions Verified",
  withdrawals_disabled: "Withdrawals Disabled",
};

const FIELD_LABELS: Record<string, string> = {
  execution_performed: "Trade Executed",
  reason_code: "Reason",
  newest_completed_candle_ts_ms: "Signal Candle",
  observation_id: "Signal ID",
  permission_trade: "Trading Permission",
  permission_read: "Read Permission",
  permissions_verified: "Permissions Verified",
  withdrawals_disabled: "Withdrawals Disabled",
  last_verified_at: "Last Verified",
  last_health_check_at: "Last Health Check",
  short_summary: "Summary",
  long_summary: "Summary",
  interval_min: "Interval",
  candle_count: "Candles",
  swing_count: "Swings",
  break_count: "Breaks",
  retest_count: "Retests",
  entry_count: "Entries",
  age_sec: "Age",
  stop_loss: "Stop",
  take_profit: "Targets",
  entry_low: "Entry Low",
  entry_high: "Entry High",
};

/** Titlecase a snake_case or SCREAMING_SNAKE identifier as a fallback. */
function titleCaseFromSnake(raw: string): string {
  return raw
    .toLowerCase()
    .split(/[_\s]+/)
    .filter(Boolean)
    .map((w) => w[0]?.toUpperCase() + w.slice(1))
    .join(" ");
}

/** Convert an event name (SCREAMING_SNAKE) to a human label. */
export function eventLabel(raw: string | null | undefined): string {
  if (!raw) return "Event";
  return EVENT_LABELS[raw] ?? titleCaseFromSnake(raw);
}

/** Convert a venue id ("apex_omni") to its brand label. */
export function venueDisplayLabel(raw: string | null | undefined): string {
  if (!raw) return "—";
  const k = raw.toLowerCase();
  return VENUE_LABELS[k] ?? titleCaseFromSnake(k);
}

/** Convert a status enum value to plain English. */
export function statusLabel(raw: string | null | undefined): string {
  if (raw == null || raw === "") return "—";
  const k = String(raw).toLowerCase();
  return STATUS_LABELS[k] ?? titleCaseFromSnake(k);
}

/** Convert a DB column / detail field name to a friendly label. */
export function fieldLabel(raw: string | null | undefined): string {
  if (!raw) return "";
  return FIELD_LABELS[raw] ?? titleCaseFromSnake(raw);
}

/** Boolean → "Enabled"/"Disabled" style badge. */
export function boolLabel(
  v: boolean | null | undefined,
  opts: { on?: string; off?: string; unknown?: string } = {},
): string {
  const on = opts.on ?? "Enabled";
  const off = opts.off ?? "Disabled";
  const unknown = opts.unknown ?? "—";
  if (v === true) return on;
  if (v === false) return off;
  return unknown;
}

/** Format a ms epoch or ISO string as local date/time. */
export function formatLocalDateTime(input: number | string | null | undefined): string {
  if (input == null) return "—";
  const d = typeof input === "number" ? new Date(input) : new Date(input);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** Format a ms epoch or ISO string as UTC (for tooltips). */
export function formatUtc(input: number | string | null | undefined): string {
  if (input == null) return "—";
  const d = typeof input === "number" ? new Date(input) : new Date(input);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toISOString().replace("T", " ").slice(0, 16) + " UTC";
}

/** Format a relative "x seconds/minutes/hours ago". */
export function timeAgoShort(iso: string | null | undefined): string {
  if (!iso) return "never";
  const s = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

/** Guard user-visible strings against "undefined"/"null"/empty. */
export function safeText(v: unknown, fallback = "—"): string {
  if (v == null) return fallback;
  if (typeof v === "string") {
    const t = v.trim();
    if (!t || t === "undefined" || t === "null") return fallback;
    return t;
  }
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return fallback;
}
