import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.108.2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization,x-client-info,apikey,content-type",
  "Access-Control-Allow-Methods": "POST,OPTIONS",
};

function json(status: number, body: Record<string, unknown>) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, "content-type": "application/json" },
  });
}

async function removeOwnedStorage(
  admin: ReturnType<typeof createClient>,
  bucket: string,
  prefix: string,
): Promise<void> {
  const files: string[] = [];
  const pending = [prefix];

  while (pending.length) {
    const path = pending.pop()!;
    for (let offset = 0; ; offset += 100) {
      const { data, error } = await admin.storage.from(bucket).list(path, {
        limit: 100,
        offset,
        sortBy: { column: "name", order: "asc" },
      });
      if (error) throw error;
      for (const item of data ?? []) {
        const itemPath = `${path}/${item.name}`;
        if (item.id) files.push(itemPath);
        else pending.push(itemPath);
      }
      if (!data || data.length < 100) break;
    }
  }

  for (let index = 0; index < files.length; index += 100) {
    const { error } = await admin.storage.from(bucket).remove(files.slice(index, index + 100));
    if (error) throw error;
  }
}

Deno.serve(async (request: Request) => {
  if (request.method === "OPTIONS") return new Response(null, { headers: cors });
  if (request.method !== "POST") return json(405, { ok: false, message: "POST required." });

  const url = Deno.env.get("SUPABASE_URL");
  const serviceRole = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !serviceRole) {
    return json(500, { ok: false, message: "Account deletion is temporarily unavailable." });
  }

  const token = (request.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  const admin = createClient(url, serviceRole, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: auth, error: authError } = await admin.auth.getUser(token);
  if (authError || !auth.user) {
    return json(401, { ok: false, message: "Sign in again before deleting your account." });
  }

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return json(400, { ok: false, message: "Invalid request." });
  }
  if (body.confirmation !== "DELETE") {
    return json(400, { ok: false, message: "Type DELETE to confirm permanent deletion." });
  }

  // Storage objects can prevent Auth deletion and are not removed by table
  // cascades. Both user-owned buckets use the authenticated user id as their
  // top-level prefix, so remove only that caller's objects before deleting.
  try {
    await Promise.all([
      removeOwnedStorage(admin, "avatars", auth.user.id),
      removeOwnedStorage(admin, "bill-proofs", auth.user.id),
    ]);
  } catch (error) {
    console.error("delete-account storage cleanup failed", {
      userId: auth.user.id,
      message: error instanceof Error ? error.message : "unknown",
    });
    return json(500, {
      ok: false,
      message:
        "We could not remove all account files. The account remains active; please try again.",
    });
  }

  // Hard-delete the authenticated caller only. User-owned tables cascade
  // from auth.users; any constraint failure fails closed.
  const { error } = await admin.auth.admin.deleteUser(auth.user.id, false);
  if (error) {
    console.error("delete-account failed", { userId: auth.user.id, message: error.message });
    return json(500, {
      ok: false,
      message: "We could not delete the account. No partial deletion was reported.",
    });
  }

  return json(200, { ok: true });
});
