import type { ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { LEGAL_ROUTES, EFFECTIVE_DATE, LAST_UPDATED, formatLegalDate } from "@/lib/legal/config";

export function LegalPage({ eyebrow, title, intro, children }: { eyebrow: string; title: string; intro: string; children: ReactNode }) {
  return <main className="q-legal-page"><header><Link to="/"><span className="q-mark">Q</span></Link><Link to="/marketplace" className="q-text-link">Back to exchange</Link></header><article><p className="q-kicker">{eyebrow}</p><h1>{title}</h1><p className="q-legal-intro">{intro}</p><div className="q-legal-meta">Effective date: {formatLegalDate(EFFECTIVE_DATE)} · Last updated: {formatLegalDate(LAST_UPDATED)}</div><div className="q-legal-body">{children}</div><nav className="q-legal-links"><Link to={LEGAL_ROUTES.privacy}>Privacy</Link><Link to={LEGAL_ROUTES.terms}>Terms</Link><Link to={LEGAL_ROUTES.riskDisclosure}>Risk disclosure</Link></nav></article></main>;
}
export function LegalSection({ heading, children }: { heading: string; children: ReactNode }) { return <section><h2>{heading}</h2>{children}</section>; }
export function LegalList({ items }: { items: ReactNode[] }) { return <ul>{items.map((item, index) => <li key={index}>{item}</li>)}</ul>; }
