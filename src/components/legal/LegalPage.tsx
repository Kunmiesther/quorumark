import { type ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { MarketingShell } from "@/components/marketing/MarketingShell";
import { GlassCard, SectionShell } from "@/components/marketing/primitives";
import {
  EFFECTIVE_DATE,
  LAST_UPDATED,
  LEGAL_ROUTES,
  formatLegalDate,
} from "@/lib/legal/config";

/**
 * Shared shell for every public legal / support document. One layout, one
 * date block, one cross-link rail — so all six pages stay consistent and
 * mobile-responsive.
 */
export function LegalPage({
  eyebrow,
  title,
  intro,
  children,
}: {
  eyebrow: string;
  title: string;
  intro: string;
  children: ReactNode;
}) {
  return (
    <MarketingShell>
      <SectionShell className="pb-16 pt-12 sm:pt-20">
        <div className="mx-auto w-full max-w-3xl">
          <p className="text-[11px] font-semibold uppercase tracking-[0.32em] text-cyan-300/90">
            {eyebrow}
          </p>
          <h1 className="mt-3 font-display text-3xl font-semibold leading-tight tracking-tight text-white sm:text-4xl">
            {title}
          </h1>
          <p className="mt-4 text-base leading-relaxed text-white/70">{intro}</p>

          <div className="mt-6 flex flex-wrap gap-x-6 gap-y-1 text-[12px] text-white/50">
            <span>Effective date: {formatLegalDate(EFFECTIVE_DATE)}</span>
            <span>Last updated: {formatLegalDate(LAST_UPDATED)}</span>
          </div>

          <div className="mt-10 space-y-8">{children}</div>

          <GlassCard className="mt-12 p-5">
            <h2 className="text-xs font-semibold uppercase tracking-[0.24em] text-white/50">
              Related documents
            </h2>
            <ul className="mt-4 flex flex-wrap gap-x-5 gap-y-2 text-sm text-white/70">
              <li>
                <Link to={LEGAL_ROUTES.privacy} className="hover:text-white">
                  Privacy Policy
                </Link>
              </li>
              <li>
                <Link to={LEGAL_ROUTES.terms} className="hover:text-white">
                  Terms of Service
                </Link>
              </li>
              <li>
                <Link to={LEGAL_ROUTES.dataDeletion} className="hover:text-white">
                  Data Deletion
                </Link>
              </li>
              <li>
                <Link to={LEGAL_ROUTES.riskDisclosure} className="hover:text-white">
                  Risk Disclosure
                </Link>
              </li>
              <li>
                <Link to={LEGAL_ROUTES.socialAuth} className="hover:text-white">
                  Social Login
                </Link>
              </li>
              <li>
                <Link to={LEGAL_ROUTES.support} className="hover:text-white">
                  Support
                </Link>
              </li>
            </ul>
          </GlassCard>
        </div>
      </SectionShell>
    </MarketingShell>
  );
}

export function LegalSection({
  id,
  heading,
  children,
}: {
  id?: string;
  heading: string;
  children: ReactNode;
}) {
  return (
    <section id={id} className="scroll-mt-24">
      <h2 className="font-display text-xl font-semibold tracking-tight text-white sm:text-2xl">
        {heading}
      </h2>
      <div className="mt-3 space-y-3 text-sm leading-relaxed text-white/70 sm:text-[15px]">
        {children}
      </div>
    </section>
  );
}

export function LegalList({ items }: { items: ReactNode[] }) {
  return (
    <ul className="ml-4 list-disc space-y-2 marker:text-cyan-300/60">
      {items.map((item, i) => (
        <li key={i}>{item}</li>
      ))}
    </ul>
  );
}
