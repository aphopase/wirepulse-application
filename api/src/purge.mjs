import { audit } from "./db.mjs";

// Everything a workspace owns, children before parents. The audit trail (audit_events, audit_anchors) is not here: it is append-only
// evidence and outlives the content, attached to the workspace row that stays behind as a tombstone.
const TABLES = ["outbox", "webhooks", "test_reports", "test_jobs", "resource_versions", "test_suites", "shared_profiles", "gateways", "api_keys", "workspace_invitations", "workspace_members", "workspace_usage"];
const BATCH = 1000;
const MAX_SLICES = 50;
const MAX_WORKSPACES = 10;

// Removes the content of offboarded workspaces once their grace period is over. Safe on every instance: a workspace is worked on
// under its row lock with SKIP LOCKED, in slices of at most BATCH rows per table, so no transaction is large and no two instances
// share a workspace. The tombstone is marked purged (with its audit event) only by the slice that finds nothing left.
export function startPurge({ db, config, log, metrics }) {
  let running = null; let stopped = false;

  async function slice(workspaceId) {
    return db.transaction(async (client) => {
      // Re-checked under the lock (the list above was read earlier): a restore takes this lock too and needs the deadline not to
      // have passed, so a workspace is either restored or purged, never both.
      const locked = await client.query("SELECT 1 FROM workspaces WHERE id = $1 AND deleted_at IS NOT NULL AND purged_at IS NULL AND purge_after <= now() FOR NO KEY UPDATE SKIP LOCKED", [workspaceId]);
      if (!locked.rowCount) return null;
      let removed = 0;
      for (const table of TABLES) {
        removed += (await client.query(`DELETE FROM ${table} WHERE ctid IN (SELECT ctid FROM ${table} WHERE workspace_id = $1 LIMIT $2)`, [workspaceId, BATCH])).rowCount;
      }
      if (removed > 0) return { done: false };
      await client.query("UPDATE workspaces SET purged_at = now(), name = 'purged workspace' WHERE id = $1", [workspaceId]);
      await audit(client, { workspaceId, actor: "system:purge", action: "workspace.purged", resourceType: "workspace", resourceId: workspaceId, requestId: "purge", details: {} });
      return { done: true };
    });
  }

  async function runOnce() {
    if (running) return running;
    running = (async () => {
      let purged = 0;
      try {
        const due = (await db.query("SELECT id FROM workspaces WHERE deleted_at IS NOT NULL AND purged_at IS NULL AND purge_after <= now() ORDER BY purge_after LIMIT $1", [MAX_WORKSPACES])).rows;
        for (const { id } of due) {
          for (let i = 0; i < MAX_SLICES && !stopped; i += 1) {
            const result = await slice(id);
            if (!result) break;
            if (result.done) { purged += 1; metrics.workspacesPurged.inc(); log.info({ event: "workspace.purged", workspaceId: id }, "workspace purged"); break; }
          }
        }
      } catch (error) { log.error({ err: error }, "workspace purge failed"); } finally { running = null; }
      return purged;
    })();
    return running;
  }

  const timer = setInterval(() => { if (!stopped) runOnce(); }, config.saas.purgeIntervalMs);
  timer.unref();
  return { async stop() { stopped = true; clearInterval(timer); await running; }, runOnce };
}
