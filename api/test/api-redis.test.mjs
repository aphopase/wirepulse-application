// Needs a disposable Redis (WP_TEST_REDIS_URL, e.g. redis://127.0.0.1:6379) in addition to the PostgreSQL server. The test removes
// every `wirepulse:rl:*` key it finds there, so never point it at a Redis that holds anything else.
import test from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import pg from "pg";
import { createClient as createRedis } from "redis";
import { DEV_TOKEN, createClient, createTestDatabase, skip as skipDatabase, startApi, waitFor, ws } from "./helpers.mjs";

const REDIS_URL = process.env.WP_TEST_REDIS_URL;
const skip = skipDatabase || (REDIS_URL ? false : "WP_TEST_REDIS_URL not set");

let database; let redis; let pool;
test.before(async () => {
  if (skip) return;
  database = await createTestDatabase();
  pool = new pg.Pool({ connectionString: database.url, max: 3 });
  redis = createRedis({ url: REDIS_URL });
  await redis.connect();
});
test.after(async () => { await redis?.quit(); await pool?.end(); await database?.drop(); });

const clearLimiterKeys = async () => { const keys = await redis.keys("wirepulse:rl:*"); if (keys.length) await redis.del(keys); };
const connectedCount = (app) => (app.logs().match(/redis connected/g) ?? []).length;
const startShared = async (redisUrl, env = {}) => {
  const app = await startApi({ databaseUrl: database.url, env: { REDIS_URL: redisUrl, ...env } });
  await waitFor(() => connectedCount(app) >= 1, { message: "the app to connect to Redis" });
  return app;
};
const tally = (responses) => responses.reduce((counts, response) => ({ ...counts, [response.status]: (counts[response.status] ?? 0) + 1 }), {});
const metricsText = (app) => app.instance.metrics.registry.metrics();

// A TCP proxy in front of Redis that can be taken down and brought back on the same port, to simulate an outage.
async function startProxy(targetUrl) {
  const target = new URL(targetUrl);
  const sockets = new Set();
  const server = net.createServer((client) => {
    const upstream = net.connect(Number(target.port), target.hostname);
    for (const socket of [client, upstream]) { sockets.add(socket); socket.on("close", () => sockets.delete(socket)); socket.on("error", () => socket.destroy()); }
    client.pipe(upstream); upstream.pipe(client);
  });
  const listen = (port) => new Promise((resolve) => server.listen(port, "127.0.0.1", resolve));
  await listen(0);
  const port = server.address().port;
  return {
    url: `redis://127.0.0.1:${port}`,
    async down() { for (const socket of sockets) socket.destroy(); await new Promise((resolve) => server.close(resolve)); },
    async up() { await listen(port); },
    stop: () => { for (const socket of sockets) socket.destroy(); server.close(); }
  };
}

test("rate limits are shared by every instance through Redis", { skip }, async () => {
  await clearLimiterKeys();
  const first = await startShared(REDIS_URL, { RATE_LIMIT_IP_PER_MINUTE: "10" });
  const second = await startShared(REDIS_URL, { RATE_LIMIT_IP_PER_MINUTE: "10" });
  try {
    const a = createClient(first.url, DEV_TOKEN); const b = createClient(second.url, DEV_TOKEN);
    // Six requests per instance would fit under a per-instance limit of ten; together they exceed the shared one.
    const responses = [];
    for (let i = 0; i < 6; i++) { responses.push(await a("/v1/workspaces")); responses.push(await b("/v1/workspaces")); }
    assert.deepEqual(tally(responses), { 200: 10, 429: 2 });
    assert.ok((await redis.keys("wirepulse:rl:ip:*")).length > 0, "the counters live in Redis");
    assert.doesNotMatch(await metricsText(first), /wirepulse_rate_limit_store_errors_total [1-9]/, "a healthy Redis causes no fallbacks");
  } finally { await second.stop(); await first.stop(); }
});

test("rejected credentials are counted across instances, and valid requests in flight are not", { skip }, async () => {
  await clearLimiterKeys();
  const first = await startShared(REDIS_URL, { AUTH_FAILURE_LIMIT_PER_MINUTE: "3" });
  const second = await startShared(REDIS_URL, { AUTH_FAILURE_LIMIT_PER_MINUTE: "3" });
  try {
    const good = [createClient(first.url, DEV_TOKEN), createClient(second.url, DEV_TOKEN)];
    const burst = await Promise.all(Array.from({ length: 40 }, (_, i) => good[i % 2]("/v1/workspaces")));
    assert.deepEqual(tally(burst), { 200: 40 }, "forty valid requests in flight are not failures");
    const a = createClient(first.url, "wrong-a"); const b = createClient(second.url, "wrong-b");
    const statuses = [];
    for (const call of [a, b, a, b, a]) statuses.push((await call("/v1/workspaces")).status);
    assert.deepEqual(statuses, [401, 401, 401, 429, 429], "three rejections across two instances use the shared budget up");
    assert.ok((await redis.keys("wirepulse:rl:auth_failure:*")).length > 0, "the counter lives in Redis");
  } finally { await second.stop(); await first.stop(); }
});

test("a workspace's request budget is shared across instances", { skip }, async () => {
  await clearLimiterKeys();
  const first = await startShared(REDIS_URL, { DEFAULT_PLAN: "free" });
  const second = await startShared(REDIS_URL, { DEFAULT_PLAN: "free" });
  try {
    const a = createClient(first.url, DEV_TOKEN); const b = createClient(second.url, DEV_TOKEN);
    const workspaceId = (await a("/v1/workspaces", { method: "POST", body: { name: "shared-budget" } })).body.id;
    const responses = await Promise.all(Array.from({ length: 140 }, (_, index) => (index % 2 ? a : b)(`${ws(workspaceId)}/usage`)));
    assert.deepEqual(tally(responses), { 200: 120, 429: 20 }, "free plan: 120 requests a minute in total, however they are spread over instances");
  } finally { await second.stop(); await first.stop(); }
});

test("an unreachable Redis degrades to per-instance limits and never fails requests", { skip }, async () => {
  const app = await startApi({ databaseUrl: database.url, env: { REDIS_URL: "redis://127.0.0.1:1", RATE_LIMIT_IP_PER_MINUTE: "5" } });
  try {
    const call = createClient(app.url, DEV_TOKEN);
    const responses = []; for (let i = 0; i < 8; i++) responses.push(await call("/v1/workspaces"));
    assert.deepEqual(tally(responses), { 200: 5, 429: 3 }, "the limit still holds, per instance");
    assert.match(await metricsText(app), /wirepulse_rate_limit_store_errors_total [1-9]/);
    assert.match(app.logs(), /shared rate-limit store unavailable|redis connect failed/);
  } finally { await app.stop(); }
});

test("when Redis goes away mid-flight requests keep working, and sharing resumes when it returns", { skip }, async () => {
  await clearLimiterKeys();
  const proxy = await startProxy(REDIS_URL);
  const app = await startShared(proxy.url, { RATE_LIMIT_IP_PER_MINUTE: "1000" });
  try {
    const call = createClient(app.url, DEV_TOKEN);
    for (let i = 0; i < 3; i++) assert.equal((await call("/v1/workspaces")).status, 200);
    const counted = async () => Number(await redis.get((await redis.keys("wirepulse:rl:ip:*"))[0]));
    assert.equal(await counted(), 3);

    await proxy.down();
    await waitFor(async () => (await call("/v1/workspaces")).status === 200 && /wirepulse_rate_limit_store_errors_total [1-9]/.test(await metricsText(app)), { message: "the fallback to take over" });
    const during = []; for (let i = 0; i < 5; i++) during.push(await call("/v1/workspaces"));
    assert.deepEqual(tally(during), { 200: 5 }, "no request fails while Redis is down");

    await proxy.up();
    await waitFor(() => connectedCount(app) >= 2, { timeoutMs: 20_000, message: "the app to reconnect to Redis" });
    const before = await counted();
    await waitFor(async () => { await call("/v1/workspaces"); return (await counted()) > before; }, { message: "the counters to move back to Redis" });
  } finally { await app.stop(); proxy.stop(); }
});
