import { Settings, Loader2, Camera } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { ExchangeHealth } from "@/components/turtle/ExchangeHealth";
import wordmark from "@/assets/turtlebot-wordmark.png.asset.json";

import turtleDefault from "@/assets/turtle-accumulator.webp";


export function AppHeader(_props: { demoMode?: boolean } = {}) {
  const { user } = useAuth();
  const inputRef = useRef<HTMLInputElement>(null);
  const [avatarUrl, setAvatarUrl] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);

  useEffect(() => {
    if (!user) return;
    void loadAvatar();
    async function loadAvatar() {
      const { data: p } = await supabase
        .from("profiles")
        .select("avatar_url")
        .eq("id", user!.id)
        .maybeSingle();
      if (!p?.avatar_url) {
        setAvatarUrl(null);
        return;
      }
      const { data: signed } = await supabase.storage
        .from("avatars")
        .createSignedUrl(p.avatar_url, 60 * 60);
      setAvatarUrl(signed?.signedUrl ?? null);
    }
  }, [user]);

  async function onPick(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file || !user) return;
    if (file.size > 5 * 1024 * 1024) {
      toast.error("Image must be under 5MB");
      return;
    }
    setUploading(true);
    try {
      const ext = file.name.split(".").pop()?.toLowerCase() || "jpg";
      const path = `${user.id}/avatar.${ext}`;
      const { error: upErr } = await supabase.storage
        .from("avatars")
        .upload(path, file, { upsert: true, contentType: file.type });
      if (upErr) throw upErr;
      const { error: dbErr } = await supabase
        .from("profiles")
        .update({ avatar_url: path })
        .eq("id", user.id);
      if (dbErr) throw dbErr;
      const { data: signed } = await supabase.storage.from("avatars").createSignedUrl(path, 60 * 60);
      setAvatarUrl(signed?.signedUrl ?? null);
      toast.success("Photo updated");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Upload failed");
    } finally {
      setUploading(false);
    }
  }

  return (
    <header className="flex items-center justify-between px-5 pb-3 pt-6">
      <div className="flex items-center gap-2.5">
        <button
          onClick={() => inputRef.current?.click()}
          className="group relative flex h-11 w-11 items-center justify-center overflow-hidden rounded-2xl border border-white/10 bg-white/[0.05] active:scale-[0.97]"
          aria-label="Change profile photo"
        >
          <img
            src={avatarUrl ?? turtleDefault}
            alt=""
            className="h-full w-full object-cover"
          />
          <span className="absolute inset-0 flex items-center justify-center bg-black/40 opacity-0 transition group-hover:opacity-100">
            {uploading ? (
              <Loader2 className="h-4 w-4 animate-spin text-white" />
            ) : (
              <Camera className="h-4 w-4 text-white" />
            )}
          </span>
        </button>
        <input
          ref={inputRef}
          type="file"
          accept="image/*"
          className="hidden"
          onChange={onPick}
        />
        <div className="flex items-center leading-tight">
          <img
            src={wordmark.url}
            alt="TurtleBot"
            className="h-12 w-auto select-none"
            draggable={false}
          />
        </div>
      </div>


      <div className="flex items-center gap-2">
        <ExchangeHealth />
        <button className="flex h-10 w-10 items-center justify-center rounded-full border border-white/10 bg-white/[0.04] text-muted-foreground transition hover:text-foreground">
          <Settings className="h-4 w-4" />
        </button>
      </div>
    </header>
  );
}
