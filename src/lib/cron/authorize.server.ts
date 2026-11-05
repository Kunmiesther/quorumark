import { createHash, timingSafeEqual } from "node:crypto";

function digest(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

function timingSafeMatch(provided: string, expected: string): boolean {
  const a = digest(provided);
  const b = digest(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Accept any configured server-side scheduler secret. Vercel Cron always
 * sends CRON_SECRET; dedicated secrets remain valid for operator and legacy
 * pg_cron calls. Empty and whitespace-only values never authorize a request.
 */
export function isAuthorizedCronRequest(
  request: Request,
  candidateSecrets: ReadonlyArray<string | undefined>,
): boolean {
  const secrets = Array.from(
    new Set(
      candidateSecrets
        .map((value) => value?.trim())
        .filter((value): value is string => Boolean(value)),
    ),
  );
  if (secrets.length === 0) return false;

  const header = request.headers.get("authorization") ?? "";
  if (!header.toLowerCase().startsWith("bearer ")) return false;
  const token = header.slice(7).trim();
  if (!token) return false;
  return secrets.some((expected) => timingSafeMatch(token, expected));
}
