import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { z } from "zod";

export const inspectSynFuturesSdk = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { supabase, userId } = context;
    // The deployed app_role enum is admin/moderator/user; the app owner is an admin.
    const admin = await supabase.rpc("has_role", { _user_id: userId, _role: "admin" });
    if (admin.error || admin.data !== true) throw new Error("OWNER_OR_ADMIN_REQUIRED");
    const { cachedSynFuturesProbe } = await import("./synfutures/probe.server");
    return cachedSynFuturesProbe();
  });

export const inspectSynFuturesWallet = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) =>
    z.object({ walletId: z.string().uuid() }).strict().parse(input),
  )
  .handler(async ({ context, data }) => {
    const { supabase, userId } = context;
    const admin = await supabase.rpc("has_role", { _user_id: userId, _role: "admin" });
    if (admin.error || admin.data !== true) throw new Error("OWNER_OR_ADMIN_REQUIRED");
    const wallet = await supabase
      .from("wallet_connections")
      .select("public_address")
      .eq("id", data.walletId)
      .eq("user_id", userId)
      .eq("status", "verified")
      .eq("is_active", true)
      .eq("chain", "ethereum")
      .eq("network", "mainnet")
      .maybeSingle();
    if (wallet.error || !wallet.data) throw new Error("VERIFIED_WALLET_REQUIRED");
    const [
      { cachedSynFuturesProbe },
      { synFuturesWalletPreflight },
      { inspectSynFuturesAccount, synAccountNote },
    ] = await Promise.all([
      import("./synfutures/probe.server"),
      import("./synfutures/walletPreflight.server"),
      import("./synfutures/account.server"),
    ]);
    const [preflight, account] = await Promise.all([
      synFuturesWalletPreflight(wallet.data.public_address, await cachedSynFuturesProbe()),
      inspectSynFuturesAccount(wallet.data.public_address, data.walletId).catch(() => null),
    ]);
    return { ...preflight, trading_account: account, note: synAccountNote(account) };
  });

export const inspectSynFuturesQuote = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) =>
    z
      .object({
        instrument: z.string().regex(/^0x[a-fA-F0-9]{40}$/),
        expiry: z.number().int().positive().max(4294967295),
        notional: z.string().max(32),
        side: z.enum(["long", "short"]),
      })
      .strict()
      .parse(input),
  )
  .handler(async ({ context: { supabase, userId }, data }) => {
    const admin = await supabase.rpc("has_role", { _user_id: userId, _role: "admin" });
    if (admin.error || admin.data !== true) throw new Error("OWNER_OR_ADMIN_REQUIRED");
    const [{ cachedSynFuturesProbe }, { quoteSynFuturesMarket }] = await Promise.all([
      import("./synfutures/probe.server"),
      import("./synfutures/marketQuote.server"),
    ]);
    try {
      return await quoteSynFuturesMarket(data, await cachedSynFuturesProbe());
    } catch {
      throw new Error(
        "SynFutures quote unavailable. Refresh market discovery and check the amount; no transaction was sent.",
      );
    }
  });
