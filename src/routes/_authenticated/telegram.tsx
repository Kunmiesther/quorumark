// Telegram connect/disconnect — mints a short-lived link code the customer
// sends to the bot to bind their chat to this account. No secret, credential
// or trade-execution capability lives on this page.
import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useState } from "react";
import { Send, Copy, Check, Unlink } from "lucide-react";
import { toast } from "sonner";
import { SurfaceCard } from "@/components/phantom/SurfaceCard";
import {
  createTelegramLinkCode,
  getTelegramLinkStatus,
  unlinkTelegram,
} from "@/lib/telegram/link.functions";

export const Route = createFileRoute("/_authenticated/telegram")({
  component: TelegramPage,
  head: () => ({
    meta: [
      { title: "Telegram — TurtleBot" },
      { name: "description", content: "Link Telegram to ask the council about a ticker from your phone." },
    ],
  }),
});

function TelegramPage() {
  const qc = useQueryClient();
  const fetchStatus = useServerFn(getTelegramLinkStatus);
  const fetchCode = useServerFn(createTelegramLinkCode);
  const fetchUnlink = useServerFn(unlinkTelegram);

  const { data: status, isLoading } = useQuery({
    queryKey: ["telegram-link-status"],
    queryFn: () => fetchStatus(),
  });

  const [code, setCode] = useState<string | null>(null);
  const [botUsername, setBotUsername] = useState<string | null>(null);
  const [minting, setMinting] = useState(false);
  const [copied, setCopied] = useState(false);

  async function mintCode() {
    setMinting(true);
    try {
      const res = await fetchCode();
      setCode(res.code);
      setBotUsername(res.botUsername);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not create a code");
    } finally {
      setMinting(false);
    }
  }

  async function disconnect() {
    try {
      await fetchUnlink();
      setCode(null);
      qc.invalidateQueries({ queryKey: ["telegram-link-status"] });
      toast.success("Telegram disconnected");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not disconnect");
    }
  }

  const deepLink = botUsername ? `https://t.me/${botUsername}?start=${code}` : null;

  return (
    <div className="mx-auto max-w-[560px] space-y-5 bg-black px-4 pb-4 pt-5 text-white">
      <header>
        <h1 className="text-[22px] font-bold" style={{ letterSpacing: "-0.02em" }}>
          Telegram
        </h1>
        <p className="mt-1 text-[13px] text-white/55">
          Send any ticker to the bot and the same three-seat council used in the app will look at
          it and reply with its read — paper trading, advisory only.
        </p>
      </header>

      {isLoading ? (
        <SurfaceCard>
          <p className="text-[13px] text-white/50">Loading…</p>
        </SurfaceCard>
      ) : status?.linked ? (
        <SurfaceCard className="space-y-4">
          <div className="flex items-center gap-3">
            <div
              className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl"
              style={{ background: "rgba(45,159,255,0.15)", color: "#2d9fff" }}
            >
              <Send className="h-5 w-5" />
            </div>
            <div className="min-w-0 flex-1">
              <p className="text-[13.5px] font-semibold text-white">Connected</p>
              <p className="truncate text-[11.5px] text-white/50">
                {status.telegramUsername ? `@${status.telegramUsername}` : "Linked chat"}
                {status.linkedAt ? ` · since ${new Date(status.linkedAt).toLocaleDateString()}` : ""}
              </p>
            </div>
          </div>
          <button
            onClick={disconnect}
            className="flex h-10 w-full items-center justify-center gap-2 rounded-xl bg-[color:var(--negative)]/10 text-[12.5px] font-medium text-[color:var(--negative)] transition hover:bg-[color:var(--negative)]/15"
          >
            <Unlink className="h-4 w-4" />
            Disconnect
          </button>
        </SurfaceCard>
      ) : (
        <SurfaceCard className="space-y-4">
          {!code ? (
            <>
              <p className="text-[13px] text-white/60">
                Generate a one-time code, then send it to the TurtleBot Telegram bot to link this
                account. Codes expire after 10 minutes.
              </p>
              <button
                onClick={mintCode}
                disabled={minting}
                className="flex h-11 w-full items-center justify-center gap-2 rounded-xl bg-[color:var(--accent)] text-[13px] font-semibold text-black transition active:scale-[0.99] disabled:opacity-50"
              >
                <Send className="h-4 w-4" />
                {minting ? "Generating…" : "Generate link code"}
              </button>
            </>
          ) : (
            <>
              <div className="rounded-xl border border-white/10 bg-black/40 p-4 text-center">
                <p className="text-[10px] uppercase tracking-[0.16em] text-white/40">Your code</p>
                <p className="mt-1 font-mono text-[26px] font-bold tracking-[0.12em] text-white">
                  {code}
                </p>
              </div>
              <button
                onClick={() => {
                  void navigator.clipboard.writeText(code);
                  setCopied(true);
                  setTimeout(() => setCopied(false), 1500);
                }}
                className="flex h-10 w-full items-center justify-center gap-2 rounded-xl border border-white/10 text-[12.5px] font-medium text-white/80 hover:text-white"
              >
                {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
                {copied ? "Copied" : "Copy code"}
              </button>
              {deepLink ? (
                <a
                  href={deepLink}
                  target="_blank"
                  rel="noreferrer"
                  className="flex h-11 w-full items-center justify-center gap-2 rounded-xl bg-[color:var(--accent)] text-[13px] font-semibold text-black transition active:scale-[0.99]"
                >
                  Open Telegram &amp; link
                </a>
              ) : (
                <p className="text-center text-[12px] text-white/50">
                  Open Telegram, message the TurtleBot bot, and send{" "}
                  <code className="rounded bg-white/10 px-1">/link {code}</code>
                </p>
              )}
              <button
                onClick={() => qc.invalidateQueries({ queryKey: ["telegram-link-status"] })}
                className="w-full text-center text-[11.5px] text-white/40 hover:text-white/60"
              >
                I've linked it — refresh status
              </button>
            </>
          )}
        </SurfaceCard>
      )}
    </div>
  );
}
