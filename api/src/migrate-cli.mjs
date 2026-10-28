// Applies pending migrations and exits. Use with MIGRATE_ON_START=false for controlled release pipelines.
import { ConfigError, loadConfig } from "./config.mjs";
import { createDatabase } from "./db.mjs";
import { createLogger } from "./log.mjs";
import { migrate, pendingMigrations } from "./migrate.mjs";

let config;
try { config = loadConfig(); } catch (error) {
  if (error instanceof ConfigError) { console.error(error.message); process.exit(1); }
  throw error;
}
const log = createLogger({ level: config.logLevel });
const db = createDatabase({ url: config.databaseUrl, poolSize: 2, ssl: config.db.ssl, connectTimeoutMs: config.db.connectTimeoutMs, log });
try {
  if (process.argv.includes("--status")) { const pending = await pendingMigrations(db); log.info({ pending }, pending.length ? "migrations pending" : "schema is up to date"); process.exitCode = pending.length ? 2 : 0; }
  else { await migrate(db, { log }); log.info("schema is up to date"); }
} catch (error) { log.error({ err: error }, "migration failed"); process.exitCode = 1; }
finally { await db.close(); }
