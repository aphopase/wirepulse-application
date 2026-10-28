import rateLimit, { MemoryStore } from "express-rate-limit";
import { RedisStore } from "rate-limit-redis";
import { createClient } from "redis";
import { limitsFor } from "./plans.mjs";

// IPv6 clients are limited per /64 so rotating addresses inside one allocation does not bypass the limit. The address is expanded first:
// in "2001:db8::1:2:3:4" the first four colon-separated parts are not the first four groups.
export function ipKey(ip = "unknown") {
  if (!ip.includes(":") || ip.includes(".")) return ip;
  const [head, tail] = ip.split("::");
  const front = head ? head.split(":") : []; const back = tail ? tail.split(":") : [];
  const groups = tail === undefined ? front : [...front, ...Array(8 - front.length - back.length).fill("0"), ...back];
  return groups.slice(0, 4).map((group) => group.padStart(4, "0")).join(":");
}

// Uses the shared (Redis) store, and the per-instance memory store for any request the shared store cannot answer, so a Redis
// outage degrades to per-instance limits instead of removing the limits or failing requests.
class ResilientStore {
  constructor(shared, onError) { this.shared = shared; this.local = new MemoryStore(); this.onError = onError; }
  init(options) { this.shared.init(options); this.local.init(options); }
  async increment(key) {
    try { return await this.shared.increment(key); } catch (error) { this.onError(error); return this.local.increment(key); }
  }
  async get(key) {
    try { return await this.shared.get(key); } catch (error) { this.onError(error); return this.local.get(key); }
  }
  async decrement(key) {
    try { await this.shared.decrement(key); } catch (error) { this.onError(error); await this.local.decrement(key); }
  }
  async resetKey(key) {
    try { await this.shared.resetKey(key); } catch (error) { this.onError(error); }
    await this.local.resetKey(key);
  }
  shutdown() { this.local.shutdown?.(); }
}

export function createRateLimiters({ config, metrics, log }) {
  let redis = null;
  if (config.redis) {
    // Commands fail immediately while Redis is unreachable (no offline queue), and the client reconnects in the background.
    redis = createClient({ url: config.redis.url, disableOfflineQueue: true, socket: { connectTimeout: 3000, reconnectStrategy: (retries) => Math.min(retries * 200, 5000) } });
    redis.on("error", (error) => log.warn({ err: { message: error.message, code: error.code } }, "redis error"));
    redis.on("ready", () => log.info("redis connected: rate limits are shared across instances"));
    redis.connect().catch((error) => log.warn({ err: { message: error.message } }, "redis connect failed; using per-instance rate limits until it recovers"));
  }
  const reportStoreError = (() => {
    let last = 0;
    return (error) => {
      metrics.rateLimitStoreErrors.inc();
      if (Date.now() - last > 30_000) { last = Date.now(); log.warn({ err: { message: error.message } }, "shared rate-limit store unavailable; per-instance limits in effect"); }
    };
  })();

  const storeFor = (name) => {
    if (!redis) return undefined;
    const shared = new RedisStore({ prefix: `wirepulse:rl:${name}:`, sendCommand: (...args) => redis.sendCommand(args) });
    // The constructor starts loading Lua scripts; a failure then is retried on first use, but must not become an unhandled rejection.
    shared.incrementScriptSha.catch(() => {}); shared.getScriptSha.catch(() => {});
    return new ResilientStore(shared, reportStoreError);
  };
  const tooMany = (name) => (req, res) => {
    metrics.rateLimited.inc({ limiter: name });
    req.log.warn({ security: true, event: "rate_limited", limiter: name, ip: req.ip, subject: req.identity?.subject, workspaceId: req.workspaceId }, "request rate limited");
    res.status(429).json({ error: "rate_limited", requestId: req.requestId });
  };
  const limiter = (name, options) => {
    const store = storeFor(name);
    return rateLimit({ windowMs: 60_000, standardHeaders: "draft-7", legacyHeaders: false, validate: false, ...(store ? { store } : {}), handler: tooMany(name), ...options });
  };

  // Counts only rejected credentials, when they are rejected (auth.mjs calls `record`), and refuses an address that already has
  // `limit` of them in the window. The library's skipSuccessfulRequests counts every request on arrival and refunds it afterwards,
  // so more than `limit` valid requests in flight at once locked their own address out.
  const failureStore = storeFor("auth_failure") ?? new MemoryStore();
  failureStore.init({ windowMs: 60_000 });
  const rejectTooMany = tooMany("auth_failure");
  const authFailure = async (req, res, next) => {
    try {
      const seen = await failureStore.get(ipKey(req.ip));
      if (seen && seen.totalHits >= config.limits.authFailurePerMinute && seen.resetTime > new Date()) {
        res.set("Retry-After", String(Math.max(1, Math.ceil((seen.resetTime - Date.now()) / 1000))));
        return rejectTooMany(req, res);
      }
      next();
    } catch (error) { next(error); }
  };
  authFailure.record = (req) => Promise.resolve(failureStore.increment(ipKey(req.ip))).catch(() => {});

  return {
    ip: limiter("ip", { limit: config.limits.ipPerMinute, keyGenerator: (req) => ipKey(req.ip) }),
    authFailure,
    subject: limiter("subject", { limit: config.limits.subjectPerMinute, keyGenerator: (req) => req.identity.subject }),
    gateway: limiter("gateway", { limit: config.limits.gatewayPerMinute, keyGenerator: (req) => `gateway:${req.gateway.id}` }),
    // Per workspace, from the plan, so one tenant cannot use up the shared capacity. Runs after authorization (inside requireRole).
    workspace: limiter("workspace", {
      limit: (req) => limitsFor(req.workspacePlan).requestsPerMinute ?? Number.MAX_SAFE_INTEGER,
      skip: (req) => limitsFor(req.workspacePlan).requestsPerMinute === null,
      keyGenerator: (req) => `workspace:${req.workspaceId}`
    }),
    async close() {
      failureStore.shutdown?.();
      if (!redis?.isOpen) return;
      // QUIT never completes on a client that is reconnecting, so a Redis outage must not be able to stall shutdown.
      if (redis.isReady) await Promise.race([redis.quit(), new Promise((resolve) => setTimeout(resolve, 1000).unref())]).catch(() => {});
      if (redis.isOpen) redis.destroy();
    }
  };
}
