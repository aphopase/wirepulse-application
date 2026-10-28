import { z } from "zod";
import { audit } from "./db.mjs";
import { HttpError, JOB_COLUMNS, h, publicJob } from "./http.mjs";
import { canonicalize, verifyEvidence } from "./evidence.mjs";
import { sha256 } from "./auth.mjs";
import { enqueueWebhooks } from "./outbox.mjs";
import { enforce, lockWorkspace, meter, usageOf } from "./quota.mjs";
import crypto from "node:crypto";

const ONLINE_SECONDS = 90;
const hash = /^[a-f0-9]{64}$/;
const labelsSchema = z.record(z.string().min(1).max(64), z.string().max(128)).refine((labels) => Object.keys(labels).length <= 20, "at most 20 labels");
const gatewaySchema = z.object({ name: z.string().trim().min(1).max(120), labels: labelsSchema.optional(), expiresInDays: z.number().int().min(1).max(3650).optional() }).strict();
const gatewayPatchSchema = z.object({ labels: labelsSchema }).strict();
const heartbeatSchema = z.object({ agentVersion: z.string().max(60).optional(), capabilities: z.record(z.string(), z.unknown()).optional() }).strict();
const progressSchema = z.object({ completed: z.number().int().nonnegative(), total: z.number().int().nonnegative() }).strict().refine((p) => p.completed <= p.total, "completed cannot exceed total");
const completeSchema = z.object({
  results: z.array(z.object({ testId: z.string(), status: z.enum(["passed", "failed", "not-run"]), attempts: z.number().int().nonnegative() }).strict()).max(10000),
  evidence: z.object({ schema: z.literal("wirepulse.test-evidence.v1"), evidenceId: z.string().uuid(), createdAt: z.string(), fingerprints: z.object({ suite: z.string().regex(hash), profile: z.string().regex(hash), engine: z.string().regex(hash) }).strict(), rootHash: z.string().regex(hash), events: z.array(z.record(z.string(), z.unknown())).min(2).max(10000), finalHash: z.string().regex(hash) }).strict()
}).strict();

export const hashToken = sha256;
export const newGatewayToken = () => `wpg_${crypto.randomBytes(32).toString("base64url")}`;

// Final job status is derived from verified evidence, never trusted from the gateway.
export function deriveOutcome(results, evidence) {
  const verification = verifyEvidence(evidence, results);
  if (!verification.valid) return { valid: false, reason: verification.reason };
  const stopped = evidence.events.at(-1).type === "run.stopped";
  const passed = results.filter((item) => item.status === "passed").length;
  const status = stopped ? "stopped" : results.length > 0 && passed === results.length ? "passed" : "failed";
  return { valid: true, status, summary: { passed, failed: results.length - passed, total: results.length, evidenceSchema: evidence.schema, evidenceFinalHash: evidence.finalHash }, verification };
}

// The gateway fingerprints exactly definition.tests and definition.profile; a mismatch means the evidence is for something else.
export function evidenceMatchesDefinition(definition, evidence) {
  return evidence.fingerprints.suite === sha256(canonicalize(definition.tests ?? [])) && evidence.fingerprints.profile === sha256(canonicalize(definition.profile ?? {}));
}

// Recovers jobs whose gateway stopped renewing its lease, and expires jobs nobody picked up.
export function startLeaseSweeper({ db, config, log, metrics }) {
  let running = false;
  async function sweep() {
    if (running) return;
    running = true;
    try {
      await db.transaction(async (client) => {
        const expired = await client.query(
          `UPDATE test_jobs SET status = CASE WHEN attempts >= max_attempts THEN 'timed_out' ELSE 'queued' END, gateway_id = NULL, lease_expires_at = NULL,
             error = 'gateway_lease_expired', finished_at = CASE WHEN attempts >= max_attempts THEN now() ELSE NULL END, version = version + 1
           WHERE status IN ('assigned', 'running') AND lease_expires_at < now() RETURNING ${JOB_COLUMNS}`
        );
        const stale = config.jobs.queueTtlSeconds > 0
          ? await client.query(`UPDATE test_jobs SET status = 'timed_out', error = 'queue_ttl_expired', finished_at = now(), version = version + 1 WHERE status = 'queued' AND created_at < now() - make_interval(secs => $1) RETURNING ${JOB_COLUMNS}`, [config.jobs.queueTtlSeconds])
          : { rows: [] };
        // Deterministic order keeps concurrent sweepers on different instances from deadlocking on the per-workspace audit lock.
        const events = [...expired.rows.map((row) => ({ row, reason: "lease_expired" })), ...stale.rows.map((row) => ({ row, reason: "queue_ttl_expired" }))]
          .sort((a, b) => (a.row.workspace_id < b.row.workspace_id ? -1 : a.row.workspace_id > b.row.workspace_id ? 1 : a.row.id < b.row.id ? -1 : 1));
        for (const { row, reason } of events) {
          metrics.jobEvents.inc({ event: row.status === "queued" ? "requeued" : "timed_out" });
          if (row.status === "timed_out") await enqueueWebhooks(client, row.workspace_id, "job.finished", publicJob(row));
          await audit(client, { workspaceId: row.workspace_id, actor: "system:sweeper", action: row.status === "queued" ? "test_job.requeued" : "test_job.timed_out", resourceType: "test_job", resourceId: row.id, requestId: "sweeper", details: { reason, attempts: row.attempts } });
        }
        if (events.length) log.warn({ requeuedOrTimedOut: events.length }, "job sweeper recovered jobs");
      });
    } catch (error) { log.error({ err: error }, "job sweep failed"); } finally { running = false; }
  }
  const timer = setInterval(sweep, config.jobs.sweepIntervalMs);
  timer.unref();
  return { stop: () => clearInterval(timer), sweepNow: sweep };
}

// Mounted behind gateway authentication, the gateway rate limiter, and the body parser (see app.mjs), so req.gateway is always set.
export function registerGatewayRoutes(app, { db, config, metrics }) {
  const lease = config.jobs.leaseSeconds;
  const withAudit = (req, client, action, resourceId, details) => audit(client, { workspaceId: req.gateway.workspace_id, actor: `gateway:${req.gateway.id}`, requestId: req.requestId, ip: req.ip, action, resourceType: "test_job", resourceId, details });

  app.post("/gateway/v1/heartbeat", h(async (req, res) => {
    const body = heartbeatSchema.parse(req.body ?? {});
    await db.query("UPDATE gateways SET last_heartbeat_at = now(), agent_version = COALESCE($2, agent_version), capabilities = COALESCE($3, capabilities) WHERE id = $1", [req.gateway.id, body.agentVersion ?? null, body.capabilities ?? null]);
    res.json({ status: "ok", leaseSeconds: lease });
  }));

  // Highest priority first, then oldest. A job is only offered to gateways whose labels contain every required label.
  app.post("/gateway/v1/jobs/claim", h(async (req, res) => {
    const job = await db.transaction(async (client) => {
      const claimed = await client.query(
        `UPDATE test_jobs SET status = 'assigned', gateway_id = $1, lease_expires_at = now() + make_interval(secs => $3), attempts = attempts + 1, error = NULL, agent_version = $4, version = version + 1
         WHERE id = (SELECT id FROM test_jobs WHERE workspace_id = $2 AND status = 'queued' AND $5::jsonb @> requirements ORDER BY priority DESC, created_at, id FOR UPDATE SKIP LOCKED LIMIT 1)
         RETURNING ${JOB_COLUMNS}, definition`,
        [req.gateway.id, req.gateway.workspace_id, lease, req.gateway.agent_version, req.gateway.labels]
      );
      if (claimed.rowCount) await withAudit(req, client, "test_job.claimed", claimed.rows[0].id, { attempt: claimed.rows[0].attempts });
      return claimed.rows[0] ?? null;
    });
    if (!job) return res.status(204).end();
    metrics.jobEvents.inc({ event: "claimed" });
    return res.json({ ...publicJob(job), definition: job.definition });
  }));

  // start, progress, and heartbeat all renew the lease; a cancelled job answers 409 so the agent stops.
  async function renew(req, res, status, progress) {
    const result = await db.query(
      `UPDATE test_jobs SET status = $4, lease_expires_at = now() + make_interval(secs => $5), progress = COALESCE($6, progress), started_at = COALESCE(started_at, now()), version = version + 1
       WHERE id = $1 AND gateway_id = $2 AND workspace_id = $3 AND status IN ('assigned', 'running') RETURNING status`,
      [req.params.id, req.gateway.id, req.gateway.workspace_id, status, lease, progress ?? null]
    );
    if (!result.rowCount) {
      const current = await db.query("SELECT status FROM test_jobs WHERE id = $1 AND workspace_id = $2 AND gateway_id = $3", [req.params.id, req.gateway.workspace_id, req.gateway.id]);
      return res.status(409).json({ error: "job_not_active", status: current.rows[0]?.status ?? null });
    }
    return res.json({ status: result.rows[0].status, leaseSeconds: lease });
  }
  app.post("/gateway/v1/jobs/:id/start", h((req, res) => renew(req, res, "running", null)));
  app.post("/gateway/v1/jobs/:id/progress", h((req, res) => renew(req, res, "running", progressSchema.parse(req.body))));

  app.post("/gateway/v1/jobs/:id/complete", h(async (req, res) => {
    const body = completeSchema.parse(req.body);
    const outcome = deriveOutcome(body.results, body.evidence);
    if (!outcome.valid) return res.status(422).json({ error: "evidence_verification_failed", reason: outcome.reason });
    const current = await db.query("SELECT definition FROM test_jobs WHERE id = $1 AND gateway_id = $2 AND workspace_id = $3 AND status IN ('assigned', 'running')", [req.params.id, req.gateway.id, req.gateway.workspace_id]);
    if (!current.rowCount) return res.status(409).json({ error: "job_not_active" });
    if (!evidenceMatchesDefinition(current.rows[0].definition, body.evidence)) return res.status(422).json({ error: "evidence_job_mismatch", reason: "evidence fingerprints do not match the job definition" });
    const done = await db.transaction(async (client) => {
      const updated = await client.query(
        `UPDATE test_jobs SET status = $4, summary = $5, result = $6, engine_fingerprint = $7, lease_expires_at = NULL, finished_at = now(), version = version + 1
         WHERE id = $1 AND gateway_id = $2 AND workspace_id = $3 AND status IN ('assigned', 'running') RETURNING ${JOB_COLUMNS}`,
        [req.params.id, req.gateway.id, req.gateway.workspace_id, outcome.status, outcome.summary, body, body.evidence.fingerprints.engine]
      );
      if (!updated.rowCount) return null;
      await client.query("INSERT INTO test_reports (workspace_id, suite_id, summary, result, created_by) VALUES ($1, $2, $3, $4, $5)", [req.gateway.workspace_id, updated.rows[0].suite_id, outcome.summary, body, `gateway:${req.gateway.id}`]);
      await meter(client, req.gateway.workspace_id, "reports_created");
      await enqueueWebhooks(client, req.gateway.workspace_id, "job.finished", publicJob(updated.rows[0]));
      await withAudit(req, client, "test_job.completed", updated.rows[0].id, { status: updated.rows[0].status, ...outcome.summary });
      return updated.rows[0];
    });
    if (!done) return res.status(409).json({ error: "job_not_active" });
    metrics.jobEvents.inc({ event: done.status });
    return res.json(publicJob(done));
  }));
}

export function registerGatewayAdminRoutes(app, { db, auth, apiAudit }) {
  const online = (row) => Boolean(row.last_heartbeat_at) && Date.now() - new Date(row.last_heartbeat_at).getTime() < ONLINE_SECONDS * 1000;
  const view = (row) => ({ id: row.id, name: row.name, online: online(row), labels: row.labels, lastHeartbeatAt: row.last_heartbeat_at, agentVersion: row.agent_version, capabilities: row.capabilities, tokenExpiresAt: row.token_expires_at, tokenRotatedAt: row.token_rotated_at, revokedAt: row.revoked_at, createdAt: row.created_at });
  const COLUMNS = "id, name, labels, capabilities, agent_version, last_heartbeat_at, token_expires_at, token_rotated_at, revoked_at, created_at";
  const base = "/v1/workspaces/:workspaceId/gateways";

  app.get(base, auth.requireRole("viewer"), h(async (req, res) => {
    const result = await db.query(`SELECT ${COLUMNS} FROM gateways WHERE workspace_id = $1 ORDER BY revoked_at IS NOT NULL, name, created_at DESC LIMIT 500`, [req.workspaceId]);
    res.json(result.rows.map(view));
  }));

  app.post(base, auth.requireRole("maintainer"), h(async (req, res) => {
    const body = gatewaySchema.parse(req.body);
    const token = newGatewayToken();
    const created = await db.transaction(async (client) => {
      const plan = await lockWorkspace(client, req.workspaceId);
      enforce(plan, "gateways", plan.limits.gateways, (await usageOf(client, req.workspaceId)).gateways);
      const result = await client.query(
        `INSERT INTO gateways (workspace_id, name, token_hash, labels, token_expires_at, created_by) VALUES ($1, $2, $3, $4, CASE WHEN $5::int IS NULL THEN NULL ELSE now() + make_interval(days => $5::int) END, $6) RETURNING ${COLUMNS}`,
        [req.workspaceId, body.name, hashToken(token), body.labels ?? {}, body.expiresInDays ?? null, req.identity.subject]
      );
      await apiAudit(req, client, { action: "gateway.registered", resourceType: "gateway", resourceId: result.rows[0].id, details: { name: body.name, labels: body.labels ?? {}, expiresInDays: body.expiresInDays ?? null } });
      return result.rows[0];
    });
    res.status(201).json({ ...view(created), token });
  }));

  app.patch(`${base}/:id`, auth.requireRole("maintainer"), h(async (req, res) => {
    const body = gatewayPatchSchema.parse(req.body);
    const updated = await db.transaction(async (client) => {
      const result = await client.query(`UPDATE gateways SET labels = $3 WHERE id = $1 AND workspace_id = $2 AND revoked_at IS NULL RETURNING ${COLUMNS}`, [req.params.id, req.workspaceId, body.labels]);
      if (!result.rowCount) return null;
      await apiAudit(req, client, { action: "gateway.labels_updated", resourceType: "gateway", resourceId: req.params.id, details: { labels: body.labels } });
      return result.rows[0];
    });
    if (!updated) throw new HttpError(404, "not_found");
    res.json(view(updated));
  }));

  // Rotation invalidates the previous token immediately; the new one is shown once.
  app.post(`${base}/:id/rotate`, auth.requireRole("maintainer"), h(async (req, res) => {
    const token = newGatewayToken();
    const rotated = await db.transaction(async (client) => {
      const result = await client.query(`UPDATE gateways SET token_hash = $3, token_rotated_at = now() WHERE id = $1 AND workspace_id = $2 AND revoked_at IS NULL RETURNING ${COLUMNS}`, [req.params.id, req.workspaceId, hashToken(token)]);
      if (!result.rowCount) return null;
      await apiAudit(req, client, { action: "gateway.token_rotated", resourceType: "gateway", resourceId: req.params.id });
      return result.rows[0];
    });
    if (!rotated) throw new HttpError(404, "not_found");
    res.json({ ...view(rotated), token });
  }));

  app.delete(`${base}/:id`, auth.requireRole("maintainer"), h(async (req, res) => {
    const revoked = await db.transaction(async (client) => {
      const result = await client.query("UPDATE gateways SET revoked_at = now() WHERE id = $1 AND workspace_id = $2 AND revoked_at IS NULL RETURNING id", [req.params.id, req.workspaceId]);
      if (!result.rowCount) return false;
      await apiAudit(req, client, { action: "gateway.revoked", resourceType: "gateway", resourceId: req.params.id });
      return true;
    });
    if (!revoked) throw new HttpError(404, "not_found");
    res.status(204).end();
  }));
}
