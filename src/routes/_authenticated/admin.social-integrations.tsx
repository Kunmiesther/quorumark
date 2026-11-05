import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { Loader2, Check, X, Copy } from "lucide-react";
import { toast } from "sonner";
import {
  getSocialReviewKit,
  type SocialReviewKit,
} from "@/lib/admin/social-review-kit.functions";
import {
  PROVIDER_STATUS_LABEL,
  REVIEW_TEST_CHECKLIST,
  REVIEW_URLS,
  SOCIAL_PROVIDERS,
} from "@/lib/social-auth/providers";
import { OWNER_CONFIRMATION_ITEMS } from "@/lib/legal/config";

export const Route = createFileRoute("/_authenticated/admin/social-integrations")({
  head: () => ({
    meta: [
      { title: "Social App Review Kit — Turtle Bot Admin" },
      { name: "robots", content: "noindex" },
    ],
  }),
  component: SocialIntegrationsPage,
});

function Copyable({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-white/[0.06] bg-white/[0.02] px-3 py-2">
      <div className="min-w-0">
        <p className="text-[10px] uppercase tracking-[0.16em] text-white/40">{label}</p>
        <p className="truncate font-mono text-[12px] text-white/80">{value}</p>
      </div>
      <button
        type="button"
        onClick={() => {
          void navigator.clipboard.writeText(value);
          toast.success(`Copied ${label}`);
        }}
        className="flex items-center gap-1 rounded-md border border-white/10 px-2 py-1 text-[11px] text-white/70 hover:text-white"
      >
        <Copy className="h-3 w-3" /> Copy
      </button>
    </div>
  );
}

function Flag({ ok, children }: { ok: boolean; children: React.ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-[12px]">
      {ok ? (
        <Check className="h-3.5 w-3.5 text-emerald-400" />
      ) : (
        <X className="h-3.5 w-3.5 text-rose-400" />
      )}
      <span className={ok ? "text-white/75" : "text-white/50"}>{children}</span>
    </span>
  );
}

function SocialIntegrationsPage() {
  const { data, isLoading, error } = useQuery<SocialReviewKit>({
    queryKey: ["social-review-kit"],
    queryFn: () => getSocialReviewKit(),
  });

  if (isLoading) {
    return (
      <div className="flex min-h-[50vh] items-center justify-center">
        <Loader2 className="h-5 w-5 animate-spin text-white/60" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="mx-auto max-w-2xl p-6 text-sm text-rose-300">
        {error instanceof Error ? error.message : "Failed to load review kit"}
      </div>
    );
  }

  return (
    <div className="mx-auto w-full max-w-4xl space-y-8 p-4 sm:p-6">
      <header>
        <h1 className="font-display text-2xl font-semibold text-white">Social App Review Kit</h1>
        <p className="mt-2 text-sm text-white/60">
          Everything a provider review form asks for. Credential presence is read server-side;
          secret values are never returned to this page.
        </p>
      </header>

      <section className="rounded-2xl border border-amber-400/20 bg-amber-400/5 p-4">
        <h2 className="text-xs font-semibold uppercase tracking-[0.2em] text-amber-200">
          Owner confirmation required
        </h2>
        <ul className="mt-3 space-y-2 text-sm text-white/70">
          {OWNER_CONFIRMATION_ITEMS.map((item) => (
            <li key={item.field}>
              <span className="text-white/90">{item.field}:</span>{" "}
              <span className="font-mono text-[12px]">{item.current}</span>
              <p className="text-[12px] text-white/50">{item.note}</p>
            </li>
          ))}
          {data?.legalReviewPending && (
            <li className="text-[12px] text-white/50">
              Legal pages are product-ready templates and have not been reviewed by external
              counsel.
            </li>
          )}
        </ul>
      </section>

      <section className="space-y-2">
        <h2 className="text-xs font-semibold uppercase tracking-[0.2em] text-white/50">
          URLs for provider forms
        </h2>
        <Copyable label="Website" value={REVIEW_URLS.website} />
        <Copyable label="Privacy Policy URL" value={REVIEW_URLS.privacy} />
        <Copyable label="Terms of Service URL" value={REVIEW_URLS.terms} />
        <Copyable label="Data Deletion URL" value={REVIEW_URLS.dataDeletion} />
        <Copyable label="Support URL" value={REVIEW_URLS.support} />
        <Copyable label="Social login info URL" value={REVIEW_URLS.socialAuthInfo} />
        <Copyable label="App redirect (front end)" value={REVIEW_URLS.callback} />
        {data?.backendCallbackUrl && (
          <Copyable label="OAuth redirect URI (register at provider)" value={data.backendCallbackUrl} />
        )}
        <Copyable label="App icon 1024×1024" value={REVIEW_URLS.appIcon} />
        <Copyable label="Social preview 1200×630" value={REVIEW_URLS.ogImage} />
        <Copyable label="Support email" value={REVIEW_URLS.supportEmail} />
      </section>

      <section className="space-y-4">
        <h2 className="text-xs font-semibold uppercase tracking-[0.2em] text-white/50">
          Providers
        </h2>
        {SOCIAL_PROVIDERS.map((p) => {
          const state = data?.providers.find((r) => r.id === p.id);
          return (
            <div
              key={p.id}
              className="space-y-3 rounded-2xl border border-white/[0.08] bg-white/[0.02] p-4"
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h3 className="font-display text-lg font-semibold text-white">{p.label}</h3>
                <span className="rounded-full border border-white/10 px-2.5 py-0.5 text-[11px] uppercase tracking-[0.14em] text-white/70">
                  {PROVIDER_STATUS_LABEL[state?.status ?? "not_configured"]}
                </span>
              </div>

              <div className="flex flex-wrap gap-x-5 gap-y-1">
                <Flag ok={!!state?.hasClientId}>{p.credentialEnv.clientId}</Flag>
                <Flag ok={!!state?.hasClientSecret}>{p.credentialEnv.clientSecret}</Flag>
                <Flag ok={!!state?.loginEnabled}>Login enabled</Flag>
              </div>

              <div>
                <p className="text-[10px] uppercase tracking-[0.16em] text-white/40">
                  Scopes requested
                </p>
                <p className="font-mono text-[12px] text-white/75">
                  {p.scopes.length ? p.scopes.join(", ") : "none"}
                </p>
              </div>

              <div>
                <p className="text-[10px] uppercase tracking-[0.16em] text-white/40">
                  Prerequisites
                </p>
                <ul className="ml-4 list-disc space-y-1 text-[13px] text-white/65 marker:text-white/30">
                  {p.reviewPrerequisites.map((r) => (
                    <li key={r}>{r}</li>
                  ))}
                </ul>
              </div>

              <div>
                <div className="flex items-center justify-between">
                  <p className="text-[10px] uppercase tracking-[0.16em] text-white/40">
                    Use-case description for reviewers
                  </p>
                  <button
                    type="button"
                    onClick={() => {
                      void navigator.clipboard.writeText(p.reviewDescription);
                      toast.success("Description copied");
                    }}
                    className="flex items-center gap-1 rounded-md border border-white/10 px-2 py-1 text-[11px] text-white/70 hover:text-white"
                  >
                    <Copy className="h-3 w-3" /> Copy
                  </button>
                </div>
                <p className="mt-1 rounded-lg border border-white/[0.06] bg-black/40 p-3 text-[13px] leading-relaxed text-white/70">
                  {p.reviewDescription}
                </p>
              </div>

              <a
                href={p.docsUrl}
                target="_blank"
                rel="noreferrer"
                className="inline-block text-[12px] text-cyan-300 hover:text-white"
              >
                Provider documentation →
              </a>
            </div>
          );
        })}
      </section>

      <section>
        <h2 className="text-xs font-semibold uppercase tracking-[0.2em] text-white/50">
          Manual test checklist before submission
        </h2>
        <ul className="mt-3 ml-4 list-disc space-y-1.5 text-[13px] text-white/65 marker:text-white/30">
          {REVIEW_TEST_CHECKLIST.map((t) => (
            <li key={t}>{t}</li>
          ))}
        </ul>
      </section>
    </div>
  );
}
