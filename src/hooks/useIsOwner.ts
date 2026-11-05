// Client-side owner/admin gate for technical diagnostics disclosures.
// Authoritative enforcement stays server-side; this only decides whether a
// "Technical details" disclosure (vendor/model provenance) is rendered.

import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";

export function useIsOwner(): { isOwner: boolean; isReady: boolean } {
  const { user, isReady } = useAuth();
  const [isOwner, setIsOwner] = useState(false);
  const [resolved, setResolved] = useState(false);

  useEffect(() => {
    let cancelled = false;
    if (!isReady) return;
    if (!user) {
      setIsOwner(false);
      setResolved(true);
      return;
    }
    void (async () => {
      const [owner, admin] = await Promise.all([
        supabase.rpc("has_role", { _user_id: user.id, _role: "owner" as never }),
        supabase.rpc("has_role", { _user_id: user.id, _role: "admin" }),
      ]);
      if (cancelled) return;
      setIsOwner(owner.data === true || admin.data === true);
      setResolved(true);
    })();
    return () => {
      cancelled = true;
    };
  }, [user, isReady]);

  return { isOwner, isReady: resolved };
}
