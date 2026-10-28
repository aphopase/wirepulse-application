import net from "node:net";
import { z } from "zod";
import { CURSOR_AT, HttpError, decodeCursor, encodeCursor, h, parseLimit } from "./http.mjs";
import { enforce, lockWorkspace } from "./quota.mjs";
import { WEBHOOK_EVENTS } from "./outbox.mjs";
import { secretFor } from "./webhook-send.mjs";

const name = z.string().trim().min(1).max(120);
const events = z.array(z.enum(WEBHOOK_EVENTS)).min(1).max(16).transform((list) => [...new Set(list)]);
const createSchema = z.object({ name, url: z.string().trim().min(1).max(2048), events: events.optional() }).strict();
const patchSchema = z.object({ name: name.optional(), url: z.string().trim().min(1).max(2048).optional(), events: events.optional(), enabled: z.boolean().optional() }).strict()
  .refine((value) => Object.keys(value).length > 0, "nothing to change");
const DELIVERY_STATUSES = ["pending", "delivered", "failed"];

// Fast feedback at configuration time. The delivery path re-checks the address it actually connects to, which is what counts:
// a host name cannot be vetted here (it may resolve differently later), and resolving it in the request path would make this API
// a DNS probe for tenants.
export function checkWebhookUrl(raw, guard) {
  let url;
  try { url = new URL(raw); } catch { throw new HttpError(400, "invalid_webhook_url", { reason: "not a valid URL" }); }
  if (!["https:", "http:"].includes(url.protocol)) throw new HttpError(400, "invalid_webhook_url", { reason: "only http and https URLs are supported" });
  if (url.username || url.password) throw new HttpError(400, "invalid_webhook_url", { reason: "credentials in the URL are not supported" });
  if (!url.hostname) throw new HttpError(400, "invalid_webhook_url", { reason: "the URL has no host" });
  const host = url.hostname.startsWith("[") ? url.hostname.slice(1, -1) : url.hostname;
  if (net.isIP(host)) {
    if (guard.verdict(host) !== "ok") throw new HttpError(400, "webhook_destination_not_allowed", { reason: "the address is not a permitted destination" });
    if (url.protocol === "http:" && !guard.isAllowListed(host)) throw new HttpError(400, "invalid_webhook_url", { reason: "plain http is only allowed for allow-listed networks; use https" });
  }
  return url;
}

export function registerWebhookRoutes(app, { db, config, auth, apiAudit, guard }) {
  const base = "/v1/workspaces/:workspaceId/webhooks";
  const administrator = auth.requireRole("administrator");
  // After authorization, so callers who may not use the feature learn nothing about how the deployment is configured.
  const available = (_req, _res, next) => (config.webhooks ? next() : next(new HttpError(501, "webhooks_not_configured")));
  const view = (row) => ({ id: row.id, name: row.name, url: row.url, events: row.events, enabled: row.enabled, secretVersion: row.secret_version, createdBy: row.created_by, createdAt: row.created_at, updatedAt: row.updated_at });
  const secretOf = (row) => secretFor(config.webhooks.signingKey, row.id, row.secret_version);
  // The URL itself may carry a token, so the audit trail records only the host.
  const hostOf = (url) => new URL(url).host;
  const delivery = (row) => ({ id: row.id, eventType: row.event_type, status: row.status, attempts: row.attempts, lastStatus: row.last_status, lastError: row.last_error, createdAt: row.created_at, nextAttemptAt: row.status === "pending" ? row.next_attempt_at : null, finishedAt: row.finished_at });

  app.get(base, administrator, available, h(async (req, res) => {
    const result = await db.query("SELECT * FROM webhooks WHERE workspace_id = $1 ORDER BY lower(name)", [req.workspaceId]);
    res.json(result.rows.map(view));
  }));

  app.post(base, administrator, available, h(async (req, res) => {
    const body = createSchema.parse(req.body);
    const url = checkWebhookUrl(body.url, guard);
    const created = await db.transaction(async (client) => {
      const plan = await lockWorkspace(client, req.workspaceId);
      const count = (await client.query("SELECT count(*)::int AS n FROM webhooks WHERE workspace_id = $1", [req.workspaceId])).rows[0].n;
      enforce(plan, "webhooks", plan.limits.webhooks, count);
      const result = await client.query("INSERT INTO webhooks (workspace_id, name, url, events, created_by) VALUES ($1, $2, $3, $4, $5) RETURNING *", [req.workspaceId, body.name, url.href, body.events ?? ["job.finished"], req.identity.subject]);
      await apiAudit(req, client, { action: "webhook.created", resourceType: "webhook", resourceId: result.rows[0].id, details: { name: body.name, host: url.host, events: result.rows[0].events } });
      return result.rows[0];
    });
    // The secret is shown once, here (and again only by rotating it).
    res.status(201).json({ ...view(created), secret: secretOf(created) });
  }));

  app.get(`${base}/:id`, administrator, available, h(async (req, res) => {
    const result = await db.query("SELECT * FROM webhooks WHERE id = $1 AND workspace_id = $2", [req.params.id, req.workspaceId]);
    if (!result.rowCount) throw new HttpError(404, "webhook_not_found");
    res.json(view(result.rows[0]));
  }));

  app.patch(`${base}/:id`, administrator, available, h(async (req, res) => {
    const body = patchSchema.parse(req.body);
    const url = body.url === undefined ? null : checkWebhookUrl(body.url, guard);
    const updated = await db.transaction(async (client) => {
      const result = await client.query(
        `UPDATE webhooks SET name = COALESCE($3, name), url = COALESCE($4, url), events = COALESCE($5, events), enabled = COALESCE($6, enabled), updated_at = now()
         WHERE id = $1 AND workspace_id = $2 RETURNING *`,
        [req.params.id, req.workspaceId, body.name ?? null, url?.href ?? null, body.events ?? null, body.enabled ?? null]
      );
      if (!result.rowCount) return null;
      await apiAudit(req, client, { action: "webhook.updated", resourceType: "webhook", resourceId: req.params.id, details: { changed: Object.keys(body), ...(url ? { host: url.host } : {}), enabled: result.rows[0].enabled } });
      return result.rows[0];
    });
    if (!updated) throw new HttpError(404, "webhook_not_found");
    res.json(view(updated));
  }));

  app.delete(`${base}/:id`, administrator, available, h(async (req, res) => {
    const removed = await db.transaction(async (client) => {
      const result = await client.query("DELETE FROM webhooks WHERE id = $1 AND workspace_id = $2 RETURNING name, url", [req.params.id, req.workspaceId]);
      if (!result.rowCount) return false;
      await apiAudit(req, client, { action: "webhook.deleted", resourceType: "webhook", resourceId: req.params.id, details: { name: result.rows[0].name, host: hostOf(result.rows[0].url) } });
      return true;
    });
    if (!removed) throw new HttpError(404, "webhook_not_found");
    res.status(204).end();
  }));

  // The old secret stops working immediately: receivers should accept the new one before it is rotated in their configuration, or
  // briefly accept both.
  app.post(`${base}/:id/rotate-secret`, administrator, available, h(async (req, res) => {
    const rotated = await db.transaction(async (client) => {
      const result = await client.query("UPDATE webhooks SET secret_version = secret_version + 1, updated_at = now() WHERE id = $1 AND workspace_id = $2 RETURNING *", [req.params.id, req.workspaceId]);
      if (!result.rowCount) return null;
      await apiAudit(req, client, { action: "webhook.secret_rotated", resourceType: "webhook", resourceId: req.params.id, details: { secretVersion: result.rows[0].secret_version } });
      return result.rows[0];
    });
    if (!rotated) throw new HttpError(404, "webhook_not_found");
    res.json({ secret: secretOf(rotated), secretVersion: rotated.secret_version });
  }));

  // Queues a `webhook.ping` delivery through the same path as real events (so it tests signing, SSRF policy and retries too).
  app.post(`${base}/:id/ping`, administrator, available, h(async (req, res) => {
    const id = await db.transaction(async (client) => {
      const hook = await client.query("SELECT id FROM webhooks WHERE id = $1 AND workspace_id = $2", [req.params.id, req.workspaceId]);
      if (!hook.rowCount) return null;
      const queued = await client.query("INSERT INTO outbox (workspace_id, kind, webhook_id, event_type, payload) VALUES ($1, 'webhook', $2, 'webhook.ping', $3::jsonb) RETURNING id", [req.workspaceId, req.params.id, JSON.stringify({ message: "ping" })]);
      await apiAudit(req, client, { action: "webhook.ping", resourceType: "webhook", resourceId: req.params.id, details: { deliveryId: queued.rows[0].id } });
      return queued.rows[0].id;
    });
    if (!id) throw new HttpError(404, "webhook_not_found");
    res.status(202).json({ deliveryId: id });
  }));

  app.get(`${base}/:id/deliveries`, administrator, available, h(async (req, res) => {
    const limit = parseLimit(req.query.limit, { fallback: 50, max: 100 });
    const cursor = decodeCursor(req.query.cursor);
    const status = req.query.status === undefined ? null : z.enum(DELIVERY_STATUSES).parse(req.query.status);
    if (!(await db.query("SELECT 1 FROM webhooks WHERE id = $1 AND workspace_id = $2", [req.params.id, req.workspaceId])).rowCount) throw new HttpError(404, "webhook_not_found");
    const rows = (await db.query(
      `SELECT id, event_type, status, attempts, last_status, last_error, created_at, next_attempt_at, finished_at, ${CURSOR_AT} FROM outbox
       WHERE webhook_id = $1 AND workspace_id = $2 AND ($3::text IS NULL OR status = $3) AND ($4::timestamptz IS NULL OR (created_at, id) < ($4::timestamptz, $5::uuid))
       ORDER BY created_at DESC, id DESC LIMIT $6`,
      [req.params.id, req.workspaceId, status, cursor?.at ?? null, cursor?.id ?? null, limit + 1]
    )).rows;
    if (rows.length > limit) { rows.length = limit; res.set("x-next-cursor", encodeCursor(rows.at(-1).cursor_at, rows.at(-1).id)); }
    res.json(rows.map(delivery));
  }));

  // Puts a failed delivery back in the queue with a fresh set of attempts (for example after the receiver was down for longer than the
  // retry window). The receiver sees the same delivery id as before.
  app.post(`${base}/:id/deliveries/:deliveryId/redeliver`, administrator, available, h(async (req, res) => {
    const outcome = await db.transaction(async (client) => {
      const result = await client.query(
        `UPDATE outbox SET status = 'pending', attempts = 0, next_attempt_at = now(), lease_expires_at = NULL, finished_at = NULL, last_status = NULL, last_error = NULL
         WHERE id = $1 AND webhook_id = $2 AND workspace_id = $3 AND status = 'failed' RETURNING id`,
        [req.params.deliveryId, req.params.id, req.workspaceId]
      );
      if (result.rowCount) {
        await apiAudit(req, client, { action: "webhook.redelivery_requested", resourceType: "webhook", resourceId: req.params.id, details: { deliveryId: req.params.deliveryId } });
        return "queued";
      }
      const current = await client.query("SELECT status FROM outbox WHERE id = $1 AND webhook_id = $2 AND workspace_id = $3", [req.params.deliveryId, req.params.id, req.workspaceId]);
      return current.rowCount ? "not_failed" : "missing";
    });
    if (outcome === "missing") throw new HttpError(404, "delivery_not_found");
    if (outcome === "not_failed") throw new HttpError(409, "delivery_not_failed");
    res.status(202).json({ deliveryId: req.params.deliveryId });
  }));
}
