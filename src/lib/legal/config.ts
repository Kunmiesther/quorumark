/**
 * Centralised legal / support configuration.
 *
 * Everything a public legal page needs comes from here so there is exactly
 * ONE place to correct company details, contact addresses and dates. No page
 * invents its own email address or entity name.
 *
 * OWNER CONFIRMATION REQUIRED for every field marked `needsOwnerConfirmation`.
 * Those values are placeholders chosen because no verified value exists in
 * project configuration — they are surfaced in /admin/social-integrations.
 */

export const SITE_URL = "https://quorumark.example";

/** Legal entity name. Not verified from any project artefact. */
export const COMPANY_NAME = "Quorumark";
export const COMPANY_NAME_NEEDS_CONFIRMATION = true;

export const PRODUCT_NAME = "Quorumark";

/**
 * Support inbox. No verified support address exists in project configuration,
 * so this is a single centralised placeholder rather than scattered invented
 * addresses. Replace here and every page updates.
 */
export const SUPPORT_EMAIL = "support@quorumark.example";
export const SUPPORT_EMAIL_NEEDS_CONFIRMATION = true;

export const PRIVACY_EMAIL = SUPPORT_EMAIL;

/** Dates shown on every legal document. */
export const EFFECTIVE_DATE = "2026-08-03";
export const LAST_UPDATED = "2026-08-03";

/**
 * Internal-only flag. These documents are product-ready templates; they are
 * NOT a representation that external counsel reviewed them. Surfaced only in
 * the admin kit — never rendered to consumers.
 */
export const LEGAL_REVIEW_PENDING = true;

export const LEGAL_ROUTES = {
  privacy: "/privacy",
  terms: "/terms",
  dataDeletion: "/data-deletion",
  support: "/support",
  riskDisclosure: "/risk-disclosure",
} as const;

export function absoluteUrl(path: string): string {
  return `${SITE_URL}${path}`;
}

export function formatLegalDate(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y, (m ?? 1) - 1, d ?? 1)).toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
    timeZone: "UTC",
  });
}

/** Fields the owner still has to confirm or provide. */
export const OWNER_CONFIRMATION_ITEMS = [
  {
    field: "Legal entity name",
    current: COMPANY_NAME,
    needsConfirmation: COMPANY_NAME_NEEDS_CONFIRMATION,
    note: "No registered company name exists anywhere in project configuration. Confirm the exact registered name and jurisdiction.",
  },
  {
    field: "Support / privacy email",
    current: SUPPORT_EMAIL,
    needsConfirmation: SUPPORT_EMAIL_NEEDS_CONFIRMATION,
    note: "Placeholder. Provider reviewers will email this address — it must receive mail before submission.",
  },
  {
    field: "Governing jurisdiction",
    current: "Not stated in Terms",
    needsConfirmation: true,
    note: "Terms intentionally omit a governing-law clause until the owner confirms the entity's jurisdiction.",
  },
] as const;
