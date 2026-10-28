import { JOB_COLUMNS, publicJob } from "./http.mjs";

const PER_SUBJECT_LIMIT = 10;

// Fans PostgreSQL NOTIFY events out to Server-Sent Events clients. One dedicated LISTEN connection per API instance.
export function createJobStream({ db, config, log, metrics }) {
  const clients = new Map(); // res -> { workspaceId, subject }
  const pending = new Set();
  let listener = null;
  let flushTimer = null;
  let reconnectTimer = null;
  let attempt = 0;
  let stopped = false;

  function send(res, event, data) { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); }
  function broadcast(workspaceId, event, data) { for (const [res, meta] of clients) if (!workspaceId || meta.workspaceId === workspaceId) send(res, event, data); }

  async function flush() {
    flushTimer = null;
    const ids = [...pending]; pending.clear();
    if (!ids.length || !clients.size) return;
    try {
      const rows = (await db.query(`SELECT ${JOB_COLUMNS} FROM test_jobs WHERE id = ANY($1::uuid[])`, [ids])).rows;
      for (const row of rows) broadcast(row.workspace_id, "job", publicJob(row));
    } catch (error) { log.error({ err: error }, "job stream flush failed"); }
  }

  function connect() {
    if (stopped) return;
    const client = db.newListenerClient();
    listener = client;
    const lost = (error) => {
      if (listener !== client) return;
      listener = null; metrics.listenerUp.set(0);
      client.removeAllListeners(); client.end().catch(() => {});
      if (error) log.error({ err: error }, "job stream listener lost");
      broadcast(null, "resync", {});
      if (!stopped) { attempt += 1; reconnectTimer = setTimeout(connect, Math.min(30_000, 500 * 2 ** Math.min(attempt, 6)) * (0.5 + Math.random() / 2)); reconnectTimer.unref(); }
    };
    client.on("error", lost);
    client.on("end", () => lost());
    client.on("notification", (message) => {
      metrics.sseNotifications.inc();
      try {
        const { w, id } = JSON.parse(message.payload);
        // Skip work when nobody in that workspace is watching.
        let watched = false; for (const meta of clients.values()) if (meta.workspaceId === w) { watched = true; break; }
        if (watched) { pending.add(id); flushTimer ??= setTimeout(flush, 100); }
      } catch { /* malformed payloads are ignored */ }
    });
    client.connect().then(() => client.query("LISTEN wirepulse_jobs")).then(() => { attempt = 0; metrics.listenerUp.set(1); log.info("job stream listener connected"); }).catch(lost);
  }

  return {
    start: connect,
    attach(req, res, next) {
      try {
        const subject = req.identity.subject;
        if (clients.size >= config.sse.maxClients) return res.status(503).json({ error: "too_many_streams" });
        let mine = 0; for (const meta of clients.values()) if (meta.subject === subject) mine += 1;
        if (mine >= PER_SUBJECT_LIMIT) return res.status(429).json({ error: "too_many_streams_for_subject" });
        res.set({ "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-store, no-transform", Connection: "keep-alive", "X-Accel-Buffering": "no" });
        res.flushHeaders();
        res.write("retry: 3000\n\n");
        clients.set(res, { workspaceId: req.workspaceId, subject });
        metrics.sseClients.set(clients.size);
        send(res, "ready", { workspaceId: req.workspaceId, listener: Boolean(listener) });
        const heartbeat = setInterval(() => res.write(": ping\n\n"), config.sse.heartbeatMs);
        // Membership and key revocation are re-checked on reconnect, so streams have a bounded lifetime.
        const lifetime = setTimeout(() => res.end(), config.sse.maxLifetimeMs);
        const cleanup = () => { clearInterval(heartbeat); clearTimeout(lifetime); clients.delete(res); metrics.sseClients.set(clients.size); };
        res.on("close", cleanup);
        return undefined;
      } catch (error) { return next(error); }
    },
    async stop() {
      stopped = true;
      clearTimeout(flushTimer); clearTimeout(reconnectTimer);
      for (const res of clients.keys()) res.end();
      clients.clear(); metrics.sseClients.set(0);
      const client = listener; listener = null;
      if (client) { client.removeAllListeners(); client.on("error", () => {}); await client.end().catch(() => {}); }
    },
    size: () => clients.size
  };
}
