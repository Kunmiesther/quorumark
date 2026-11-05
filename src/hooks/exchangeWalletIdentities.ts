import { supabase } from "@/integrations/supabase/client";
import type { ExchangeWalletIdentity } from "@/lib/wallet/accountIdentity";

export function exchangeWalletIdentitiesQuery(userId: string | null | undefined) {
  return {
    queryKey: ["exchange-wallet-identities", userId],
    enabled: !!userId,
    staleTime: 60_000,
    queryFn: async (): Promise<ExchangeWalletIdentity[]> => {
      const { data, error } = await supabase.functions.invoke("exchange-credentials", {
        body: { action: "wallet_identities" },
      });
      if (error || !data?.ok || !Array.isArray(data.identities))
        throw new Error("Wallet identity unavailable");
      const registrations = await supabase.from("synfutures_account_registrations")
        .select("id,owner_address").eq("user_id", userId!);
      if (registrations.error) throw new Error("SynFutures wallet identity unavailable");
      const owners = new Map((registrations.data ?? []).map(row => [row.id, row.owner_address]));
      return data.identities.map((identity: ExchangeWalletIdentity) => identity.exchange === "synfutures"
        ? { ...identity, account_address: owners.get(identity.connection_id) ?? null }
        : identity);
    },
  };
}
