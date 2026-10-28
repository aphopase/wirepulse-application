import { HttpError } from "./http.mjs";
import { limitsFor } from "./plans.mjs";

const METERS = new Set(["jobs_created", "reports_created"]);
const PERIOD = "date_trunc('month', now() AT TIME ZONE 'UTC')::date";

// Serializes every quota decision for one workspace: concurrent requests queue here, so "count, then insert" cannot overshoot.
// FOR NO KEY UPDATE does not conflict with the key-share locks that foreign-key checks take, and the audit insert stays the last
// statement of the transaction, so the lock order (workspace row, then audit chain) is the same everywhere.
export async function lockWorkspace(client, workspaceId) {
  const row = (await client.query("SELECT plan FROM workspaces WHERE id = $1 AND deleted_at IS NULL FOR NO KEY UPDATE", [workspaceId])).rows[0];
  if (!row) throw new HttpError(404, "workspace_not_found");
  return { plan: row.plan, limits: limitsFor(row.plan) };
}

// `limit` of null is unlimited.
export function enforce({ plan }, resource, limit, current) {
  if (limit !== null && current >= limit) throw new HttpError(403, "plan_limit_reached", { resource, plan, limit });
}

export async function meter(client, workspaceId, column) {
  if (!METERS.has(column)) throw new Error(`unknown meter ${column}`);
  await client.query(
    `INSERT INTO workspace_usage (workspace_id, period, ${column}) VALUES ($1, ${PERIOD}, 1)
     ON CONFLICT (workspace_id, period) DO UPDATE SET ${column} = workspace_usage.${column} + 1`,
    [workspaceId]
  );
}

export async function usageOf(executor, workspaceId) {
  const counts = (await executor.query(
    `SELECT
       (SELECT count(*)::int FROM workspace_members WHERE workspace_id = $1) AS members,
       (SELECT count(*)::int FROM workspace_invitations WHERE workspace_id = $1 AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > now()) AS pending_invitations,
       (SELECT count(*)::int FROM gateways WHERE workspace_id = $1 AND revoked_at IS NULL) AS gateways,
       (SELECT count(*)::int FROM api_keys WHERE workspace_id = $1 AND revoked_at IS NULL AND expires_at > now()) AS api_keys,
       (SELECT count(*)::int FROM webhooks WHERE workspace_id = $1) AS webhooks,
       (SELECT count(*)::int FROM test_jobs WHERE workspace_id = $1 AND status = 'queued') AS queued_jobs,
       COALESCE((SELECT jobs_created FROM workspace_usage WHERE workspace_id = $1 AND period = ${PERIOD}), 0) AS jobs_this_month,
       COALESCE((SELECT reports_created FROM workspace_usage WHERE workspace_id = $1 AND period = ${PERIOD}), 0) AS reports_this_month,
       ${PERIOD}::text AS period`,
    [workspaceId]
  )).rows[0];
  return {
    period: counts.period, members: counts.members, pendingInvitations: counts.pending_invitations, gateways: counts.gateways, apiKeys: counts.api_keys, webhooks: counts.webhooks,
    queuedJobs: counts.queued_jobs, jobsThisMonth: counts.jobs_this_month, reportsThisMonth: counts.reports_this_month
  };
}
