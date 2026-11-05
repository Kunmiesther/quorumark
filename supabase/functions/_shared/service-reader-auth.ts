/** Server-only reader authorization. Never trust a decoded JWT role alone. */
function exactSecretMatch(provided: string, expected: string): boolean {
  const a = new TextEncoder().encode(provided);
  const b = new TextEncoder().encode(expected);
  if (a.length !== b.length || b.length === 0) return false;
  let difference = 0;
  for (let index = 0; index < a.length; index++) difference |= a[index] ^ b[index];
  return difference === 0;
}

export function isAuthorizedServiceReader(
  request: Request,
  legacyServiceKey: string | undefined,
  secretKeysJson: string | undefined,
): boolean {
  const authorization = request.headers.get("authorization") ?? "";
  if (legacyServiceKey && authorization.startsWith("Bearer ") &&
      exactSecretMatch(authorization.slice(7).trim(), legacyServiceKey)) return true;

  // Supabase injects the project's named secret keys into the edge runtime.
  // Accept only an exact configured secret key, never a publishable/anon key
  // or unverified claims. This also supports overlapping credential rotation.
  const apiKey = request.headers.get("apikey") ?? "";
  if (!apiKey.startsWith("sb_secret_") || !secretKeysJson) return false;
  try {
    const keys: unknown = JSON.parse(secretKeysJson);
    if (!keys || typeof keys !== "object" || Array.isArray(keys)) return false;
    return Object.values(keys).some(key => typeof key === "string" &&
      key.startsWith("sb_secret_") && exactSecretMatch(apiKey, key));
  } catch {
    return false;
  }
}
