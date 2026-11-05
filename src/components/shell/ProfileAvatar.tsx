import { Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { User } from "lucide-react";

/**
 * ProfileAvatar — the ONLY top-right chrome element. 40px circle,
 * backdrop-blurred, links to Client Profile. Replaces the previous
 * gear/settings icon (settings now lives INSIDE /profile as sections).
 */
export function ProfileAvatar() {
  const { user } = useAuth();
  const [url, setUrl] = useState<string | null>(null);

  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    (async () => {
      const { data: p } = await supabase
        .from("profiles")
        .select("avatar_url")
        .eq("id", user.id)
        .maybeSingle();
      if (!p?.avatar_url) return;
      const { data: signed } = await supabase.storage
        .from("avatars")
        .createSignedUrl(p.avatar_url, 60 * 60);
      if (!cancelled) setUrl(signed?.signedUrl ?? null);
    })();
    return () => {
      cancelled = true;
    };
  }, [user]);

  return (
    <Link
      to="/profile"
      aria-label="Open profile"
      className="flex h-10 w-10 items-center justify-center overflow-hidden rounded-full bg-[#22D3EE]/10 ring-1 ring-[#22D3EE]/40 backdrop-blur-md transition hover:bg-[#22D3EE]/20 hover:ring-[#22D3EE]/70 hover:shadow-[0_0_10px_rgba(34,211,238,0.35)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[#22D3EE]"
    >
      {url ? (
        <img src={url} alt="" className="h-full w-full object-cover" />
      ) : (
        <User className="h-5 w-5 text-[#22D3EE]" />
      )}
    </Link>
  );
}
