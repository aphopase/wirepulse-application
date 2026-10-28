import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "migrations");
const LOCK = 727274;
const BASELINE = "001_enterprise.sql";

export class MigrationError extends Error {}

// CRLF is normalized so a Windows checkout does not look like a modified migration.
const checksum = (sql) => crypto.createHash("sha256").update(sql.replace(/\r\n/g, "\n")).digest("hex");

async function loadFiles() {
  const names = (await fs.readdir(dir)).filter((name) => /^\d+_.+\.sql$/.test(name)).sort();
  return Promise.all(names.map(async (name) => { const sql = await fs.readFile(path.join(dir, name), "utf8"); return { name, sql, checksum: checksum(sql) }; }));
}

export async function pendingMigrations(db) {
  const files = await loadFiles();
  const table = await db.query("SELECT to_regclass('public.schema_migrations') IS NOT NULL AS present");
  if (!table.rows[0].present) return files.map((file) => file.name);
  const applied = new Set((await db.query("SELECT name FROM schema_migrations")).rows.map((row) => row.name));
  return files.filter((file) => !applied.has(file.name)).map((file) => file.name);
}

export async function migrate(db, { log } = {}) {
  const files = await loadFiles();
  await db.transaction(async (client) => {
    await client.query("SELECT pg_advisory_xact_lock($1)", [LOCK]);
    const state = await client.query("SELECT to_regclass('public.schema_migrations') IS NULL AS fresh, to_regclass('public.workspaces') IS NOT NULL AS has_schema");
    await client.query("CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now(), checksum text)");
    await client.query("ALTER TABLE schema_migrations ADD COLUMN IF NOT EXISTS checksum text");
    // Databases created by the original initdb-script deployment already contain the 001 schema but no history.
    if (state.rows[0].fresh && state.rows[0].has_schema) {
      await client.query("INSERT INTO schema_migrations (name) VALUES ($1) ON CONFLICT DO NOTHING", [BASELINE]);
      log?.warn({ migration: BASELINE }, "adopted existing schema as migration baseline");
    }
  });
  for (const file of files) {
    await db.transaction(async (client) => {
      await client.query("SELECT pg_advisory_xact_lock($1)", [LOCK]);
      await client.query("SET LOCAL statement_timeout = 0");
      const applied = await client.query("SELECT checksum FROM schema_migrations WHERE name = $1", [file.name]);
      if (applied.rowCount) {
        const recorded = applied.rows[0].checksum;
        if (recorded && recorded !== file.checksum) throw new MigrationError(`migration ${file.name} was modified after it was applied; add a new migration instead`);
        return;
      }
      await client.query(file.sql);
      await client.query("INSERT INTO schema_migrations (name, checksum) VALUES ($1, $2)", [file.name, file.checksum]);
      log?.info({ migration: file.name }, "applied migration");
    });
  }
}
