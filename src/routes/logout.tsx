import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";
import { Loader2, LogOut } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { Mascot } from "@/components/welcome/Mascot";

export const Route = createFileRoute("/logout")({
  ssr: false,
  component: LogoutPage,
  head: () => ({ meta: [{ title: "Signing out — TurtleBot" }, { name: "robots", content: "noindex" }] }),
});

function LogoutPage() {
  const navigate = useNavigate();
  useEffect(() => {
    let active = true;
    void supabase.auth.signOut().finally(() => {
      if (active) setTimeout(() => navigate({ to: "/welcome", replace: true }), 650);
    });
    return () => { active = false; };
  }, [navigate]);
  return (
    <main className="auth-shell welcome-shell mx-auto flex min-h-[100dvh] w-full max-w-[430px] flex-col items-center justify-center px-5 text-center">
      <div className="w-full"><Mascot slug="liq-hunting" size={190} /></div>
      <div className="welcome-inset-panel mt-10 w-full rounded-[24px] px-6 py-8">
        <span className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl text-primary"><LogOut className="h-6 w-6" /></span>
        <h1 className="mt-4 font-display text-xl font-bold text-white">Signing you out</h1>
        <p className="mt-2 text-sm text-muted-foreground">Closing your secure TurtleBot session…</p>
        <Loader2 className="mx-auto mt-5 h-5 w-5 animate-spin text-primary" />
      </div>
    </main>
  );
}
