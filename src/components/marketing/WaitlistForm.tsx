import { useState, type FormEvent } from "react";
import { useServerFn } from "@tanstack/react-start";
import { submitWaitlistEntry } from "@/lib/marketing/waitlist.functions";
import { Loader2, CheckCircle2 } from "lucide-react";
import { cn } from "@/lib/utils";

type Kind = "presale" | "nft_genesis" | "nft_evolution" | "merch" | "community" | "general";

export function WaitlistForm({
  kind,
  source,
  ctaLabel = "Join the waitlist",
  successCopy = "You're on the list. We'll be in touch when there's something real to share.",
  className,
}: {
  kind: Kind;
  source?: string;
  ctaLabel?: string;
  successCopy?: string;
  className?: string;
}) {
  const submit = useServerFn(submitWaitlistEntry);
  const [email, setEmail] = useState("");
  const [consent, setConsent] = useState(false);
  const [status, setStatus] = useState<"idle" | "submitting" | "success" | "error">("idle");
  const [message, setMessage] = useState<string | null>(null);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (status === "submitting") return;
    if (!consent) {
      setStatus("error");
      setMessage("Please accept the notice to continue.");
      return;
    }
    setStatus("submitting");
    setMessage(null);
    try {
      await submit({ data: { kind, source, email, consent: true } });
      setStatus("success");
    } catch (err) {
      setStatus("error");
      setMessage(err instanceof Error ? err.message : "Something went wrong.");
    }
  }

  if (status === "success") {
    return (
      <div
        className={cn(
          "flex items-start gap-3 rounded-2xl border border-emerald-400/25 bg-emerald-400/10 p-4 text-sm text-emerald-100",
          className,
        )}
        role="status"
      >
        <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-emerald-300" />
        <div>
          <p className="font-medium">Confirmed</p>
          <p className="mt-1 text-emerald-100/80">{successCopy}</p>
        </div>
      </div>
    );
  }

  return (
    <form onSubmit={onSubmit} className={cn("space-y-3", className)} noValidate>
      <div className="flex flex-col gap-2 sm:flex-row">
        <label className="sr-only" htmlFor={`wl-email-${kind}`}>
          Email
        </label>
        <input
          id={`wl-email-${kind}`}
          type="email"
          required
          autoComplete="email"
          maxLength={320}
          placeholder="you@somewhere.com"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          className="flex-1 rounded-xl border border-white/10 bg-white/5 px-4 py-3 text-sm text-white placeholder:text-white/40 backdrop-blur focus:border-cyan-300/50 focus:outline-none focus:ring-2 focus:ring-cyan-300/25"
        />
        <button
          type="submit"
          disabled={status === "submitting"}
          className="inline-flex items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-violet-500 to-cyan-400 px-5 py-3 text-sm font-semibold text-black transition-transform duration-200 hover:scale-[1.02] focus:outline-none focus:ring-2 focus:ring-cyan-300 disabled:opacity-70"
        >
          {status === "submitting" ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
          {ctaLabel}
        </button>
      </div>

      <label className="flex items-start gap-2 text-xs leading-relaxed text-white/60">
        <input
          type="checkbox"
          checked={consent}
          onChange={(e) => setConsent(e.target.checked)}
          className="mt-0.5 h-4 w-4 rounded border-white/25 bg-transparent text-cyan-400 focus:ring-cyan-300"
        />
        <span>
          I understand joining this waitlist is not an offer to sell securities, an allocation
          guarantee, or a promise of returns. I consent to being emailed about TurtleBot updates.
        </span>
      </label>

      {status === "error" && message ? (
        <p className="text-xs text-rose-300" role="alert">
          {message}
        </p>
      ) : null}
    </form>
  );
}
