import crypto from "node:crypto";
import http from "node:http";
import cors from "cors";
import express from "express";
import helmet from "helmet";
import { registerAdminRoutes } from "./admin.mjs";
import { bearerToken, createAuth, safeEqual } from "./auth.mjs";
import { startAnchoring } from "./anchor.mjs";
import { audit } from "./db.mjs";
import { registerGatewayAdminRoutes, registerGatewayRoutes, startLeaseSweeper } from "./gateways.mjs";
import { errorHandler, h, validateUuidParams } from "./http.mjs";
import { registerJobRoutes } from "./jobs.mjs";
import { createMailer } from "./mail.mjs";
import { createMetrics } from "./metrics.mjs";
import { createGuard } from "./netguard.mjs";
import { startOutbox } from "./outbox.mjs";
import { startPurge } from "./purge.mjs";
import { createRateLimiters } from "./ratelimit.mjs";
import { startRetention } from "./retention.mjs";
import { createJobStream } from "./stream.mjs";
import { createDeliverer } from "./deliver.mjs";
import { registerWebhookRoutes } from "./webhooks.mjs";

const REQUEST_ID = /^[A-Za-z0-9._-]{8,64}$/;
// Routes that carry test evidence get the larger body limit; everything else uses MAX_JSON_BYTES.
const EVIDENCE_ROUTES = [["POST", /^\/workspaces\/[^/]+\/test-reports$/], ["POST", /^\/jobs\/[^/]+\/complete$/]];

export function createApp({ config, db, log }) {
  const metrics = createMetrics({ db });
  const limiters = createRateLimiters({ config, metrics, log });
  const auth = createAuth({ config, db, log, metrics, workspaceLimiter: limiters.workspace, onAuthFailure: limiters.authFailure.record });
  const stream = createJobStream({ db, config, log, metrics });
  const state = { shuttingDown: false };
  const app = express();

  app.disable("x-powered-by");
  app.set("etag", false);
  app.set("trust proxy", config.trustProxy);
  validateUuidParams(app, ["workspaceId", "id", "deliveryId"]);

  // Request id, structured access log, and latency metrics. The query string is never logged.
  app.use((req, res, next) => {
    const incoming = req.get("x-request-id");
    req.requestId = incoming && REQUEST_ID.test(incoming) ? incoming : crypto.randomUUID();
    req.log = log.child({ requestId: req.requestId });
    res.set("x-request-id", req.requestId);
    const started = process.hrtime.bigint();
    res.on("close", () => {
      const seconds = Number(process.hrtime.bigint() - started) / 1e9;
      const route = req.route?.path ? `${req.baseUrl}${req.route.path}` : "unmatched";
      metrics.httpDuration.observe({ method: req.method, route, status: String(res.statusCode) }, seconds);
      const quiet = route === "/healthz" || route === "/readyz" || route === "/metrics";
      const level = quiet ? "debug" : res.statusCode >= 500 ? "error" : "info";
      req.log[level]({ method: req.method, path: req.originalUrl.split("?")[0], route, status: res.statusCode, durationMs: Math.round(seconds * 1000), ip: req.ip, subject: req.identity?.subject ?? (req.gateway ? `gateway:${req.gateway.id}` : undefined) }, "request");
    });
    next();
  });

  // Liveness never touches the database (a DB outage must not restart healthy API pods); readiness does.
  app.get("/healthz", (_req, res) => res.json({ status: "ok" }));
  app.get("/readyz", h(async (_req, res) => {
    if (state.shuttingDown) return res.status(503).json({ status: "shutting_down" });
    try {
      await Promise.race([db.health(), new Promise((_resolve, reject) => { setTimeout(() => reject(new Error("health check timed out")), 2000).unref(); })]);
      return res.json({ status: "ready", checks: { database: "ok" } });
    } catch { return res.status(503).json({ status: "unavailable", checks: { database: "failing" } }); }
  }));

  const metricsGuard = (req, res, next) => {
    if (config.metrics.token) return safeEqual(bearerToken(req) ?? "", config.metrics.token) ? next() : res.status(401).json({ error: "metrics_token_required" });
    return config.production ? res.status(404).json({ error: "not_found" }) : next();
  };
  const metricsHandler = h(async (_req, res) => { res.set("Content-Type", metrics.registry.contentType); res.send(await metrics.registry.metrics()); });
  if (config.metrics.port === 0) app.get("/metrics", metricsGuard, metricsHandler);

  app.use(helmet({ contentSecurityPolicy: { directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] } }, referrerPolicy: { policy: "no-referrer" }, crossOriginResourcePolicy: { policy: "same-site" } }));
  app.use(cors({
    origin: config.corsOrigins, methods: ["GET", "POST", "PUT", "PATCH", "DELETE"], allowedHeaders: ["Authorization", "Content-Type", "If-Match-Version", "X-Request-Id"],
    exposedHeaders: ["x-request-id", "x-next-cursor"], maxAge: 600
  }));
  app.use((_req, res, next) => { res.set("Cache-Control", "no-store"); next(); });

  const jsonOptions = { type: "application/json", strict: true };
  const parsers = { default: express.json({ ...jsonOptions, limit: config.limits.jsonBytes }), evidence: express.json({ ...jsonOptions, limit: config.limits.evidenceBytes }) };
  // Parsing happens after authentication, so anonymous clients cannot make the server buffer large bodies.
  const parseBody = (req, res, next) => (EVIDENCE_ROUTES.some(([method, pattern]) => req.method === method && pattern.test(req.path)) ? parsers.evidence : parsers.default)(req, res, next);

  const apiAudit = (req, executor, values) => audit(executor, { workspaceId: req.workspaceId, actor: req.identity.subject, requestId: req.requestId, ip: req.ip, ...values });
  // Where webhooks may be sent (see netguard.mjs) and how invitation email leaves; both are only built when configured.
  const guard = createGuard({ allowedCidrs: config.webhooks?.allowedCidrs ?? [], allowAll: config.webhooks?.allowPrivateNetworks ?? false });
  const mailer = config.smtp ? createMailer(config.smtp) : null;
  const ctx = { db, config, log, metrics, auth, apiAudit, stream, guard };

  app.use(limiters.ip);
  app.use("/gateway/v1", limiters.authFailure, auth.gatewayAuth, limiters.gateway, parseBody);
  registerGatewayRoutes(app, ctx);
  app.use("/v1", limiters.authFailure, auth.identity, limiters.subject, parseBody);
  registerAdminRoutes(app, ctx);
  registerJobRoutes(app, ctx);
  registerGatewayAdminRoutes(app, ctx);
  registerWebhookRoutes(app, ctx);

  app.use((req, res) => res.status(404).json({ error: "not_found", requestId: req.requestId }));
  app.use(errorHandler({ log, metrics }));

  let server = null; let metricsServer = null; let sweeper = null; let retention = null; let anchoring = null; let outbox = null; let purge = null;

  async function listen(target, port) {
    await new Promise((resolve, reject) => { target.once("error", reject); target.listen(port, resolve); });
    return target.address().port;
  }

  return {
    app, metrics, stream,
    async start() {
      server = http.createServer(app);
      // Longer than typical load-balancer idle timeouts (60s) so the balancer, not the API, closes idle connections.
      server.keepAliveTimeout = 65_000; server.headersTimeout = 66_000; server.requestTimeout = 60_000;
      const port = await listen(server, config.port);
      if (config.metrics.port > 0) {
        const metricsApp = express();
        metricsApp.disable("x-powered-by");
        metricsApp.get("/metrics", metricsGuard, metricsHandler);
        metricsServer = http.createServer(metricsApp);
        await listen(metricsServer, config.metrics.port);
      }
      stream.start();
      sweeper = startLeaseSweeper({ db, config, log, metrics });
      retention = startRetention({ db, config, log, metrics });
      anchoring = startAnchoring({ db, config, log, metrics });
      purge = startPurge({ db, config, log, metrics });
      if (config.webhooks || config.smtp) outbox = startOutbox({ db, config, log, metrics, deliver: createDeliverer({ db, config, mailer, guard }) });
      return { port };
    },
    // Stops accepting work, lets in-flight requests finish, closes streams and the pool.
    async shutdown({ graceMs = 10_000 } = {}) {
      if (state.shuttingDown) return;
      state.shuttingDown = true;
      sweeper?.stop(); retention?.stop(); anchoring?.stop();
      const outboxStopped = outbox?.stop(); const purgeStopped = purge?.stop();
      await stream.stop();
      const closed = server ? new Promise((resolve) => server.close(resolve)) : Promise.resolve();
      server?.closeIdleConnections();
      const force = setTimeout(() => server?.closeAllConnections(), graceMs);
      await closed;
      clearTimeout(force);
      if (metricsServer) await new Promise((resolve) => { metricsServer.close(resolve); metricsServer.closeAllConnections(); });
      await limiters.close();
      await outboxStopped; await purgeStopped;
      mailer?.close();
      await db.close();
    }
  };
}
