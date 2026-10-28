import client from "prom-client";

// One registry per app instance (not the global default) so tests can build several apps in a process.
export function createMetrics({ db }) {
  const registry = new client.Registry();
  client.collectDefaultMetrics({ register: registry, prefix: "wirepulse_" });
  const counter = (name, help, labelNames = []) => new client.Counter({ name: `wirepulse_${name}`, help, labelNames, registers: [registry] });

  const metrics = {
    registry,
    httpDuration: new client.Histogram({ name: "wirepulse_http_request_duration_seconds", help: "HTTP request duration", labelNames: ["method", "route", "status"], buckets: [0.005, 0.025, 0.1, 0.25, 0.5, 1, 2.5, 5, 10], registers: [registry] }),
    authFailures: counter("auth_failures_total", "Rejected credentials", ["kind", "reason"]),
    jobEvents: counter("job_events_total", "Job lifecycle events", ["event"]),
    dbTimeouts: counter("db_statement_timeouts_total", "Database statements cancelled by the statement timeout"),
    auditFailures: counter("audit_write_failures_total", "Audit events that could not be written"),
    retentionDeleted: counter("retention_deleted_total", "Rows removed by the retention job", ["kind"]),
    rateLimited: counter("rate_limited_total", "Requests rejected by a rate limiter", ["limiter"]),
    rateLimitStoreErrors: counter("rate_limit_store_errors_total", "Shared (Redis) rate-limit store failures; the per-instance limiter took over for that request"),
    outbox: counter("outbox_messages_total", "Outbox messages processed", ["kind", "result"]),
    webhookDeliveries: counter("webhook_deliveries_total", "Webhook delivery attempts", ["result"]),
    workspacesPurged: counter("workspaces_purged_total", "Offboarded workspaces whose content was purged"),
    auditAnchors: counter("audit_anchors_total", "Audit chain head anchors", ["result"]),
    sseClients: new client.Gauge({ name: "wirepulse_sse_clients", help: "Open live-update streams", registers: [registry] }),
    sseNotifications: counter("sse_notifications_total", "Job change notifications received from PostgreSQL"),
    listenerUp: new client.Gauge({ name: "wirepulse_listener_connected", help: "1 when the LISTEN connection is up", registers: [registry] })
  };

  new client.Gauge({
    name: "wirepulse_db_pool_connections", help: "Database pool connections", labelNames: ["state"], registers: [registry],
    collect() { const s = db.stats(); this.set({ state: "total" }, s.total); this.set({ state: "idle" }, s.idle); this.set({ state: "waiting" }, s.waiting); }
  });
  new client.Gauge({
    name: "wirepulse_jobs", help: "Jobs by active status", labelNames: ["status"], registers: [registry],
    async collect() {
      const rows = (await db.query("SELECT status, count(*)::int AS n FROM test_jobs WHERE status IN ('queued', 'assigned', 'running') GROUP BY status")).rows;
      for (const status of ["queued", "assigned", "running"]) this.set({ status }, rows.find((row) => row.status === status)?.n ?? 0);
    }
  });
  new client.Gauge({
    name: "wirepulse_oldest_queued_job_age_seconds", help: "Age of the oldest queued job (0 when none)", registers: [registry],
    async collect() { this.set((await db.query("SELECT COALESCE(EXTRACT(EPOCH FROM now() - min(created_at)), 0)::float AS age FROM test_jobs WHERE status = 'queued'")).rows[0].age); }
  });
  new client.Gauge({
    name: "wirepulse_gateways_online", help: "Gateways with a heartbeat in the last 90 seconds", registers: [registry],
    async collect() { this.set((await db.query("SELECT count(*)::int AS n FROM gateways WHERE revoked_at IS NULL AND last_heartbeat_at > now() - interval '90 seconds'")).rows[0].n); }
  });
  return metrics;
}
