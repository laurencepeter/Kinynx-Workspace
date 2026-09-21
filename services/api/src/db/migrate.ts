/**
 * Minimal, dependency-free migration runner.
 * Applies every *.sql file in ../migrations in lexical order, once each,
 * tracked in the schema_migrations table. Idempotent and safe to re-run.
 */
import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getPool } from "./pool.js";

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, "..", "migrations");

export async function runMigrations(): Promise<string[]> {
  const db = getPool();
  await db.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  const files = (await readdir(migrationsDir)).filter((f) => f.endsWith(".sql")).sort();
  const applied: string[] = [];

  for (const file of files) {
    const { rows } = await db.query("SELECT 1 FROM schema_migrations WHERE name = $1", [file]);
    if (rows.length > 0) continue;

    const sql = await readFile(join(migrationsDir, file), "utf8");
    const client = await db.connect();
    try {
      await client.query("BEGIN");
      await client.query(sql);
      await client.query("INSERT INTO schema_migrations (name) VALUES ($1)", [file]);
      await client.query("COMMIT");
      applied.push(file);
      console.log(`[migrate] applied ${file}`);
    } catch (err) {
      await client.query("ROLLBACK");
      throw new Error(`Migration ${file} failed: ${(err as Error).message}`);
    } finally {
      client.release();
    }
  }
  if (applied.length === 0) console.log("[migrate] nothing to apply; schema up to date");
  return applied;
}

// Run directly: `node --experimental-strip-types src/db/migrate.ts`
if (import.meta.url === `file://${process.argv[1]}`) {
  runMigrations()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
