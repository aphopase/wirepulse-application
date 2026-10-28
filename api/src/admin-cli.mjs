// Operator commands for a SaaS deployment. Run where the API's environment is (same DATABASE_URL), for example
//   docker compose exec api node src/admin-cli.mjs plan set <workspaceId> team
// Every change is written to the workspace's audit trail with the operator's OS user name as the actor. Output is JSON on stdout.
//   plan show <workspaceId>                 plan, limits and current usage
//   plan set <workspaceId> <plan>           move a workspace to free | team | business | enterprise
//   workspace list [--deleted]              workspaces (or those waiting for purge), newest first, at most 200
//   workspace restore <workspaceId>         undo an offboarding while the grace period lasts (the workspace returns without its
//                                           API keys, gateways and invitations, which were revoked; webhooks come back disabled)
import os from "node:os";
import { ConfigError, loadConfig } from "./config.mjs";
import { audit, createDatabase } from "./db.mjs";
import { createLogger } from "./log.mjs";
import { PLAN_NAMES, limitsFor } from "./plans.mjs";
import { usageOf } from "./quota.mjs";

class Refused extends Error {}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const USAGE = "usage: admin-cli plan show <workspaceId> | plan set <workspaceId> <plan> | workspace list [--deleted] | workspace restore <workspaceId>";

const [group, verb, ...rest] = process.argv.slice(2);
const workspaceId = rest[0];
const valid = (group === "plan" && verb === "show" && rest.length === 1 && UUID.test(workspaceId))
  || (group === "plan" && verb === "set" && rest.length === 2 && UUID.test(workspaceId) && PLAN_NAMES.includes(rest[1]))
  || (group === "workspace" && verb === "list" && (rest.length === 0 || (rest.length === 1 && rest[0] === "--deleted")))
  || (group === "workspace" && verb === "restore" && rest.length === 1 && UUID.test(workspaceId));
if (!valid) { console.error(`${USAGE}\nplans: ${PLAN_NAMES.join(", ")}`); process.exit(2); }

let config;
try { config = loadConfig(); } catch (error) {
  if (error instanceof ConfigError) { console.error(error.message); process.exit(1); }
  throw error;
}
const log = createLogger({ level: "silent" });
const db = createDatabase({ url: config.databaseUrl, poolSize: 2, ssl: config.db.ssl, connectTimeoutMs: config.db.connectTimeoutMs, log });
const actor = (() => { try { return `operator:${os.userInfo().username}`; } catch { return `operator:${process.env.USER ?? "unknown"}`; } })();

// The workspace row is locked first, like everywhere else, and the audit event is the last statement.
const inWorkspace = (fn) => db.transaction(async (client) => {
  const row = (await client.query("SELECT id, name, plan, created_at, deleted_at, purge_after, purged_at FROM workspaces WHERE id = $1 FOR NO KEY UPDATE", [workspaceId])).rows[0];
  if (!row) throw new Refused("workspace not found");
  return fn(client, row);
});
const record = (client, action, details) => audit(client, { workspaceId, actor, action, resourceType: "workspace", resourceId: workspaceId, requestId: "admin-cli", details });

try {
  let result;
  if (group === "plan" && verb === "show") {
    const row = (await db.query("SELECT id, name, plan, deleted_at, purge_after, purged_at FROM workspaces WHERE id = $1", [workspaceId])).rows[0];
    if (!row) throw new Refused("workspace not found");
    result = { id: row.id, name: row.name, plan: row.plan, limits: limitsFor(row.plan), usage: await usageOf(db, row.id), deletedAt: row.deleted_at, purgeAfter: row.purge_after, purgedAt: row.purged_at };
  } else if (group === "plan") {
    const plan = rest[1];
    result = await inWorkspace(async (client, row) => {
      if (row.purged_at) throw new Refused("workspace was purged");
      if (row.plan === plan) return { id: row.id, plan, changed: false };
      await client.query("UPDATE workspaces SET plan = $2 WHERE id = $1", [workspaceId, plan]);
      await record(client, "workspace.plan_changed", { from: row.plan, to: plan });
      return { id: row.id, plan, previous: row.plan, changed: true, limits: limitsFor(plan) };
    });
  } else if (verb === "list") {
    const deletedOnly = rest[0] === "--deleted";
    const rows = (await db.query(`SELECT id, name, plan, created_by, created_at, deleted_at, deleted_by, purge_after, purged_at FROM workspaces ${deletedOnly ? "WHERE deleted_at IS NOT NULL" : ""} ORDER BY created_at DESC LIMIT 200`)).rows;
    result = rows.map((row) => ({ id: row.id, name: row.name, plan: row.plan, createdBy: row.created_by, createdAt: row.created_at, deletedAt: row.deleted_at, deletedBy: row.deleted_by, purgeAfter: row.purge_after, purgedAt: row.purged_at }));
  } else {
    result = await inWorkspace(async (client, row) => {
      if (!row.deleted_at) throw new Refused("workspace is not deleted");
      if (row.purged_at) throw new Refused("workspace was purged; its content is gone");
      // The purge worker takes the same row lock and requires the deadline to have passed, so past the deadline it is too late
      // even if the purge has not run yet: it may already be removing content. The database clock decides, in the same statement.
      const restored = await client.query("UPDATE workspaces SET deleted_at = NULL, deleted_by = NULL, purge_after = NULL WHERE id = $1 AND purge_after > now()", [workspaceId]);
      if (!restored.rowCount) throw new Refused("the grace period is over; the content is being purged");
      await record(client, "workspace.restored", { deletedAt: row.deleted_at });
      return { id: row.id, name: row.name, restored: true };
    });
  }
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  if (error instanceof Refused) { console.error(error.message); process.exitCode = 1; }
  else { console.error(`failed: ${error.message}`); process.exitCode = 1; }
} finally { await db.close(); }
