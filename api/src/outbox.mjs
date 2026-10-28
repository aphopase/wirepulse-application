export const WEBHOOK_EVENTS = Object.freeze(["job.finished"]);

// Called inside the transaction that changes the job, before its audit insert (the audit insert must stay the last statement), so a
// delivery exists exactly when the change committed. One row per subscribed webhook.
export async function enqueueWebhooks(client, workspaceId, eventType, data) {
  await client.query(
    `INSERT INTO outbox (workspace_id, kind, webhook_id, event_type, payload)
     SELECT workspace_id, 'webhook', id, $2, $3::jsonb FROM webhooks WHERE workspace_id = $1 AND enabled AND $2 = ANY(events)`,
    [workspaceId, eventType, JSON.stringify(data)]
  );
}

export async function enqueueEmail(client, workspaceId, { to, subject, text }) {
  await client.query("INSERT INTO outbox (workspace_id, kind, event_type, payload) VALUES ($1, 'email', 'email.invitation', $2::jsonb)", [workspaceId, JSON.stringify({ to, subject, text })]);
}

// Seconds to wait before attempt n+1 after n failures: 10 s, 30 s, 2 min, 10 min, 30 min, 1 h, 2 h, 4 h ... capped at 6 h, +-20% jitter.
const BACKOFF_SECONDS = [10, 30, 120, 600, 1800, 3600, 7200, 14_400];
export const backoffSeconds = (failures, random = Math.random) => Math.round(Math.min(BACKOFF_SECONDS[Math.min(failures, BACKOFF_SECONDS.length) - 1] ?? 21_600, 21_600) * (0.8 + random() * 0.4));

const BATCH = 20;
const CLEANUP_EVERY_MS = 3_600_000;

// Delivers due outbox rows. Safe to run on every instance: rows are claimed with FOR UPDATE SKIP LOCKED and a lease, so each row is in
// one worker's hands at a time and a crashed worker's rows come back when the lease runs out. Delivery is at-least-once.
export function startOutbox({ db, config, log, metrics, deliver }) {
  const { maxAttempts, intervalMs, retentionDays } = config.outbox;
  // A lease outlasts any one delivery (bounded by the webhook timeout) with room for the database round trips around it.
  const leaseSeconds = Math.ceil(((config.webhooks?.timeoutMs ?? 10_000) * 2) / 1000) + 30;
  let running = null; let stopped = false; let lastCleanup = 0;

  async function claim() {
    return (await db.query(
      `WITH due AS (
         SELECT id FROM outbox WHERE status = 'pending' AND next_attempt_at <= now() AND attempts < $1 AND (lease_expires_at IS NULL OR lease_expires_at < now())
         ORDER BY next_attempt_at LIMIT $2 FOR UPDATE SKIP LOCKED)
       UPDATE outbox o SET attempts = o.attempts + 1, lease_expires_at = now() + make_interval(secs => $3)
       FROM due WHERE o.id = due.id RETURNING o.id, o.workspace_id, o.kind, o.webhook_id, o.event_type, o.payload, o.attempts, o.created_at`,
      [maxAttempts, BATCH, leaseSeconds]
    )).rows;
  }

  // `attempts` identifies this claim: if the lease ran out and another worker took the row meanwhile, this late result is dropped.
  async function settle(row, outcome) {
    const finished = outcome.ok || outcome.permanent || row.attempts >= maxAttempts;
    const status = outcome.ok ? "delivered" : finished ? "failed" : "pending";
    const result = await db.query(
      `UPDATE outbox SET status = $3, last_status = $4, last_error = $5, lease_expires_at = NULL,
         next_attempt_at = CASE WHEN $3 = 'pending' THEN now() + make_interval(secs => $6) ELSE next_attempt_at END,
         finished_at = CASE WHEN $3 = 'pending' THEN NULL ELSE now() END,
         payload = CASE WHEN kind = 'email' AND $3 <> 'pending' THEN '{"redacted":true}'::jsonb ELSE payload END
       WHERE id = $1 AND attempts = $2 AND status = 'pending'`,
      [row.id, row.attempts, status, outcome.status ?? null, outcome.ok ? null : outcome.error, status === "pending" ? backoffSeconds(row.attempts) : 0]
    );
    return result.rowCount ? status : null;
  }

  async function handle(row) {
    let outcome;
    try { outcome = await deliver(row); } catch (error) { log.error({ err: { message: error.message }, outboxId: row.id }, "outbox delivery crashed"); outcome = { ok: false, error: "internal_error" }; }
    const status = await settle(row, outcome);
    if (status === null) return;
    const result = outcome.ok ? "delivered" : status === "failed" ? "failed" : "retry";
    metrics.outbox.inc({ kind: row.kind, result });
    if (row.kind === "webhook") metrics.webhookDeliveries.inc({ result: outcome.ok ? "success" : outcome.error === "destination_blocked" ? "blocked" : "failure" });
    if (status === "failed") log.warn({ event: "outbox.failed", outboxId: row.id, kind: row.kind, webhookId: row.webhook_id, workspaceId: row.workspace_id, reason: outcome.error, attempts: row.attempts }, "outbox message failed permanently");
  }

  async function cleanup() {
    if (Date.now() - lastCleanup < CLEANUP_EVERY_MS) return;
    lastCleanup = Date.now();
    // Rows that were claimed by crashing workers up to the attempt limit never got a result: close them out.
    await db.query("UPDATE outbox SET status = 'failed', last_error = 'abandoned', finished_at = now(), lease_expires_at = NULL, payload = CASE WHEN kind = 'email' THEN '{\"redacted\":true}'::jsonb ELSE payload END WHERE status = 'pending' AND attempts >= $1 AND (lease_expires_at IS NULL OR lease_expires_at < now())", [maxAttempts]);
    await db.query("DELETE FROM outbox WHERE status <> 'pending' AND finished_at < now() - make_interval(days => $1)", [retentionDays]);
  }

  async function runOnce() {
    if (running) return running;
    running = (async () => {
      try {
        await cleanup();
        const rows = await claim();
        await Promise.all(rows.map(handle));
        return rows.length;
      } catch (error) { log.error({ err: error }, "outbox run failed"); return 0; } finally { running = null; }
    })();
    return running;
  }

  const timer = setInterval(() => { if (!stopped) runOnce(); }, intervalMs);
  timer.unref();
  // Waits for the delivery in progress (bounded by the webhook timeout), so the pool is not closed under it.
  return { async stop() { stopped = true; clearInterval(timer); await running; }, runOnce };
}
