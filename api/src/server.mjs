import { createApp } from "./app.mjs";
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
for (const warning of config.warnings) log.warn({ config: true }, warning);

const db = createDatabase({ url: config.databaseUrl, poolSize: config.db.poolSize, ssl: config.db.ssl, statementTimeoutMs: config.db.statementTimeoutMs, idleTxTimeoutMs: config.db.idleTxTimeoutMs, connectTimeoutMs: config.db.connectTimeoutMs, log });
let instance;
try {
  if (config.migrateOnStart) await migrate(db, { log });
  else {
    const pending = await pendingMigrations(db);
    if (pending.length) throw new Error(`database schema is behind (${pending.join(", ")}); run "npm run migrate" or set MIGRATE_ON_START=true`);
  }
  instance = createApp({ config, db, log });
  const { port } = await instance.start();
  log.info({ port, production: config.production, metricsPort: config.metrics.port || undefined }, "WirePulse API listening");
} catch (error) {
  log.fatal({ err: error }, "startup failed");
  await db.close().catch(() => {});
  process.exit(1);
}

let stopping = false;
async function stop(reason, exitCode) {
  if (stopping) return;
  stopping = true;
  log.info({ reason }, "shutting down");
  setTimeout(() => process.exit(exitCode || 1), 20_000).unref();
  try { await instance.shutdown(); } catch (error) { log.error({ err: error }, "shutdown error"); }
  process.exit(exitCode);
}
process.once("SIGTERM", () => stop("SIGTERM", 0));
process.once("SIGINT", () => stop("SIGINT", 0));
process.on("unhandledRejection", (error) => { log.fatal({ err: error }, "unhandled rejection"); stop("unhandledRejection", 1); });
process.on("uncaughtException", (error) => { log.fatal({ err: error }, "uncaught exception"); stop("uncaughtException", 1); });
