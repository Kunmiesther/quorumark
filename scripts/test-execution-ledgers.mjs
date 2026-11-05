// Usage: node scripts/test-execution-ledgers.mjs /absolute/path/to/pglite/dist/index.js
// An isolated in-memory PostgreSQL database; never connects to a live project.
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

if (!process.argv[2]) throw new Error('Pass the installed PGlite module path');
const { PGlite } = await import(pathToFileURL(process.argv[2]).href);
const db = new PGlite();
const sql = name => readFile(new URL(`../supabase/${name}`, import.meta.url), 'utf8');
try {
  await db.exec(await sql('tests/execution_ledgers_local_bootstrap.sql'));
  const migration = await sql('migrations/20260924070204_restore_execution_order_ledgers.sql');
  await db.exec(migration);
  // Safe to rerun on a schema already repaired; no table drops or data resets.
  await db.exec(migration);
  const reconciliation = await sql('migrations/20260924143659_aster_order_reconciliation.sql');
  await db.exec(reconciliation);
  await db.exec(reconciliation);
  const result = await db.exec(await sql('tests/execution_ledgers_local_test.sql'));
  console.log(result.at(-1).rows);
  console.log((await db.exec(await sql('tests/aster_reconciliation_local_test.sql'))).at(-1).rows);
} finally {
  await db.close();
}
