import { audit } from "./db.mjs";

const LOCK = 727275;
const BATCH = 1000;
const MAX_BATCHES = 50;

// created_at is the transaction start time, so concurrent writers can be ordered differently by time and by chain_seq.
// Only a contiguous prefix of each workspace's chain is removed, so the remaining chain still verifies without gaps.
const AUDIT_PURGE_SQL = `
  WITH bounds AS (SELECT workspace_id, min(chain_seq) AS first_kept FROM audit_events WHERE created_at >= now() - make_interval(days => $1) GROUP BY workspace_id)
  DELETE FROM audit_events WHERE id IN (
    SELECT e.id FROM audit_events e LEFT JOIN bounds b ON b.workspace_id = e.workspace_id
    WHERE e.created_at < now() - make_interval(days => $1) AND e.chain_seq < COALESCE(b.first_kept, 9223372036854775807)
    ORDER BY e.workspace_id, e.chain_seq LIMIT $2)
  RETURNING workspace_id`;

// Deletes expired jobs, reports, and audit rows. Disabled unless the matching RETENTION_DAYS_* is set.
// Only one instance runs at a time (advisory lock). Audit rows can be deleted only inside a transaction
// that sets wirepulse.retention, which the append-only trigger honours; every purge is itself audited.
export function startRetention({ db, config, log, metrics }) {
  const { jobsDays, reportsDays, auditDays, intervalHours } = config.retention;
  const enabled = jobsDays > 0 || reportsDays > 0 || auditDays > 0;
  let running = false;

  async function purge(kind, sql, days) {
    let total = 0;
    for (let batch = 0; batch < MAX_BATCHES; batch += 1) {
      const deleted = await db.transaction(async (client) => {
        const locked = await client.query("SELECT pg_try_advisory_xact_lock($1) AS ok", [LOCK]);
        if (!locked.rows[0].ok) return null;
        await client.query("SET LOCAL wirepulse.retention = 'on'");
        const result = await client.query(sql, [days, BATCH]);
        const perWorkspace = new Map();
        for (const row of result.rows) perWorkspace.set(row.workspace_id, (perWorkspace.get(row.workspace_id) ?? 0) + 1);
        for (const workspaceId of [...perWorkspace.keys()].sort()) {
          await audit(client, { workspaceId, actor: "system:retention", action: "retention.purged", resourceType: kind, requestId: "retention", details: { kind, rows: perWorkspace.get(workspaceId), olderThanDays: days } });
        }
        return result.rowCount;
      });
      if (deleted === null) return total;
      total += deleted;
      if (deleted < BATCH) break;
    }
    if (total) { metrics.retentionDeleted.inc({ kind }, total); log.info({ kind, rows: total, olderThanDays: days }, "retention purge"); }
    return total;
  }

  async function runOnce() {
    if (running || !enabled) return;
    running = true;
    try {
      if (jobsDays > 0) await purge("test_job", "DELETE FROM test_jobs WHERE id IN (SELECT id FROM test_jobs WHERE finished_at < now() - make_interval(days => $1) AND status NOT IN ('queued', 'assigned', 'running') ORDER BY finished_at LIMIT $2) RETURNING workspace_id", jobsDays);
      if (reportsDays > 0) await purge("test_report", "DELETE FROM test_reports WHERE id IN (SELECT id FROM test_reports WHERE created_at < now() - make_interval(days => $1) ORDER BY created_at LIMIT $2) RETURNING workspace_id", reportsDays);
      if (auditDays > 0) await purge("audit_event", AUDIT_PURGE_SQL, auditDays);
    } catch (error) { log.error({ err: error }, "retention run failed"); } finally { running = false; }
  }

  if (!enabled) return { stop() {}, runOnce };
  const timer = setInterval(runOnce, intervalHours * 3_600_000);
  timer.unref();
  const first = setTimeout(runOnce, 60_000);
  first.unref();
  return { stop() { clearInterval(timer); clearTimeout(first); }, runOnce };
}
