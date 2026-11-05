/**
 * useApexPublicStream — live public market stream from ApeX Omni.
 *
 * READ-ONLY public data. No credentials, no private topics, no orders.
 *
 * Transport: wss://quote.omni.apex.exchange/realtime_public?v=2
 * Topics used per subscription:
 *   - `instrumentInfo.H.<RAWSYMBOL>`  → 24h ticker snapshot + last/mark/funding
 *   - `candle.<APEX_INTERVAL>.<RAWSYMBOL>` → kline updates (open bar streams)
 *
 * Semantics:
 *   - Single socket per hook mount. Symbol/interval swap tears the old socket
 *     down completely and stands a new one up. The teardown is hardened
 *     against ghost reconnects (see BUG A below).
 *   - Every ticker/candle setState is symbol-tagged and REJECTED if the frame
 *     did not originate from the current subscription. Consumers therefore
 *     never see BTC frames under an ETH header.
 *   - `state.symbol` carries the canonical RAW symbol for the state; callers
 *     that pass mark_price into a build path can and MUST verify it matches
 *     the symbol they are placing.
 *
 * BUG A (Ruling #6 root cause) — historic ghost reconnect:
 *   Old cleanup set `closedByUserRef.current = true`, closed the OLD socket,
 *   then the new effect body flipped the ref back to `false` before the OLD
 *   socket's onclose fired. The OLD onclose then read the flipped ref, called
 *   scheduleReconnect(), and re-established a subscription to the PREVIOUS
 *   symbol using its captured topic strings. Two sockets ran; the ghost
 *   silently overwrote shared state with frames for the old symbol.
 *   Fix: per-connection `alive` flag captured in the socket's closure. Once
 *   the connection is torn down (symbol/interval change or unmount), that
 *   specific socket's onclose/onmessage becomes a no-op even if the ref has
 *   moved on. Reconnect logic is also scoped to the connection generation.
 */
import { useEffect, useState } from "react";
import { INTERVAL_MS, type Candle, type Interval } from "./useCandles";

export type StreamStatus =
  | "connecting"
  | "live"
  | "reconnecting"
  | "stale"
  | "closed";

export interface TickerSnapshot {
  lastPrice: number | null;
  markPrice: number | null;
  indexPrice: number | null;
  high24h: number | null;
  low24h: number | null;
  volume24h: number | null;
  turnover24h: number | null;
  price24hPcnt: number | null;
  fundingRate: number | null;
  nextFundingTimeMs: number | null;
  receivedAt: number;
}

export interface StreamState {
  /** Canonical RAW symbol this state describes (e.g. "ETHUSDT"). */
  symbol: string | null;
  status: StreamStatus;
  lastTickAt: number | null;
  ticker: TickerSnapshot | null;
  latestCandle: Candle | null;
}

const WS_URL = "wss://quote.omni.apex.exchange/realtime_public?v=2";
const STALE_MS = 15_000;
const HEARTBEAT_MS = 15_000;
const MAX_BACKOFF_MS = 8_000;

const APEX_INTERVAL: Record<Interval, string> = {
  "1m": "1",
  "5m": "5",
  "15m": "15",
  "1h": "60",
  "4h": "240",
  "1d": "D",
};

export function toRawApexSymbol(symbol: string): string {
  return symbol.replace(/[-_/]/g, "").toUpperCase();
}

function num(v: unknown): number | null {
  if (v == null || v === "") return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

function parseTicker(prev: TickerSnapshot | null, data: unknown): TickerSnapshot | null {
  const payload = (data as { data?: unknown })?.data;
  const row = Array.isArray(payload) ? (payload[0] as Record<string, unknown> | undefined) : (payload as Record<string, unknown> | undefined);
  if (!row) return prev;
  const nextIso = typeof row.nextFundingTime === "string" ? (row.nextFundingTime as string) : null;
  const nextMs = nextIso ? Date.parse(nextIso) : NaN;
  const merged: TickerSnapshot = {
    lastPrice: num(row.lastPrice) ?? prev?.lastPrice ?? null,
    markPrice: num(row.markPrice) ?? prev?.markPrice ?? null,
    indexPrice: num(row.indexPrice) ?? prev?.indexPrice ?? null,
    high24h: num(row.highPrice24h) ?? prev?.high24h ?? null,
    low24h: num(row.lowPrice24h) ?? prev?.low24h ?? null,
    volume24h: num(row.volume24h) ?? prev?.volume24h ?? null,
    turnover24h: num(row.turnover24h) ?? prev?.turnover24h ?? null,
    price24hPcnt: num(row.price24hPcnt) ?? prev?.price24hPcnt ?? null,
    fundingRate: num(row.fundingRate) ?? prev?.fundingRate ?? null,
    nextFundingTimeMs: Number.isFinite(nextMs) ? nextMs : prev?.nextFundingTimeMs ?? null,
    receivedAt: Date.now(),
  };
  return merged;
}

function parseCandle(data: unknown, intervalMs: number): Candle | null {
  const payload = (data as { data?: unknown })?.data;
  const row = Array.isArray(payload) ? (payload[payload.length - 1] as Record<string, unknown> | undefined) : (payload as Record<string, unknown> | undefined);
  if (!row) return null;
  const t = num(row.start ?? row.t ?? row.openTime);
  const o = num(row.open ?? row.o);
  const h = num(row.high ?? row.h);
  const l = num(row.low ?? row.l);
  const c = num(row.close ?? row.c);
  const v = num(row.volume ?? row.v) ?? 0;
  if (t == null || o == null || h == null || l == null || c == null) return null;
  return {
    openTime: t,
    open: o,
    high: h,
    low: l,
    close: c,
    volume: v,
    closeTime: t + intervalMs - 1,
  };
}

interface Opts {
  enabled?: boolean;
}

interface Connection {
  ws: WebSocket | null;
  alive: boolean;   // false once this connection is torn down; onclose becomes a no-op
  reconnectTimer: ReturnType<typeof setTimeout> | null;
  heartbeat: ReturnType<typeof setInterval> | null;
  stale: ReturnType<typeof setInterval> | null;
  backoff: number;
}

export function useApexPublicStream(
  symbol: string | undefined,
  interval: Interval,
  opts: Opts = {},
): StreamState {
  const enabled = opts.enabled !== false && !!symbol;
  const [state, setState] = useState<StreamState>({
    symbol: symbol ? toRawApexSymbol(symbol) : null,
    status: "connecting",
    lastTickAt: null,
    ticker: null,
    latestCandle: null,
  });

  useEffect(() => {
    if (!enabled) {
      setState({ symbol: null, status: "closed", lastTickAt: null, ticker: null, latestCandle: null });
      return;
    }
    if (typeof WebSocket === "undefined") {
      setState((s) => ({ ...s, status: "closed" }));
      return;
    }

    const raw = toRawApexSymbol(symbol!);
    const tickerTopic = `instrumentInfo.H.${raw}`;
    const candleTopic = `candle.${APEX_INTERVAL[interval]}.${raw}`;

    // CRITICAL — reset state to the NEW symbol synchronously so a stale render
    // cannot leak the previous symbol's ticker under the new header.
    setState({ symbol: raw, status: "connecting", lastTickAt: null, ticker: null, latestCandle: null });

    // Per-connection state. The closure captures `conn`, so once we set
    // `conn.alive = false` on teardown, THIS specific socket's callbacks stop
    // mutating shared state — even if a delayed onclose fires after a new
    // socket has already been stood up.
    const conn: Connection = {
      ws: null,
      alive: true,
      reconnectTimer: null,
      heartbeat: null,
      stale: null,
      backoff: 250,
    };
    let tickerCache: TickerSnapshot | null = null;

    function clearConnTimers() {
      if (conn.heartbeat) { clearInterval(conn.heartbeat); conn.heartbeat = null; }
      if (conn.stale) { clearInterval(conn.stale); conn.stale = null; }
      if (conn.reconnectTimer) { clearTimeout(conn.reconnectTimer); conn.reconnectTimer = null; }
    }

    function scheduleReconnect() {
      if (!conn.alive) return;                // ghost-guard: dead connection never reconnects
      const delay = Math.min(conn.backoff, MAX_BACKOFF_MS);
      conn.backoff = Math.min(delay * 2, MAX_BACKOFF_MS);
      setState((s) => (s.symbol === raw ? { ...s, status: "reconnecting" } : s));
      conn.reconnectTimer = setTimeout(() => {
        if (conn.alive) connect();
      }, delay);
    }

    function connect() {
      if (!conn.alive) return;
      try {
        setState((s) => (s.symbol === raw ? { ...s, status: "connecting" } : s));
        const ws = new WebSocket(`${WS_URL}&timestamp=${Date.now()}`);
        conn.ws = ws;

        ws.onopen = () => {
          if (!conn.alive) { try { ws.close(); } catch { /* ignore */ } return; }
          conn.backoff = 250;
          try {
            ws.send(JSON.stringify({ op: "subscribe", args: [tickerTopic, candleTopic] }));
          } catch { /* ignore — onclose will trigger reconnect */ }
          setState((s) => (s.symbol === raw ? { ...s, status: "live" } : s));
          if (conn.heartbeat) clearInterval(conn.heartbeat);
          conn.heartbeat = setInterval(() => {
            if (!conn.alive) return;
            try {
              if (ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({ op: "ping", args: [String(Date.now())] }));
              }
            } catch { /* ignore */ }
          }, HEARTBEAT_MS);
          if (conn.stale) clearInterval(conn.stale);
          conn.stale = setInterval(() => {
            if (!conn.alive) return;
            setState((s) => {
              if (s.symbol !== raw) return s;
              if (!s.lastTickAt) return s;
              const age = Date.now() - s.lastTickAt;
              if (age > STALE_MS && s.status === "live") return { ...s, status: "stale" };
              if (age <= STALE_MS && s.status === "stale") return { ...s, status: "live" };
              return s;
            });
          }, 2_000);
        };

        ws.onmessage = (ev) => {
          if (!conn.alive) return;              // ghost-guard on every frame
          let msg: unknown;
          try { msg = JSON.parse(typeof ev.data === "string" ? ev.data : String(ev.data)); }
          catch { return; }
          const anyMsg = msg as Record<string, unknown>;
          if (anyMsg?.op === "ping") {
            try { ws.send(JSON.stringify({ op: "pong", args: [String(Date.now())] })); } catch { /* ignore */ }
            return;
          }
          const topic = typeof anyMsg?.topic === "string" ? (anyMsg.topic as string) : "";
          if (!topic) return;
          // SYMBOL GUARD — topic MUST end with the raw symbol we subscribed to.
          // Any other frame (leaked from a previous socket or an out-of-band
          // broadcast) is discarded so it cannot poison shared state.
          if (!topic.endsWith(`.${raw}`)) return;
          const now = Date.now();
          if (topic === tickerTopic) {
            const nextTicker = parseTicker(tickerCache, anyMsg);
            tickerCache = nextTicker;
            setState((s) => (s.symbol === raw
              ? { ...s, ticker: nextTicker, lastTickAt: now, status: "live" }
              : s));
          } else if (topic === candleTopic) {
            const c = parseCandle(anyMsg, INTERVAL_MS[interval]);
            if (c) setState((s) => (s.symbol === raw
              ? { ...s, latestCandle: c, lastTickAt: now, status: "live" }
              : s));
          }
        };

        ws.onerror = () => { /* onclose will follow */ };
        ws.onclose = () => {
          // Only THIS connection's timers/reconnect. If we've been torn down,
          // do absolutely nothing — no shared-state mutations, no reconnect.
          if (!conn.alive) return;
          clearConnTimers();
          scheduleReconnect();
        };
      } catch {
        if (conn.alive) scheduleReconnect();
      }
    }

    connect();

    return () => {
      // Mark this connection dead FIRST so any in-flight onopen/onmessage/
      // onclose becomes a no-op.
      conn.alive = false;
      clearConnTimers();
      const ws = conn.ws;
      conn.ws = null;
      try {
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ op: "unsubscribe", args: [tickerTopic, candleTopic] }));
        }
      } catch { /* ignore */ }
      try { ws?.close(); } catch { /* ignore */ }
    };
  }, [enabled, symbol, interval]);

  return state;
}
