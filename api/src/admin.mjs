import { z } from "zod";
import { CURSOR_AT, HttpError, decodeCursor, encodeCursor, h, parseLimit } from "./http.mjs";
import { newToken, requireHuman, sha256 } from "./auth.mjs";
import { verifyEvidence } from "./evidence.mjs";
import { toJunit } from "./junit.mjs";
import { limitsFor } from "./plans.mjs";
import { invitationMessage } from "./mail.mjs";
import { enqueueEmail } from "./outbox.mjs";
import { enforce, lockWorkspace, meter, usageOf } from "./quota.mjs";

const ROLES = ["viewer", "engineer", "maintainer", "administrator"];
const hash = /^[a-f0-9]{64}$/;
const name = z.string().trim().min(1).max(120);
const resourceSchema = z.object({ name, definition: z.record(z.string(), z.unknown()) }).strict();
const evidenceEventSchema = z.object({ sequence: z.number().int().nonnegative(), at: z.number().int().nonnegative(), type: z.enum(["run.started", "attempt.started", "command.transmitted", "response.window.opened", "assertion.completed", "attempt.timed_out", "run.finished", "run.stopped"]), payload: z.record(z.string(), z.unknown()), previousHash: z.string().regex(hash), hash: z.string().regex(hash) });
const evidenceSchema = z.object({ schema: z.literal("wirepulse.test-evidence.v1"), evidenceId: z.string().uuid(), createdAt: z.string().datetime(), fingerprints: z.object({ suite: z.string().regex(hash), profile: z.string().regex(hash), engine: z.string().regex(hash) }).strict(), rootHash: z.string().regex(hash), events: z.array(evidenceEventSchema).min(2).max(10000), finalHash: z.string().regex(hash) }).strict();
const reportSchema = z.object({
  suiteId: z.string().uuid().nullable().optional(),
  summary: z.object({ passed: z.number().int().nonnegative(), failed: z.number().int().nonnegative(), total: z.number().int().nonnegative(), evidenceSchema: z.literal("wirepulse.test-evidence.v1"), evidenceFinalHash: z.string().regex(hash) }).strict(),
  result: z.object({ results: z.array(z.object({ testId: z.string(), status: z.enum(["passed", "failed", "not-run"]), attempts: z.number().int().nonnegative() }).strict()).max(10000), evidence: evidenceSchema }).strict()
}).strict();
const memberRoleSchema = z.object({ role: z.enum(ROLES) }).strict();
const invitationSchema = z.object({ email: z.string().trim().toLowerCase().email().max(254), role: z.enum(ROLES) }).strict();

const publicItem = (row) => ({ id: row.id, name: row.name, definition: row.definition, createdAt: row.created_at, updatedAt: row.updated_at, version: row.version, updatedBy: row.updated_by });

export function registerAdminRoutes(app, { db, config, auth, apiAudit, log, metrics }) {
  const ws = "/v1/workspaces/:workspaceId";
  const viewer = auth.requireRole("viewer"); const engineer = auth.requireRole("engineer");
  const maintainer = auth.requireRole("maintainer"); const administrator = auth.requireRole("administrator");

  // ---- workspaces ----
  app.post("/v1/workspaces", requireHuman, h(async (req, res) => {
    const body = z.object({ name }).strict().parse(req.body);
    const workspace = await db.transaction(async (client) => {
      const cap = config.saas.maxWorkspacesPerUser;
      if (cap > 0) {
        // One user's creations are serialized so concurrent requests cannot count their way past the cap.
        await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 727276))", [`workspaces:${req.identity.subject}`]);
        const owned = (await client.query("SELECT count(*)::int AS n FROM workspaces WHERE created_by = $1 AND deleted_at IS NULL", [req.identity.subject])).rows[0].n;
        if (owned >= cap) throw new HttpError(403, "workspace_limit_reached", { limit: cap });
      }
      const created = (await client.query("INSERT INTO workspaces (name, created_by, plan) VALUES ($1, $2, $3) RETURNING id, name, plan, created_at", [body.name, req.identity.subject, config.saas.defaultPlan])).rows[0];
      await client.query("INSERT INTO workspace_members (workspace_id, subject, email, role) VALUES ($1, $2, $3, 'administrator')", [created.id, req.identity.subject, req.identity.email]);
      await apiAudit(req, client, { workspaceId: created.id, action: "workspace.created", resourceType: "workspace", resourceId: created.id, details: { name: body.name, plan: created.plan } });
      return created;
    });
    res.status(201).json({ id: workspace.id, name: workspace.name, plan: workspace.plan, createdAt: workspace.created_at, role: "administrator" });
  }));

  app.get("/v1/workspaces", h(async (req, res) => {
    const rows = req.identity.apiKey
      ? (await db.query("SELECT id, name, plan, $2::text AS role, created_at FROM workspaces WHERE id = $1 AND deleted_at IS NULL", [req.identity.apiKey.workspaceId, req.identity.apiKey.role])).rows
      : (await db.query("SELECT w.id, w.name, w.plan, m.role, w.created_at FROM workspaces w JOIN workspace_members m ON m.workspace_id = w.id WHERE m.subject = $1 AND w.deleted_at IS NULL ORDER BY w.name LIMIT 500", [req.identity.subject])).rows;
    res.json(rows.map((row) => ({ id: row.id, name: row.name, plan: row.plan, role: row.role, createdAt: row.created_at })));
  }));

  // Plan, its limits, and current consumption: what an operator or customer needs to see before hitting a limit.
  app.get(`${ws}/usage`, viewer, h(async (req, res) => {
    res.json({ plan: req.workspacePlan, limits: limitsFor(req.workspacePlan), usage: await usageOf(db, req.workspaceId) });
  }));

  // Offboarding. The workspace is unusable at once (every route hides a deleted workspace); its content is purged by the purge worker
  // after the grace period, and an operator can restore it until then (admin-cli). The name must be typed back, so a stray DELETE
  // cannot end a customer's workspace. Everything that could still act for the workspace is stopped in the same transaction.
  app.delete(ws, administrator, requireHuman, h(async (req, res) => {
    const { confirm } = z.object({ confirm: z.string().min(1).max(200) }).strict().parse(req.query);
    const deleted = await db.transaction(async (client) => {
      const found = await client.query("SELECT name FROM workspaces WHERE id = $1 AND deleted_at IS NULL FOR NO KEY UPDATE", [req.workspaceId]);
      if (!found.rowCount) throw new HttpError(404, "workspace_not_found");
      if (found.rows[0].name !== confirm) throw new HttpError(400, "confirmation_mismatch");
      await client.query("UPDATE test_jobs SET status = 'cancelled', lease_expires_at = NULL, finished_at = now(), version = version + 1 WHERE workspace_id = $1 AND status IN ('queued', 'assigned', 'running')", [req.workspaceId]);
      await client.query("UPDATE gateways SET revoked_at = now() WHERE workspace_id = $1 AND revoked_at IS NULL", [req.workspaceId]);
      await client.query("UPDATE api_keys SET revoked_at = now() WHERE workspace_id = $1 AND revoked_at IS NULL", [req.workspaceId]);
      await client.query("UPDATE workspace_invitations SET revoked_at = now() WHERE workspace_id = $1 AND accepted_at IS NULL AND revoked_at IS NULL", [req.workspaceId]);
      await client.query("UPDATE webhooks SET enabled = false, updated_at = now() WHERE workspace_id = $1 AND enabled", [req.workspaceId]);
      await client.query("UPDATE outbox SET status = 'failed', last_error = 'workspace_deleted', lease_expires_at = NULL, finished_at = now(), payload = CASE WHEN kind = 'email' THEN '{\"redacted\":true}'::jsonb ELSE payload END WHERE workspace_id = $1 AND status = 'pending'", [req.workspaceId]);
      const row = (await client.query("UPDATE workspaces SET deleted_at = now(), deleted_by = $2, purge_after = now() + make_interval(days => $3) WHERE id = $1 RETURNING deleted_at, purge_after", [req.workspaceId, req.identity.subject, config.saas.purgeGraceDays])).rows[0];
      await apiAudit(req, client, { workspaceId: req.workspaceId, action: "workspace.deleted", resourceType: "workspace", resourceId: req.workspaceId, details: { purgeAfter: row.purge_after } });
      return row;
    });
    res.json({ id: req.workspaceId, deletedAt: deleted.deleted_at, purgeAfter: deleted.purge_after });
  }));

  // ---- shared profiles and test suites, with immutable version history ----
  for (const resource of [{ path: "profiles", table: "shared_profiles", type: "profile" }, { path: "test-suites", table: "test_suites", type: "test_suite" }]) {
    const base = `${ws}/${resource.path}`;
    const columns = "id, name, definition, created_at, updated_at, version, updated_by";
    app.get(base, viewer, h(async (req, res) => {
      // No definitions in the list: each may be up to MAX_JSON_BYTES, so a thousand of them is one very large response. GET one item for its definition.
      const result = await db.query(`SELECT id, name, created_at, updated_at, version, updated_by FROM ${resource.table} WHERE workspace_id = $1 ORDER BY name LIMIT 1000`, [req.workspaceId]);
      res.json(result.rows.map(publicItem));
    }));
    app.get(`${base}/:id`, viewer, h(async (req, res) => {
      const result = await db.query(`SELECT ${columns} FROM ${resource.table} WHERE id = $1 AND workspace_id = $2`, [req.params.id, req.workspaceId]);
      if (!result.rowCount) throw new HttpError(404, "not_found");
      res.json(publicItem(result.rows[0]));
    }));
    app.post(base, engineer, h(async (req, res) => {
      const body = resourceSchema.parse(req.body);
      const created = await db.transaction(async (client) => {
        const result = await client.query(`INSERT INTO ${resource.table} (workspace_id, name, definition, created_by, updated_by) VALUES ($1, $2, $3, $4, $4) RETURNING ${columns}`, [req.workspaceId, body.name, body.definition, req.identity.subject]);
        await apiAudit(req, client, { action: `${resource.type}.created`, resourceType: resource.type, resourceId: result.rows[0].id, details: { name: body.name } });
        return result.rows[0];
      });
      res.status(201).json(publicItem(created));
    }));
    app.put(`${base}/:id`, engineer, h(async (req, res) => {
      const body = resourceSchema.parse(req.body);
      const expectedVersion = Number(req.get("if-match-version"));
      if (!Number.isInteger(expectedVersion)) throw new HttpError(428, "if_match_version_required");
      const updated = await db.transaction(async (client) => {
        const result = await client.query(`UPDATE ${resource.table} SET name = $1, definition = $2, updated_by = $3, updated_at = now(), version = version + 1 WHERE id = $4 AND workspace_id = $5 AND version = $6 RETURNING ${columns}`, [body.name, body.definition, req.identity.subject, req.params.id, req.workspaceId, expectedVersion]);
        if (!result.rowCount) return null;
        await apiAudit(req, client, { action: `${resource.type}.updated`, resourceType: resource.type, resourceId: req.params.id, details: { version: result.rows[0].version } });
        return result.rows[0];
      });
      if (!updated) throw new HttpError(409, "version_conflict_or_not_found");
      res.json(publicItem(updated));
    }));
    app.delete(`${base}/:id`, maintainer, h(async (req, res) => {
      const deleted = await db.transaction(async (client) => {
        const result = await client.query(`DELETE FROM ${resource.table} WHERE id = $1 AND workspace_id = $2 RETURNING id`, [req.params.id, req.workspaceId]);
        if (!result.rowCount) return false;
        await apiAudit(req, client, { action: `${resource.type}.deleted`, resourceType: resource.type, resourceId: req.params.id });
        return true;
      });
      if (!deleted) throw new HttpError(404, "not_found");
      res.status(204).end();
    }));
    // Version history survives deletion of the resource; every version a job ran against can be recovered.
    app.get(`${base}/:id/versions`, viewer, h(async (req, res) => {
      const result = await db.query("SELECT version, name, created_by, created_at FROM resource_versions WHERE resource_type = $1 AND resource_id = $2 AND workspace_id = $3 ORDER BY version DESC LIMIT 500", [resource.type, req.params.id, req.workspaceId]);
      res.json(result.rows.map((row) => ({ version: row.version, name: row.name, createdBy: row.created_by, createdAt: row.created_at })));
    }));
    app.get(`${base}/:id/versions/:version(\\d+)`, viewer, h(async (req, res) => {
      const result = await db.query("SELECT version, name, definition, created_by, created_at FROM resource_versions WHERE resource_type = $1 AND resource_id = $2 AND workspace_id = $3 AND version = $4", [resource.type, req.params.id, req.workspaceId, Number(req.params.version)]);
      if (!result.rowCount) throw new HttpError(404, "not_found");
      const row = result.rows[0];
      res.json({ version: row.version, name: row.name, definition: row.definition, createdBy: row.created_by, createdAt: row.created_at });
    }));
  }

  // ---- members ----
  app.get(`${ws}/members`, maintainer, h(async (req, res) => {
    const result = await db.query("SELECT subject, email, role, created_at FROM workspace_members WHERE workspace_id = $1 ORDER BY created_at LIMIT 1000", [req.workspaceId]);
    res.json(result.rows.map((row) => ({ subject: row.subject, email: row.email, role: row.role, createdAt: row.created_at })));
  }));

  // Locks the administrators so two concurrent demotions cannot leave a workspace without one.
  async function guardLastAdministrator(client, workspaceId, subject) {
    const admins = (await client.query("SELECT subject FROM workspace_members WHERE workspace_id = $1 AND role = 'administrator' FOR UPDATE", [workspaceId])).rows;
    if (admins.length === 1 && admins[0].subject === subject) throw new HttpError(409, "last_administrator");
  }
  app.put(`${ws}/members/:subject`, administrator, h(async (req, res) => {
    const body = memberRoleSchema.parse(req.body);
    const member = await db.transaction(async (client) => {
      if (body.role !== "administrator") await guardLastAdministrator(client, req.workspaceId, req.params.subject);
      const result = await client.query("UPDATE workspace_members SET role = $3 WHERE workspace_id = $1 AND subject = $2 RETURNING subject, email, role, created_at", [req.workspaceId, req.params.subject, body.role]);
      if (!result.rowCount) return null;
      await apiAudit(req, client, { action: "member.role_changed", resourceType: "member", details: { subject: req.params.subject, role: body.role } });
      return result.rows[0];
    });
    if (!member) throw new HttpError(404, "not_found");
    res.json({ subject: member.subject, email: member.email, role: member.role, createdAt: member.created_at });
  }));
  app.delete(`${ws}/members/:subject`, administrator, h(async (req, res) => {
    const removed = await db.transaction(async (client) => {
      await guardLastAdministrator(client, req.workspaceId, req.params.subject);
      const result = await client.query("DELETE FROM workspace_members WHERE workspace_id = $1 AND subject = $2 RETURNING subject", [req.workspaceId, req.params.subject]);
      if (!result.rowCount) return false;
      await apiAudit(req, client, { action: "member.removed", resourceType: "member", details: { subject: req.params.subject } });
      return true;
    });
    if (!removed) throw new HttpError(404, "not_found");
    res.status(204).end();
  }));

  // ---- invitations: matched to a verified OIDC email on acceptance; when SMTP is configured the invitee is also emailed (via the outbox) ----
  const invitationView = (row) => ({ id: row.id, email: row.email, role: row.role, invitedBy: row.invited_by, createdAt: row.created_at, expiresAt: row.expires_at, acceptedBy: row.accepted_by, acceptedAt: row.accepted_at, revokedAt: row.revoked_at });
  app.get(`${ws}/invitations`, administrator, h(async (req, res) => {
    const result = await db.query("SELECT * FROM workspace_invitations WHERE workspace_id = $1 ORDER BY created_at DESC LIMIT 200", [req.workspaceId]);
    res.json(result.rows.map(invitationView));
  }));
  app.post(`${ws}/invitations`, administrator, requireHuman, h(async (req, res) => {
    const body = invitationSchema.parse(req.body);
    const invitation = await db.transaction(async (client) => {
      const plan = await lockWorkspace(client, req.workspaceId);
      const existing = await client.query("SELECT 1 FROM workspace_members WHERE workspace_id = $1 AND lower(email) = $2", [req.workspaceId, body.email]);
      if (existing.rowCount) throw new HttpError(409, "already_member");
      const usage = await usageOf(client, req.workspaceId);
      enforce(plan, "members", plan.limits.members, usage.members + usage.pendingInvitations);
      const result = await client.query("INSERT INTO workspace_invitations (workspace_id, email, role, invited_by, expires_at) VALUES ($1, $2, $3, $4, now() + make_interval(days => $5)) RETURNING *", [req.workspaceId, body.email, body.role, req.identity.subject, config.invitationTtlDays]);
      // Queued with the invitation, so email goes out exactly when the invitation exists; a failing mail server never fails the invitation.
      if (config.smtp) {
        const workspaceName = (await client.query("SELECT name FROM workspaces WHERE id = $1", [req.workspaceId])).rows[0].name;
        await enqueueEmail(client, req.workspaceId, invitationMessage({ to: body.email, workspaceName, role: body.role, expiresAt: result.rows[0].expires_at, baseUrl: config.smtp.inviteBaseUrl }));
      }
      await apiAudit(req, client, { action: "invitation.created", resourceType: "invitation", resourceId: result.rows[0].id, details: { email: body.email, role: body.role } });
      return result.rows[0];
    });
    res.status(201).json(invitationView(invitation));
  }));
  app.delete(`${ws}/invitations/:id`, administrator, h(async (req, res) => {
    const revoked = await db.transaction(async (client) => {
      const result = await client.query("UPDATE workspace_invitations SET revoked_at = now() WHERE id = $1 AND workspace_id = $2 AND accepted_at IS NULL AND revoked_at IS NULL RETURNING id", [req.params.id, req.workspaceId]);
      if (!result.rowCount) return false;
      await apiAudit(req, client, { action: "invitation.revoked", resourceType: "invitation", resourceId: req.params.id });
      return true;
    });
    if (!revoked) throw new HttpError(404, "not_found");
    res.status(204).end();
  }));
  const needEmail = (req) => { if (!req.identity.email) throw new HttpError(403, "verified_email_required"); };
  app.get("/v1/invitations", requireHuman, h(async (req, res) => {
    needEmail(req);
    const result = await db.query("SELECT i.id, i.email, i.role, i.expires_at, w.id AS workspace_id, w.name AS workspace_name FROM workspace_invitations i JOIN workspaces w ON w.id = i.workspace_id WHERE i.email = $1 AND i.accepted_at IS NULL AND i.revoked_at IS NULL AND i.expires_at > now() AND w.deleted_at IS NULL ORDER BY i.created_at DESC LIMIT 50", [req.identity.email]);
    res.json(result.rows.map((row) => ({ id: row.id, role: row.role, expiresAt: row.expires_at, workspaceId: row.workspace_id, workspaceName: row.workspace_name })));
  }));
  app.post("/v1/invitations/:id/accept", requireHuman, h(async (req, res) => {
    needEmail(req);
    const accepted = await db.transaction(async (client) => {
      // Lock order is always workspace, then its children, so acceptance cannot deadlock with offboarding.
      const candidate = await client.query("SELECT workspace_id FROM workspace_invitations WHERE id = $1 AND email = $2", [req.params.id, req.identity.email]);
      if (!candidate.rowCount) throw new HttpError(404, "not_found");
      const plan = await lockWorkspace(client, candidate.rows[0].workspace_id).catch((error) => { throw error.status === 404 ? new HttpError(404, "not_found") : error; });
      const found = await client.query("SELECT id, workspace_id, role FROM workspace_invitations WHERE id = $1 AND email = $2 AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > now() FOR UPDATE", [req.params.id, req.identity.email]);
      if (!found.rowCount) throw new HttpError(404, "not_found");
      enforce(plan, "members", plan.limits.members, (await usageOf(client, found.rows[0].workspace_id)).members);
      const invitation = found.rows[0];
      const member = await client.query("INSERT INTO workspace_members (workspace_id, subject, email, role) VALUES ($1, $2, $3, $4) ON CONFLICT (workspace_id, subject) DO NOTHING RETURNING subject", [invitation.workspace_id, req.identity.subject, req.identity.email, invitation.role]);
      if (!member.rowCount) throw new HttpError(409, "already_member");
      await client.query("UPDATE workspace_invitations SET accepted_by = $2, accepted_at = now() WHERE id = $1", [invitation.id, req.identity.subject]);
      await apiAudit(req, client, { workspaceId: invitation.workspace_id, action: "invitation.accepted", resourceType: "invitation", resourceId: invitation.id, details: { role: invitation.role } });
      return invitation;
    });
    res.json({ workspaceId: accepted.workspace_id, role: accepted.role });
  }));

  // ---- API keys for CI: workspace-scoped, role-limited (never administrator), always expiring ----
  const keyView = (row) => ({ id: row.id, name: row.name, role: row.role, prefix: row.token_prefix, createdBy: row.created_by, createdAt: row.created_at, expiresAt: row.expires_at, lastUsedAt: row.last_used_at, revokedAt: row.revoked_at });
  const keySchema = z.object({ name, role: z.enum(["viewer", "engineer", "maintainer"]), expiresInDays: z.number().int().min(1).max(config.apiKeyMaxDays).optional() }).strict();
  app.get(`${ws}/api-keys`, administrator, h(async (req, res) => {
    const result = await db.query("SELECT id, name, role, token_prefix, created_by, created_at, expires_at, last_used_at, revoked_at FROM api_keys WHERE workspace_id = $1 ORDER BY created_at DESC LIMIT 500", [req.workspaceId]);
    res.json(result.rows.map(keyView));
  }));
  app.post(`${ws}/api-keys`, administrator, requireHuman, h(async (req, res) => {
    const body = keySchema.parse(req.body);
    const token = newToken("wpk");
    const days = body.expiresInDays ?? Math.min(90, config.apiKeyMaxDays);
    const key = await db.transaction(async (client) => {
      const plan = await lockWorkspace(client, req.workspaceId);
      enforce(plan, "api_keys", plan.limits.apiKeys, (await usageOf(client, req.workspaceId)).apiKeys);
      const result = await client.query("INSERT INTO api_keys (workspace_id, name, role, token_hash, token_prefix, created_by, expires_at) VALUES ($1, $2, $3, $4, $5, $6, now() + make_interval(days => $7)) RETURNING id, name, role, token_prefix, created_by, created_at, expires_at, last_used_at, revoked_at", [req.workspaceId, body.name, body.role, sha256(token), token.slice(0, 12), req.identity.subject, days]);
      await apiAudit(req, client, { action: "api_key.created", resourceType: "api_key", resourceId: result.rows[0].id, details: { name: body.name, role: body.role, expiresInDays: days } });
      return result.rows[0];
    });
    res.status(201).json({ ...keyView(key), token });
  }));
  app.delete(`${ws}/api-keys/:id`, administrator, h(async (req, res) => {
    const revoked = await db.transaction(async (client) => {
      const result = await client.query("UPDATE api_keys SET revoked_at = now() WHERE id = $1 AND workspace_id = $2 AND revoked_at IS NULL RETURNING id", [req.params.id, req.workspaceId]);
      if (!result.rowCount) return false;
      await apiAudit(req, client, { action: "api_key.revoked", resourceType: "api_key", resourceId: req.params.id });
      return true;
    });
    if (!revoked) throw new HttpError(404, "not_found");
    res.status(204).end();
  }));

  // ---- test reports ----
  app.get(`${ws}/test-reports`, viewer, h(async (req, res) => {
    const limit = parseLimit(req.query.limit, { fallback: 50, max: 100 });
    const cursor = decodeCursor(req.query.cursor);
    const rows = (await db.query(
      `SELECT id, suite_id, summary, created_by, created_at, ${CURSOR_AT} FROM test_reports WHERE workspace_id = $1 AND ($2::timestamptz IS NULL OR (created_at, id) < ($2::timestamptz, $3::uuid))
       ORDER BY created_at DESC, id DESC LIMIT $4`, [req.workspaceId, cursor?.at ?? null, cursor?.id ?? null, limit + 1]
    )).rows;
    if (rows.length > limit) { rows.length = limit; res.set("x-next-cursor", encodeCursor(rows.at(-1).cursor_at, rows.at(-1).id)); }
    res.json(rows.map((row) => ({ id: row.id, suiteId: row.suite_id, summary: row.summary, createdBy: row.created_by, createdAt: row.created_at })));
  }));
  app.get(`${ws}/test-reports/:id`, viewer, h(async (req, res) => {
    const result = await db.query("SELECT id, suite_id, summary, result, created_by, created_at FROM test_reports WHERE id = $1 AND workspace_id = $2", [req.params.id, req.workspaceId]);
    if (!result.rowCount) throw new HttpError(404, "not_found");
    const row = result.rows[0];
    res.json({ id: row.id, suiteId: row.suite_id, summary: row.summary, result: row.result, createdBy: row.created_by, createdAt: row.created_at });
  }));
  app.get(`${ws}/test-reports/:id/junit.xml`, viewer, h(async (req, res) => {
    const result = await db.query("SELECT id, summary, result, created_at FROM test_reports WHERE id = $1 AND workspace_id = $2", [req.params.id, req.workspaceId]);
    if (!result.rowCount) throw new HttpError(404, "not_found");
    const row = result.rows[0];
    res.type("application/xml").send(toJunit({ name: `wirepulse-report-${row.id}`, results: row.result.results, timestamp: row.created_at, evidenceFinalHash: row.summary?.evidenceFinalHash }));
  }));
  app.post(`${ws}/test-reports`, engineer, h(async (req, res) => {
    const body = reportSchema.parse(req.body);
    const verification = verifyEvidence(body.result.evidence, body.result.results);
    if (!verification.valid) return res.status(422).json({ error: "evidence_verification_failed", reason: verification.reason });
    const created = await db.transaction(async (client) => {
      const plan = await lockWorkspace(client, req.workspaceId);
      enforce(plan, "reports_per_month", plan.limits.reportsPerMonth, (await usageOf(client, req.workspaceId)).reportsThisMonth);
      // Same rule as jobs: a suite of another workspace answers like an unknown one (it would otherwise reveal that the id exists).
      if (body.suiteId && !(await client.query("SELECT 1 FROM test_suites WHERE id = $1 AND workspace_id = $2", [body.suiteId, req.workspaceId])).rowCount) throw new HttpError(404, "suite_not_found");
      const result = await client.query("INSERT INTO test_reports (workspace_id, suite_id, summary, result, created_by) VALUES ($1, $2, $3, $4, $5) RETURNING id, created_at", [req.workspaceId, body.suiteId ?? null, body.summary, body.result, req.identity.subject]);
      await meter(client, req.workspaceId, "reports_created");
      await apiAudit(req, client, { action: "test_report.created", resourceType: "test_report", resourceId: result.rows[0].id, details: { ...body.summary, evidenceVerification: "verified", evidenceFinalHash: verification.finalHash, evidenceEventCount: verification.eventCount } });
      return result.rows[0];
    });
    return res.status(201).json({ id: created.id, createdAt: created.created_at, evidenceVerification: "verified" });
  }));

  // ---- audit trail ----
  const AUDIT_COLUMNS = "id, chain_seq, actor_subject, action, resource_type, resource_id, request_id, ip_address, details, created_at, prev_hash, row_hash";
  app.get(`${ws}/audit-events`, administrator, h(async (req, res) => {
    const limit = parseLimit(req.query.limit, { fallback: 100, max: 200 });
    const cursor = decodeCursor(req.query.cursor);
    const from = req.query.from === undefined ? null : z.string().datetime().parse(req.query.from);
    const to = req.query.to === undefined ? null : z.string().datetime().parse(req.query.to);
    const action = req.query.action === undefined ? null : z.string().max(80).parse(req.query.action);
    const rows = (await db.query(
      `SELECT ${AUDIT_COLUMNS} FROM audit_events WHERE workspace_id = $1 AND ($2::bigint IS NULL OR id < $2) AND ($3::timestamptz IS NULL OR created_at >= $3) AND ($4::timestamptz IS NULL OR created_at < $4) AND ($5::text IS NULL OR action = $5)
       ORDER BY id DESC LIMIT $6`, [req.workspaceId, cursor?.id ?? null, from, to, action, limit + 1]
    )).rows;
    if (rows.length > limit) { rows.length = limit; res.set("x-next-cursor", encodeCursor(rows.at(-1).created_at, rows.at(-1).id)); }
    res.json(rows);
  }));

  // NDJSON export for SIEM/archival. Each line carries its chain fields, so an offline copy can be verified independently.
  app.get(`${ws}/audit-events/export.ndjson`, administrator, h(async (req, res) => {
    let afterSeq = z.coerce.number().int().min(0).default(0).parse(req.query.afterSeq);
    const max = parseLimit(req.query.limit, { fallback: 100_000, max: 1_000_000 });
    res.set({ "Content-Type": "application/x-ndjson; charset=utf-8", "Content-Disposition": `attachment; filename="wirepulse-audit-${req.workspaceId}.ndjson"`, "Cache-Control": "no-store" });
    let written = 0;
    while (written < max && !res.destroyed) {
      const rows = (await db.query(`SELECT ${AUDIT_COLUMNS} FROM audit_events WHERE workspace_id = $1 AND chain_seq > $2 ORDER BY chain_seq LIMIT $3`, [req.workspaceId, afterSeq, Math.min(1000, max - written)])).rows;
      if (!rows.length) break;
      for (const row of rows) { if (!res.write(`${JSON.stringify(row)}\n`)) await new Promise((resolve) => { res.once("drain", resolve); res.once("close", resolve); }); }
      written += rows.length; afterSeq = rows.at(-1).chain_seq;
    }
    res.end();
  }));

  // Recomputes the hash chain in the database. head_hash can be anchored externally (e.g. in a SIEM) to detect a full rewrite.
  app.get(`${ws}/audit/verify`, administrator, h(async (req, res) => {
    let from = z.coerce.number().int().min(0).default(0).parse(req.query.fromSeq);
    let checked = 0; let firstBad = null; let last = null; let head = null; let complete = false;
    for (let chunk = 0; chunk < 25; chunk += 1) {
      const r = (await db.query("SELECT checked, first_bad_seq, last_seq, head_hash FROM wirepulse_audit_verify($1, $2, 20000)", [req.workspaceId, from])).rows[0];
      checked += Number(r.checked);
      if (r.first_bad_seq !== null && firstBad === null) firstBad = Number(r.first_bad_seq);
      if (r.last_seq !== null) { last = Number(r.last_seq); head = r.head_hash; from = last + 1; }
      if (Number(r.checked) < 20000 || firstBad !== null) { complete = Number(r.checked) < 20000; break; }
    }
    const valid = firstBad === null;
    if (!valid) { metrics.auditFailures.inc(); (req.log ?? log).error({ security: true, event: "audit.chain_broken", workspaceId: req.workspaceId, firstBadSeq: firstBad }, "audit hash chain verification failed"); }
    res.json({ valid, checked, firstBadSeq: firstBad, lastSeq: last, headHash: head, complete, nextFromSeq: complete ? null : from });
  }));
}
