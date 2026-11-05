/**
 * market-news server function
 *
 * Server-side proxy for CoinDesk's public RSS feed. The browser can't fetch
 * CoinDesk directly (no CORS), so this server function runs the fetch in the
 * TanStack Start worker and returns parsed JSON.
 *
 * Public data, no auth, no secrets. Fail-closed: on network error or malformed
 * XML we return { items: [] } — the client shows an honest empty state. Never
 * fabricate headlines.
 */

import { createServerFn } from "@tanstack/react-start";

const FEED_URL = "https://www.coindesk.com/arc/outboundfeeds/rss/";
const MAX_ITEMS = 15;
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

export interface MarketNewsItem {
  title: string;
  link: string;
  publishedAt: string; // ISO string
  source: "CoinDesk";
  summary?: string;
  imageUrl?: string;
}

export interface MarketNewsResponse {
  items: MarketNewsItem[];
}

// In-worker cache. Workers are stateless across cold starts, but warm
// invocations reuse this — enough to keep upstream traffic gentle.
let cache: { at: number; payload: MarketNewsResponse } | null = null;

// ── XML helpers ─────────────────────────────────────────────────────────────

function stripCdata(raw: string): string {
  const m = raw.match(/<!\[CDATA\[([\s\S]*?)\]\]>/);
  return (m ? m[1] : raw).trim();
}

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, n) => String.fromCharCode(parseInt(n, 16)));
}

function stripTags(s: string): string {
  return decodeEntities(s.replace(/<[^>]+>/g, "")).replace(/\s+/g, " ").trim();
}

function firstTag(block: string, tag: string): string | null {
  const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, "i");
  const m = block.match(re);
  return m ? stripCdata(m[1]) : null;
}

function firstAttr(block: string, tag: string, attr: string): string | null {
  const re = new RegExp(`<${tag}\\b[^>]*\\b${attr}\\s*=\\s*"([^"]+)"`, "i");
  const m = block.match(re);
  return m ? m[1] : null;
}

function parseFeed(xml: string): MarketNewsItem[] {
  const items: MarketNewsItem[] = [];
  const itemRegex = /<item\b[\s\S]*?<\/item>/gi;
  const matches = xml.match(itemRegex) ?? [];

  for (const block of matches) {
    const title = firstTag(block, "title");
    const link = firstTag(block, "link");
    const pub = firstTag(block, "pubDate");
    if (!title || !link || !pub) continue;

    const iso = new Date(pub).toISOString();
    if (Number.isNaN(new Date(iso).getTime())) continue;

    const descriptionRaw =
      firstTag(block, "description") ?? firstTag(block, "summary");
    const summary = descriptionRaw ? stripTags(descriptionRaw).slice(0, 240) : undefined;

    const imageUrl =
      firstAttr(block, "media:content", "url") ??
      firstAttr(block, "media:thumbnail", "url") ??
      firstAttr(block, "enclosure", "url") ??
      undefined;

    items.push({
      title: stripTags(title),
      link: decodeEntities(link.trim()),
      publishedAt: iso,
      source: "CoinDesk",
      ...(summary ? { summary } : {}),
      ...(imageUrl ? { imageUrl } : {}),
    });

    if (items.length >= MAX_ITEMS) break;
  }

  // Newest first (feed usually is already sorted, but don't rely on it).
  items.sort((a, b) => (a.publishedAt < b.publishedAt ? 1 : -1));
  return items;
}

// ── Server function ────────────────────────────────────────────────────────

export const getMarketNews = createServerFn({ method: "GET" }).handler(
  async (): Promise<MarketNewsResponse> => {
    const now = Date.now();
    if (cache && now - cache.at < CACHE_TTL_MS) {
      return cache.payload;
    }

    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 8000);
      const res = await fetch(FEED_URL, {
        headers: {
          accept: "application/rss+xml, application/xml, text/xml, */*",
          "user-agent": "TurtleBot/1.0 (+market-news proxy)",
        },
        signal: controller.signal,
      }).finally(() => clearTimeout(timer));

      if (!res.ok) {
        // Honest empty state — do not synthesise headlines.
        const payload: MarketNewsResponse = { items: [] };
        cache = { at: now, payload };
        return payload;
      }

      const xml = await res.text();
      const items = parseFeed(xml);
      const payload: MarketNewsResponse = { items };
      cache = { at: now, payload };
      return payload;
    } catch {
      // Network failure / abort / malformed XML — honest empty state.
      const payload: MarketNewsResponse = { items: [] };
      cache = { at: now, payload };
      return payload;
    }
  },
);
