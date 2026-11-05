// Isolated PostgreSQL/WASM verification, no production credentials or RPC calls.
// Use @electric-sql/pglite 0.5.8 installed outside the app, passed as argv[2].
import { readFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolve } from "node:path";
const { PGlite } = await import(
  process.argv[2] ? pathToFileURL(resolve(process.argv[2])).href : "@electric-sql/pglite"
);
const root = fileURLToPath(new URL("../../", import.meta.url));
const db = new PGlite();
try {
  for (const file of [
    "supabase/tests/execution_ledgers_local_bootstrap.sql",
    "supabase/tests/synfutures_registration_local_setup.sql",
    "supabase/migrations/20260927164603_synfutures_setup_drafts.sql",
    "supabase/migrations/20260929034436_synfutures_verified_account_registration.sql",
    "supabase/tests/synfutures_registration_local_test.sql",
  ]) {
    const result = await db.exec(await readFile(resolve(root, file), "utf8"));
    console.log(file, "PASS", result.at(-1)?.rows ?? []);
  }
  console.log((await db.query("select version() as engine")).rows);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  await db.close();
}
