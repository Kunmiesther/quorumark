/**
 * Admin-only server functions for cross-user paper-trading stats.
 *
 * Access model: caller must be signed in AND have the 'admin' role in
 * public.user_roles. Verified server-side via has_role(auth.uid(), 'admin')
 * on the authenticated supabase client. If the check fails we throw.
 *
 * After authorization, we use supabaseAdmin (service role) to read across
 * all users — this bypasses RLS by design and is the whole point of the
 * admin view. We NEVER return auth-schema PII (emails etc.); only public
 * profile display_name plus paper-engine aggregates.
 */
import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

export interface AdminUserPaperStats {
  user_id: string;
  display_name: string | null;
  account_mode: string | null;
  bot_status: string | null;
  wallets: number;
  wallet_balance_total: number;
  open_positions: number;
  closed_trades: number;
  pnl_net_total: number;
  wins: number;
  losses: number;
  win_rate: number;
  last_trade_at: string | null;
}

async function assertAdmin(supabase: unknown, userId: string) {
  const client = supabase as {
    rpc: (fn: string, args: Record<string, unknown>) => Promise<{ data: unknown; error: { message: string } | null }>;
  };
  const { data, error } = await client.rpc("has_role", {
    _user_id: userId,
    _role: "admin",
  });
  if (error) throw new Error(`admin_check_failed: ${error.message}`);
  if (!data) throw new Error("Forbidden: admin role required");
}

export const listAllUserPaperStats = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<AdminUserPaperStats[]> => {
    await assertAdmin(context.supabase, context.userId);

    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    const [profiles, wallets, positions, trades] = await Promise.all([
      supabaseAdmin
        .from("profiles")
        .select("id, display_name, account_mode, bot_status, created_at"),
      supabaseAdmin
        .from("paper_wallets")
        .select("user_id, balance"),
      supabaseAdmin
        .from("paper_positions")
        .select("user_id, status"),
      supabaseAdmin
        .from("paper_trades")
        .select("user_id, pnl_net, closed_at"),
    ]);

    if (profiles.error) throw new Error(profiles.error.message);
    if (wallets.error) throw new Error(wallets.error.message);
    if (positions.error) throw new Error(positions.error.message);
    if (trades.error) throw new Error(trades.error.message);

    type Bucket = {
      wallets: number;
      wallet_balance_total: number;
      open_positions: number;
      closed_trades: number;
      pnl_net_total: number;
      wins: number;
      losses: number;
      last_trade_at: string | null;
    };
    const empty = (): Bucket => ({
      wallets: 0,
      wallet_balance_total: 0,
      open_positions: 0,
      closed_trades: 0,
      pnl_net_total: 0,
      wins: 0,
      losses: 0,
      last_trade_at: null,
    });
    const byUser = new Map<string, Bucket>();
    const bucket = (uid: string) => {
      let b = byUser.get(uid);
      if (!b) { b = empty(); byUser.set(uid, b); }
      return b;
    };

    for (const w of (wallets.data ?? []) as Array<{ user_id: string; balance: number | null }>) {
      const b = bucket(w.user_id);
      b.wallets += 1;
      b.wallet_balance_total += Number(w.balance ?? 0);
    }
    for (const p of (positions.data ?? []) as Array<{ user_id: string; status: string }>) {
      if (p.status === "open") bucket(p.user_id).open_positions += 1;
    }
    for (const t of (trades.data ?? []) as Array<{ user_id: string; pnl_net: number | null; closed_at: string | null }>) {
      const b = bucket(t.user_id);
      b.closed_trades += 1;
      const p = Number(t.pnl_net ?? 0);
      b.pnl_net_total += p;
      if (p >= 0) b.wins += 1; else b.losses += 1;
      if (t.closed_at && (!b.last_trade_at || t.closed_at > b.last_trade_at)) {
        b.last_trade_at = t.closed_at;
      }
    }

    const rows: AdminUserPaperStats[] = (profiles.data ?? [])
      .map((p: { id: string; display_name: string | null; account_mode: string | null; bot_status: string | null }) => {
        const b = byUser.get(p.id) ?? empty();
        const total = b.wins + b.losses;
        return {
          user_id: p.id,
          display_name: p.display_name,
          account_mode: p.account_mode,
          bot_status: p.bot_status,
          wallets: b.wallets,
          wallet_balance_total: b.wallet_balance_total,
          open_positions: b.open_positions,
          closed_trades: b.closed_trades,
          pnl_net_total: b.pnl_net_total,
          wins: b.wins,
          losses: b.losses,
          win_rate: total > 0 ? (b.wins / total) * 100 : 0,
          last_trade_at: b.last_trade_at,
        };
      })
      .sort((a, b) => b.pnl_net_total - a.pnl_net_total);

    return rows;
  });
