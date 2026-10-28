import { z } from "zod";
import { CURSOR_AT, HttpError, JOB_COLUMNS, JOB_DETAIL_COLUMNS, decodeCursor, encodeCursor, h, parseLimit, publicJob } from "./http.mjs";
import { canonicalize } from "./evidence.mjs";
import { sha256 } from "./auth.mjs";
import { toJunit } from "./junit.mjs";
import { enqueueWebhooks } from "./outbox.mjs";
import { enforce, lockWorkspace, meter, usageOf } from "./quota.mjs";

const STATUSES = ["queued", "assigned", "running", "passed", "failed", "stopped", "cancelled", "timed_out"];
const labelsSchema = z.record(z.string().min(1).max(64), z.string().max(128)).refine((labels) => Object.keys(labels).length <= 20, "at most 20 labels");
const jobSchema = z.object({
  suiteId: z.string().uuid().nullable().optional(),
  profileId: z.string().uuid().nullable().optional(),
  definition: z.record(z.string(), z.unknown()),
  idempotencyKey: z.string().trim().min(1).max(200),
  priority: z.number().int().min(-10).max(10).optional(),
  requirements: labelsSchema.optional(),
  maxAttempts: z.number().int().min(1).max(10).optional()
}).strict();

export function registerJobRoutes(app, { db, config, auth, apiAudit, metrics, stream }) {
  const base = "/v1/workspaces/:workspaceId/test-jobs";

  app.get(base, auth.requireRole("viewer"), h(async (req, res) => {
    const limit = parseLimit(req.query.limit, { fallback: 50, max: 100 });
    const cursor = decodeCursor(req.query.cursor);
    const status = req.query.status === undefined ? null : z.enum(STATUSES).parse(req.query.status);
    const suiteId = req.query.suiteId === undefined ? null : z.string().uuid().parse(req.query.suiteId);
    const rows = (await db.query(
      `SELECT ${JOB_COLUMNS}, ${CURSOR_AT} FROM test_jobs WHERE workspace_id = $1 AND ($2::text IS NULL OR status = $2) AND ($3::uuid IS NULL OR suite_id = $3)
         AND ($4::timestamptz IS NULL OR (created_at, id) < ($4::timestamptz, $5::uuid))
       ORDER BY created_at DESC, id DESC LIMIT $6`,
      [req.workspaceId, status, suiteId, cursor?.at ?? null, cursor?.id ?? null, limit + 1]
    )).rows;
    if (rows.length > limit) { rows.length = limit; res.set("x-next-cursor", encodeCursor(rows.at(-1).cursor_at, rows.at(-1).id)); }
    res.json(rows.map((row) => publicJob(row)));
  }));

  // Live updates for the workspace as Server-Sent Events; clients authenticate with a normal Authorization header (fetch streaming).
  app.get(`${base}/stream`, auth.requireRole("viewer"), (req, res, next) => stream.attach(req, res, next));

  app.post(base, auth.requireRole("engineer"), h(async (req, res) => {
    const body = jobSchema.parse(req.body);
    const definition = { ...body.definition, executionMode: "gateway" };
    const definitionHash = sha256(canonicalize(definition));
    const created = await db.transaction(async (client) => {
      // Quota checks run under the workspace lock, so concurrent submissions cannot overshoot a limit.
      const plan = await lockWorkspace(client, req.workspaceId);
      const usage = await usageOf(client, req.workspaceId);
      let suiteVersion = null; let profileVersion = null;
      if (body.suiteId) {
        const suite = await client.query("SELECT version FROM test_suites WHERE id = $1 AND workspace_id = $2", [body.suiteId, req.workspaceId]);
        if (!suite.rowCount) throw new HttpError(404, "suite_not_found");
        suiteVersion = suite.rows[0].version;
      }
      if (body.profileId) {
        const profile = await client.query("SELECT version FROM shared_profiles WHERE id = $1 AND workspace_id = $2", [body.profileId, req.workspaceId]);
        if (!profile.rowCount) throw new HttpError(404, "profile_not_found");
        profileVersion = profile.rows[0].version;
      }
      const inserted = await client.query(
        `INSERT INTO test_jobs (workspace_id, suite_id, suite_version, profile_id, profile_version, requested_by, idempotency_key, definition, definition_hash, requirements, priority, max_attempts)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) ON CONFLICT (workspace_id, idempotency_key) DO NOTHING RETURNING ${JOB_COLUMNS}`,
        [req.workspaceId, body.suiteId ?? null, suiteVersion, body.profileId ?? null, profileVersion, req.identity.subject, body.idempotencyKey, definition, definitionHash, body.requirements ?? {}, body.priority ?? 0, body.maxAttempts ?? config.jobs.maxAttempts]
      );
      if (!inserted.rowCount) {
        const existing = (await client.query(`SELECT ${JOB_COLUMNS} FROM test_jobs WHERE workspace_id = $1 AND idempotency_key = $2`, [req.workspaceId, body.idempotencyKey])).rows[0];
        if (existing.definition_hash !== definitionHash) throw new HttpError(409, "idempotency_key_reused", { jobId: existing.id });
        return { row: existing, replay: true };
      }
      const queueLimit = Math.min(config.limits.maxQueuedJobs, plan.limits.queuedJobs ?? Infinity);
      if (usage.queuedJobs >= queueLimit) throw new HttpError(429, "queue_full", { limit: queueLimit });
      enforce(plan, "jobs_per_month", plan.limits.jobsPerMonth, usage.jobsThisMonth);
      await meter(client, req.workspaceId, "jobs_created");
      await apiAudit(req, client, { action: "test_job.created", resourceType: "test_job", resourceId: inserted.rows[0].id, details: { suiteId: body.suiteId ?? null, suiteVersion, profileVersion, definitionHash, priority: body.priority ?? 0, requirements: body.requirements ?? {} } });
      return { row: inserted.rows[0], replay: false };
    });
    if (!created.replay) metrics.jobEvents.inc({ event: "created" });
    res.status(created.replay ? 200 : 201).json(publicJob(created.row));
  }));

  app.get(`${base}/:id`, auth.requireRole("viewer"), h(async (req, res) => {
    const result = await db.query(`SELECT ${JOB_DETAIL_COLUMNS} FROM test_jobs WHERE id = $1 AND workspace_id = $2`, [req.params.id, req.workspaceId]);
    if (!result.rowCount) throw new HttpError(404, "not_found");
    res.json(publicJob(result.rows[0], { detail: true }));
  }));

  app.get(`${base}/:id/junit.xml`, auth.requireRole("viewer"), h(async (req, res) => {
    const result = await db.query("SELECT id, status, created_at, finished_at, summary, result FROM test_jobs WHERE id = $1 AND workspace_id = $2", [req.params.id, req.workspaceId]);
    if (!result.rowCount) throw new HttpError(404, "not_found");
    const job = result.rows[0];
    if (!job.result) throw new HttpError(409, "job_has_no_results", { status: job.status });
    res.type("application/xml").send(toJunit({ name: `wirepulse-job-${job.id}`, results: job.result.results, timestamp: job.finished_at ?? job.created_at, evidenceFinalHash: job.summary?.evidenceFinalHash }));
  }));

  app.post(`${base}/:id/cancel`, auth.requireRole("engineer"), h(async (req, res) => {
    const cancelled = await db.transaction(async (client) => {
      const result = await client.query(`UPDATE test_jobs SET status = 'cancelled', lease_expires_at = NULL, finished_at = now(), version = version + 1 WHERE id = $1 AND workspace_id = $2 AND status IN ('queued', 'assigned', 'running') RETURNING ${JOB_COLUMNS}`, [req.params.id, req.workspaceId]);
      if (!result.rowCount) return null;
      await enqueueWebhooks(client, req.workspaceId, "job.finished", publicJob(result.rows[0]));
      await apiAudit(req, client, { action: "test_job.cancelled", resourceType: "test_job", resourceId: req.params.id });
      return result.rows[0];
    });
    if (!cancelled) throw new HttpError(409, "job_not_cancellable");
    metrics.jobEvents.inc({ event: "cancelled" });
    res.json(publicJob(cancelled));
  }));
}
