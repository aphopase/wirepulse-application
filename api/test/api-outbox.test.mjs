// Webhook delivery over the real API, PostgreSQL, the outbox worker and the real gateway agent: what is sent and when, signatures, retries and
// give-up, leases and the stale-result guard across two instances, shutdown, retention, and the destination rules at delivery time.
// (Configuration of webhooks is in api-webhooks.test.mjs; the sender in isolation in webhook-send.test.mjs.)
import test from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { createAgent, createAgentLog } from "../../gateway/src/agent.mjs";
import { createSimulatedTransport } from "../../gateway/src/transports.mjs";
import { secretFor, verifySignature } from "../src/webhook-send.mjs";
import { DEV_TOKEN, createClient, createTestDatabase, sampleDefinition, skip, sleep, startApi, startReceiver, waitFor, ws } from "./helpers.mjs";

const SIGNING_KEY = "outbox-test-signing-key-0123456789abcdef";
// A fast worker; the allow-list lets the receivers run on loopback.
const COMMON = { WEBHOOK_SIGNING_KEY: SIGNING_KEY, OUTBOX_INTERVAL_MS: "100", WEBHOOK_TIMEOUT_MS: "5000" };
const LOOPBACK = { ...COMMON, WEBHOOK_ALLOWED_CIDRS: "127.0.0.0/8" };
const BACKOFF = [10, 30, 120, 600, 1800, 3600, 7200, 14_400];

let database; let api; let pool; let admin; let K;

// Everything that depends on which database/instance a test talks to.
function kit(client, db) {
  const hooks = (workspaceId) => `${ws(workspaceId)}/webhooks`;
  const self = {
    hooks,
    async workspace(t, name) {
      const response = await client("/v1/workspaces", { method: "POST", body: { name } });
      assert.equal(response.status, 201, response.text);
      const id = response.body.id;
      // Leftover pending deliveries of a finished test must not keep the worker busy; deleting the webhooks removes them.
      t.after(() => db.query("DELETE FROM webhooks WHERE workspace_id = $1", [id]).catch(() => {}));
      return id;
    },
    async hook(workspaceId, url, extra = {}) {
      const response = await client(hooks(workspaceId), { method: "POST", body: { name: `hook-${Math.random().toString(36).slice(2, 8)}`, url, ...extra } });
      assert.equal(response.status, 201, response.text);
      return response.body;
    },
    async ping(workspaceId, hookId) {
      const response = await client(`${hooks(workspaceId)}/${hookId}/ping`, { method: "POST" });
      assert.equal(response.status, 202, response.text);
      return response.body.deliveryId;
    },
    async row(id) { return (await db.query("SELECT * FROM outbox WHERE id = $1", [id])).rows[0]; },
    // Waits until no worker holds the row (the lease is released when a result is recorded) and it satisfies the predicate.
    until(id, predicate, message) {
      return waitFor(async () => { const row = await self.row(id); return row && row.lease_expires_at === null && predicate(row) ? row : null; }, { timeoutMs: 20_000, message });
    },
    fastForward: (id) => db.query("UPDATE outbox SET next_attempt_at = now() WHERE id = $1 AND status = 'pending'", [id]),
    async secondsUntilRetry(id) { return Number((await db.query("SELECT EXTRACT(EPOCH FROM (next_attempt_at - now())) AS s FROM outbox WHERE id = $1", [id])).rows[0].s); },
    async count(workspaceId) { return (await db.query("SELECT count(*)::int AS n FROM outbox WHERE workspace_id = $1", [workspaceId])).rows[0].n; },
    async deliveries(workspaceId, hookId, status) {
      const response = await client(`${hooks(workspaceId)}/${hookId}/deliveries${status ? `?status=${status}` : ""}`);
      assert.equal(response.status, 200, response.text);
      return response.body;
    }
  };
  return self;
}

async function isolated(t, env = LOOPBACK) {
  const db = await createTestDatabase();
  const instance = await startApi({ databaseUrl: db.url, env });
  const dbPool = new pg.Pool({ connectionString: db.url, max: 3 });
  let stopped = false;
  const stop = async () => { if (!stopped) { stopped = true; await instance.stop(); } };
  t.after(async () => { await stop(); await dbPool.end(); await db.drop(); });
  const client = createClient(instance.url, DEV_TOKEN);
  return { instance, pool: dbPool, admin: client, stop, kit: kit(client, dbPool) };
}

async function metric(instance, name, labels = {}) {
  const text = await (await fetch(`${instance.url}/metrics`)).text();
  return text.split("\n")
    .filter((line) => (line.startsWith(`${name}{`) || line.startsWith(`${name} `)) && Object.entries(labels).every(([key, value]) => line.includes(`${key}="${value}"`)))
    .reduce((sum, line) => sum + Number(line.split(" ").at(-1)), 0);
}
const messages = (instance, result) => metric(instance, "wirepulse_outbox_messages_total", { kind: "webhook", result });
const deliveriesMetric = (instance, result) => metric(instance, "wirepulse_webhook_deliveries_total", { result });

const arrived = (target, count, message) => waitFor(() => target.requests.length >= count, { message: message ?? `${count} request(s) at the receiver` });
// Waits long enough for an unwanted extra request to show up (the worker polls every 100 ms), then checks the count.
async function stillExactly(target, count) { await sleep(600); assert.equal(target.requests.length, count, `receiver got ${target.requests.length} requests, expected ${count}`); }
const ok = (_req, res) => { res.statusCode = 200; res.end("ok"); };

function assertSigned(request, secret, { event, deliveryId }) {
  assert.equal(request.method, "POST");
  assert.equal(request.headers["content-type"], "application/json");
  assert.equal(request.headers["user-agent"], "WirePulse-Webhooks/1");
  assert.equal(request.headers["x-wirepulse-event"], event);
  assert.equal(request.headers["x-wirepulse-delivery"], deliveryId);
  assert.equal(verifySignature(secret, request.headers["x-wirepulse-signature"], request.body, { now: request.at }), true, "the signature verifies against the raw body");
}

function runAgent(t, gateway, device) {
  const config = { apiUrl: api.url, token: gateway.token, serialPath: "/dev/ttyTEST", pollMs: 50, leaseRenewMs: 500, heartbeatMs: 300, requestTimeoutMs: 3000, maxBackoffMs: 200, shutdownGraceMs: 300 };
  const agent = createAgent({
    config, log: createAgentLog({ write: () => {}, secrets: [gateway.token] }),
    openTransport: async () => createSimulatedTransport({ responder: () => device.answer })
  });
  const done = agent.run().then(() => null, (error) => error);
  t.after(async () => { agent.stop(); await done; });
}

test.before(async () => {
  if (skip) return;
  database = await createTestDatabase();
  api = await startApi({ databaseUrl: database.url, env: LOOPBACK });
  pool = new pg.Pool({ connectionString: database.url, max: 3 });
  admin = createClient(api.url, DEV_TOKEN);
  K = kit(admin, pool);
});
test.after(async () => { await api?.stop(); await pool?.end(); await database?.drop(); });

test("a ping is delivered once, signed, with the documented envelope and headers; the receiver's answer is never kept", { skip }, async (t) => {
  const target = await startReceiver((_req, res) => { res.statusCode = 200; res.end("RECEIVER-SECRET-ANSWER"); });
  t.after(() => target.close());
  const workspaceId = await K.workspace(t, "ping");
  const token = "tok-abc123def456";
  const hook = await K.hook(workspaceId, `${target.url}/in/here?token=${token}`);
  const before = { delivered: await messages(api, "delivered"), success: await deliveriesMetric(api, "success") };

  const deliveryId = await K.ping(workspaceId, hook.id);
  const row = await K.until(deliveryId, (r) => r.status === "delivered", "the ping to be delivered");
  await stillExactly(target, 1);
  assert.deepEqual([row.attempts, row.last_status, row.last_error], [1, 200, null]);

  const [request] = target.requests;
  assert.equal(request.url, `/in/here?token=${token}`, "the configured path and query are used as given");
  assertSigned(request, hook.secret, { event: "webhook.ping", deliveryId });
  const envelope = JSON.parse(request.body);
  assert.deepEqual(Object.keys(envelope).sort(), ["createdAt", "data", "id", "type", "workspaceId"]);
  assert.deepEqual([envelope.id, envelope.type, envelope.workspaceId, envelope.data], [deliveryId, "webhook.ping", workspaceId, { message: "ping" }]);
  assert.ok(!Number.isNaN(Date.parse(envelope.createdAt)));
  // Tampering, a wrong secret and a rotated secret all fail verification at the receiver.
  const signature = request.headers["x-wirepulse-signature"];
  assert.equal(verifySignature(hook.secret, signature, `${request.body} `, { now: request.at }), false);
  assert.equal(verifySignature(secretFor(SIGNING_KEY, hook.id, 2), signature, request.body, { now: request.at }), false);

  const [listed] = await K.deliveries(workspaceId, hook.id);
  assert.deepEqual([listed.id, listed.eventType, listed.status, listed.attempts, listed.lastStatus, listed.lastError, listed.nextAttemptAt], [deliveryId, "webhook.ping", "delivered", 1, 200, null, null]);
  assert.ok(listed.finishedAt);
  await waitFor(async () => (await messages(api, "delivered")) === before.delivered + 1 && (await deliveriesMetric(api, "success")) === before.success + 1, { message: "the delivery metrics" });

  // Nothing about the destination token or the receiver's answer is kept or logged.
  const stored = (await pool.query("SELECT to_jsonb(outbox)::text AS text FROM outbox WHERE id = $1", [deliveryId])).rows[0].text;
  for (const secret of [token, "RECEIVER-SECRET-ANSWER", hook.secret]) { assert.ok(!stored.includes(secret), `outbox row lacks ${secret}`); assert.ok(!api.logs().includes(secret), `log lacks ${secret}`); }
  assert.ok(!JSON.stringify(listed).includes("RECEIVER-SECRET-ANSWER"));
});

test("job.finished: the real agent's passed and failed jobs each produce exactly one delivery, with no events for the steps in between", { skip }, async (t) => {
  const target = await startReceiver(ok);
  t.after(() => target.close());
  const workspaceId = await K.workspace(t, "events");
  const hook = await K.hook(workspaceId, `${target.url}/events`);
  const gateway = (await admin(`${ws(workspaceId)}/gateways`, { method: "POST", body: { name: "lab" } })).body;
  const device = { answer: ["READY"] };
  runAgent(t, gateway, device);
  const queue = async (key) => { const response = await admin(`${ws(workspaceId)}/test-jobs`, { method: "POST", body: { definition: sampleDefinition(), idempotencyKey: key } }); assert.equal(response.status, 201, response.text); return response.body; };
  const job = async (id) => (await admin(`${ws(workspaceId)}/test-jobs/${id}`)).body;

  const good = await queue("good");
  await arrived(target, 1, "the passed event");
  await stillExactly(target, 1); // queued, assigned and running produced nothing
  const passed = JSON.parse(target.requests[0].body);
  assertSigned(target.requests[0], hook.secret, { event: "job.finished", deliveryId: passed.id });
  assert.deepEqual([passed.type, passed.workspaceId, passed.data.id, passed.data.status, passed.data.gatewayId], ["job.finished", workspaceId, good.id, "passed", gateway.id]);
  assert.equal(passed.data.summary.passed, 1);
  assert.ok(!("definition" in passed.data) && !("result" in passed.data), "events carry the job's status, not its definition or evidence");
  assert.ok(!target.requests[0].body.includes(gateway.token));
  assert.equal((await job(good.id)).status, "passed");
  assert.equal(await K.count(workspaceId), 1);

  device.answer = ["ERROR"];
  const bad = await queue("bad");
  await arrived(target, 2, "the failed event");
  await stillExactly(target, 2);
  const failed = JSON.parse(target.requests[1].body);
  assertSigned(target.requests[1], hook.secret, { event: "job.finished", deliveryId: failed.id });
  assert.deepEqual([failed.data.id, failed.data.status, failed.data.summary.failed], [bad.id, "failed", 1]);
  assert.notEqual(failed.id, passed.id);

  const listed = await K.deliveries(workspaceId, hook.id);
  assert.deepEqual(listed.map((d) => [d.status, d.attempts, d.lastStatus]), [["delivered", 1, 200], ["delivered", 1, 200]]);
});

test("cancel and queue expiry notify too; a refused cancel, other workspaces and disabled webhooks do not; the event commits with the change", { skip }, async (t) => {
  const [target, other, disabled] = await Promise.all([startReceiver(ok), startReceiver(ok), startReceiver(ok)]);
  t.after(() => Promise.all([target.close(), other.close(), disabled.close()]));
  const workspaceId = await K.workspace(t, "cancel"); const otherId = await K.workspace(t, "cancel-other");
  const hook = await K.hook(workspaceId, `${target.url}/a`);
  await K.hook(otherId, `${other.url}/b`);
  const off = await K.hook(workspaceId, `${disabled.url}/c`);
  assert.equal((await admin(`${K.hooks(workspaceId)}/${off.id}`, { method: "PATCH", body: { enabled: false } })).status, 200);
  const queue = async (key) => (await admin(`${ws(workspaceId)}/test-jobs`, { method: "POST", body: { definition: sampleDefinition(), idempotencyKey: key } })).body;
  const cancel = (id) => admin(`${ws(workspaceId)}/test-jobs/${id}/cancel`, { method: "POST" });

  const first = await queue("one");
  assert.equal((await cancel(first.id)).status, 200);
  await arrived(target, 1);
  assert.equal((await cancel(first.id)).status, 409, "already finished");
  await stillExactly(target, 1);
  const cancelled = JSON.parse(target.requests[0].body);
  assertSigned(target.requests[0], hook.secret, { event: "job.finished", deliveryId: cancelled.id });
  assert.deepEqual([cancelled.data.id, cancelled.data.status], [first.id, "cancelled"]);
  assert.equal(await K.count(workspaceId), 1, "one row: the disabled webhook was not queued and the refused cancel added nothing");
  assert.equal(await K.count(otherId), 0); assert.equal(other.requests.length, 0); assert.equal(disabled.requests.length, 0);

  // A job nobody picked up expires through the sweeper, which runs repeatedly: still one event.
  const stale = await queue("two");
  await pool.query("UPDATE test_jobs SET created_at = now() - interval '3 hours' WHERE id = $1", [stale.id]);
  await arrived(target, 2, "the queue-expiry event");
  await stillExactly(target, 2);
  const expired = JSON.parse(target.requests[1].body);
  assert.deepEqual([expired.data.id, expired.data.status, expired.data.error], [stale.id, "timed_out", "queue_ttl_expired"]);
  assert.equal(await K.count(workspaceId), 2);

  // The delivery is created in the same transaction as the change: if it cannot be created, the change does not happen either.
  await pool.query("CREATE OR REPLACE FUNCTION wp_test_refuse_outbox() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'outbox refused for test'; END $$ LANGUAGE plpgsql");
  await pool.query("CREATE TRIGGER wp_test_refuse_outbox BEFORE INSERT ON outbox FOR EACH ROW EXECUTE FUNCTION wp_test_refuse_outbox()");
  const guarded = await queue("three");
  try {
    const refused = await cancel(guarded.id);
    assert.equal(refused.status, 500);
    assert.equal((await admin(`${ws(workspaceId)}/test-jobs/${guarded.id}`)).body.status, "queued", "the job was not cancelled");
    const audit = (await admin(`${ws(workspaceId)}/audit-events/export.ndjson`)).text;
    assert.ok(!audit.includes(guarded.id) || !audit.split("\n").some((line) => line.includes(guarded.id) && line.includes("test_job.cancelled")), "and no cancellation was audited");
  } finally {
    await pool.query("DROP TRIGGER IF EXISTS wp_test_refuse_outbox ON outbox");
    await pool.query("DROP FUNCTION IF EXISTS wp_test_refuse_outbox()");
  }
  assert.equal((await cancel(guarded.id)).status, 200, "and works once the delivery can be created");
  await arrived(target, 3);
  assert.equal((await admin(`${ws(workspaceId)}/audit/verify`)).body.valid, true);
});

test("a receiver that fails is retried with growing delays; the delivery id and body never change; its answers are not kept", { skip }, async (t) => {
  const answers = [503, 404, 429, 200];
  const target = await startReceiver((_req, res, _record, n) => { res.statusCode = answers[n - 1]; res.end(`RECEIVER-ANSWER-${n}`); });
  t.after(() => target.close());
  const workspaceId = await K.workspace(t, "retry");
  const hook = await K.hook(workspaceId, `${target.url}/flaky`);
  const deliveryId = await K.ping(workspaceId, hook.id);

  for (let n = 1; n <= 3; n += 1) {
    const row = await K.until(deliveryId, (r) => r.attempts === n, `attempt ${n} to be recorded`);
    assert.deepEqual([row.status, row.last_status, row.last_error], ["pending", answers[n - 1], `http_${answers[n - 1]}`]);
    const wait = await K.secondsUntilRetry(deliveryId);
    assert.ok(wait > BACKOFF[n - 1] * 0.8 - 2 && wait < BACKOFF[n - 1] * 1.2 + 2, `retry ${n} is due in ${wait.toFixed(1)} s, expected about ${BACKOFF[n - 1]} s`);
    await stillExactly(target, n); // not retried before it is due
    if (n === 1) {
      const [listed] = await K.deliveries(workspaceId, hook.id);
      assert.deepEqual([listed.status, listed.attempts, listed.lastStatus, listed.lastError], ["pending", 1, 503, "http_503"]);
      assert.ok(listed.nextAttemptAt && listed.finishedAt === null);
    }
    await K.fastForward(deliveryId);
  }
  const done = await K.until(deliveryId, (r) => r.status === "delivered", "the fourth attempt to succeed");
  assert.deepEqual([done.attempts, done.last_status, done.last_error], [4, 200, null]);
  await stillExactly(target, 4);

  assert.equal(new Set(target.requests.map((r) => r.headers["x-wirepulse-delivery"])).size, 1, "one delivery id across attempts");
  assert.equal(new Set(target.requests.map((r) => r.body)).size, 1, "a byte-identical body across attempts");
  for (const request of target.requests) assertSigned(request, hook.secret, { event: "webhook.ping", deliveryId });
  const stored = (await pool.query("SELECT to_jsonb(outbox)::text AS text FROM outbox WHERE id = $1", [deliveryId])).rows[0].text;
  assert.ok(!stored.includes("RECEIVER-ANSWER") && !api.logs().includes("RECEIVER-ANSWER"));
});

test("after the maximum number of attempts a delivery fails for good and stays quiet; redelivery starts it afresh", { skip }, async (t) => {
  const target = await startReceiver((_req, res) => { res.statusCode = 500; res.end("down"); });
  t.after(() => target.close());
  const workspaceId = await K.workspace(t, "give-up");
  const token = "tok-giveup-7f3a91";
  const hook = await K.hook(workspaceId, `${target.url}/down?token=${token}`);
  const before = { failed: await messages(api, "failed"), retry: await messages(api, "retry"), failure: await deliveriesMetric(api, "failure") };
  const deliveryId = await K.ping(workspaceId, hook.id);

  for (let n = 1; n < 8; n += 1) {
    const row = await K.until(deliveryId, (r) => r.attempts === n, `attempt ${n}`);
    assert.equal(row.status, "pending", `still retrying after attempt ${n}`);
    const wait = await K.secondsUntilRetry(deliveryId);
    assert.ok(wait > BACKOFF[n - 1] * 0.8 - 2 && wait < BACKOFF[n - 1] * 1.2 + 2, `retry ${n} due in ${wait.toFixed(1)} s, expected about ${BACKOFF[n - 1]} s`);
    await K.fastForward(deliveryId);
  }
  const failed = await K.until(deliveryId, (r) => r.status === "failed", "the eighth attempt to be final");
  assert.deepEqual([failed.attempts, failed.last_status, failed.last_error], [8, 500, "http_500"]);
  assert.ok(failed.finished_at);
  await stillExactly(target, 8);
  assert.equal(new Set(target.requests.map((r) => r.headers["x-wirepulse-delivery"])).size, 1);
  for (const request of target.requests) assertSigned(request, hook.secret, { event: "webhook.ping", deliveryId });

  const [listed] = await K.deliveries(workspaceId, hook.id, "failed");
  assert.deepEqual([listed.id, listed.status, listed.attempts, listed.nextAttemptAt], [deliveryId, "failed", 8, null]);
  assert.deepEqual(await K.deliveries(workspaceId, hook.id, "pending"), []);
  const entry = api.logEntries().find((e) => e.event === "outbox.failed" && e.outboxId === deliveryId);
  assert.ok(entry, "the permanent failure is logged");
  assert.deepEqual([entry.reason, entry.attempts, entry.kind, entry.workspaceId, entry.webhookId], ["http_500", 8, "webhook", workspaceId, hook.id]);
  assert.ok(!api.logs().includes(token) && !api.logs().includes(target.url), "the destination is not logged");
  await waitFor(async () => (await messages(api, "failed")) === before.failed + 1 && (await messages(api, "retry")) === before.retry + 7 && (await deliveriesMetric(api, "failure")) === before.failure + 8, { message: "failure metrics (1 failed, 7 retries)" });

  // Redelivery: only failed deliveries, with a fresh budget, the same id, and only in their own webhook.
  const redeliver = (id) => admin(`${K.hooks(workspaceId)}/${hook.id}/deliveries/${id}/redeliver`, { method: "POST" });
  assert.equal((await redeliver("00000000-0000-4000-8000-000000000000")).status, 404);
  target.setHandler(ok);
  assert.equal((await redeliver(deliveryId)).status, 202);
  const again = await K.until(deliveryId, (r) => r.status === "delivered", "the redelivery");
  assert.deepEqual([again.attempts, again.last_status, again.last_error], [1, 200, null]);
  assert.equal(target.requests.length, 9);
  assert.equal(target.requests[8].headers["x-wirepulse-delivery"], deliveryId);
  assertSigned(target.requests[8], hook.secret, { event: "webhook.ping", deliveryId });
  const second = await redeliver(deliveryId);
  assert.equal(second.status, 409); assert.equal(second.body.error, "delivery_not_failed");
  await stillExactly(target, 9);
});

test("a claimed delivery is left alone while its lease holds, retried when the lease runs out, and never past the attempt limit", { skip }, async (t) => {
  const target = await startReceiver(ok);
  t.after(() => target.close());
  const workspaceId = await K.workspace(t, "lease");
  const hook = await K.hook(workspaceId, `${target.url}/lease`);
  const insert = async (attempts, leaseSql) => (await pool.query(
    `INSERT INTO outbox (workspace_id, kind, webhook_id, event_type, payload, attempts, next_attempt_at, lease_expires_at)
     VALUES ($1, 'webhook', $2, 'webhook.ping', '{"message":"ping"}'::jsonb, $3, now() - interval '1 second', ${leaseSql}) RETURNING id`, [workspaceId, hook.id, attempts])).rows[0].id;
  const held = await insert(1, "now() + interval '1 hour'");   // a worker is (or was) on it
  const exhausted = await insert(8, "now() - interval '1 second'"); // attempts used up, lease long gone

  await stillExactly(target, 0);
  assert.deepEqual([(await K.row(held)).attempts, (await K.row(exhausted)).attempts], [1, 8], "neither was touched");

  await pool.query("UPDATE outbox SET lease_expires_at = now() - interval '1 second' WHERE id = $1", [held]);
  const row = await K.until(held, (r) => r.status === "delivered", "the abandoned delivery to be retried");
  assert.equal(row.attempts, 2);
  await stillExactly(target, 1);
  assert.equal(target.requests[0].headers["x-wirepulse-delivery"], held);
  assert.deepEqual([(await K.row(exhausted)).status, (await K.row(exhausted)).attempts], ["pending", 8], "and the exhausted one is still not attempted");
});

test("a late result from a worker whose lease expired is discarded and cannot overwrite the newer attempt", { skip }, async (t) => {
  const second = await startApi({ databaseUrl: database.url, env: LOOPBACK });
  t.after(() => second.stop());
  let held = null;
  const target = await startReceiver((_req, res, _record, n) => { if (n === 1) { held = res; return; } res.statusCode = 500; res.end("no"); });
  t.after(() => { held?.destroy(); return target.close(); });
  const workspaceId = await K.workspace(t, "stale");
  const hook = await K.hook(workspaceId, `${target.url}/slow`);
  const instances = [api, second];
  const total = async (result) => (await Promise.all(instances.map((i) => messages(i, result)))).reduce((a, b) => a + b, 0);
  const before = { delivered: await total("delivered"), retry: await total("retry") };

  const deliveryId = await K.ping(workspaceId, hook.id);
  await arrived(target, 1, "the first attempt (held open by the receiver)");
  assert.equal((await K.row(deliveryId)).attempts, 1);
  // The worker's lease runs out while it waits; the other instance takes over and gets an error.
  await pool.query("UPDATE outbox SET lease_expires_at = now() - interval '1 second' WHERE id = $1", [deliveryId]);
  await arrived(target, 2, "the takeover attempt");
  const takeover = await K.until(deliveryId, (r) => r.attempts === 2, "the takeover to be recorded");
  assert.deepEqual([takeover.status, takeover.last_status, takeover.last_error], ["pending", 500, "http_500"]);

  // Now the first worker's request finally succeeds. That result belongs to an attempt that was superseded.
  held.statusCode = 200; held.end("ok"); held = null;
  await sleep(800);
  const after = await K.row(deliveryId);
  assert.deepEqual([after.status, after.attempts, after.last_status, after.last_error], ["pending", 2, 500, "http_500"], "the late success did not mark the delivery as delivered");
  assert.equal(await total("delivered"), before.delivered, "and was not counted");
  assert.equal(await total("retry"), before.retry + 1);
});

test("two instances on one database never deliver the same message twice", { skip }, async (t) => {
  const second = await startApi({ databaseUrl: database.url, env: LOOPBACK });
  t.after(() => second.stop());
  const target = await startReceiver((_req, res) => { setTimeout(() => { res.statusCode = 200; res.end("ok"); }, 300); });
  t.after(() => target.close());
  const workspaceId = await K.workspace(t, "pair");
  const hook = await K.hook(workspaceId, `${target.url}/many`);
  const total = async (result) => (await Promise.all([api, second].map((i) => messages(i, result)))).reduce((a, b) => a + b, 0);
  const before = { delivered: await total("delivered"), api: await messages(api, "delivered"), second: await messages(second, "delivered") };

  const ids = (await pool.query(
    `INSERT INTO outbox (workspace_id, kind, webhook_id, event_type, payload) SELECT $1, 'webhook', $2, 'webhook.ping', '{"message":"ping"}'::jsonb FROM generate_series(1, 60) RETURNING id`,
    [workspaceId, hook.id])).rows.map((row) => row.id);
  await waitFor(async () => (await pool.query("SELECT count(*)::int AS n FROM outbox WHERE id = ANY($1) AND status = 'delivered' AND lease_expires_at IS NULL", [ids])).rows[0].n === 60, { timeoutMs: 30_000, message: "all 60 deliveries" });
  await stillExactly(target, 60);
  const seen = target.requests.map((r) => r.headers["x-wirepulse-delivery"]);
  assert.equal(new Set(seen).size, 60, "no delivery id arrived twice");
  assert.deepEqual([...new Set(seen)].sort(), [...ids].sort());
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM outbox WHERE id = ANY($1) AND attempts = 1", [ids])).rows[0].n, 60, "each was claimed exactly once");
  await waitFor(async () => (await total("delivered")) === before.delivered + 60, { message: "the metrics to add up to 60" });
  assert.ok((await messages(api, "delivered")) > before.api && (await messages(second, "delivered")) > before.second, "both instances did part of the work");
});

test("a delivery that another transaction is holding does not hold up the others", { skip }, async (t) => {
  const target = await startReceiver(ok);
  t.after(() => target.close());
  const workspaceId = await K.workspace(t, "locked");
  const hook = await K.hook(workspaceId, `${target.url}/locked`);
  // Row A becomes due while a transaction holds its lock (for example another instance in the middle of claiming it).
  const a = (await pool.query(
    `INSERT INTO outbox (workspace_id, kind, webhook_id, event_type, payload, next_attempt_at) VALUES ($1, 'webhook', $2, 'webhook.ping', '{"message":"a"}'::jsonb, now() + interval '1 second') RETURNING id`,
    [workspaceId, hook.id])).rows[0].id;
  const holder = await pool.connect();
  try {
    await holder.query("BEGIN");
    await holder.query("SELECT id FROM outbox WHERE id = $1 FOR UPDATE", [a]);
    await sleep(1300); // A is now due, and locked
    const b = await K.ping(workspaceId, hook.id);
    await waitFor(async () => (await K.row(b)).status === "delivered", { timeoutMs: 4000, message: "B to be delivered while A is locked" });
    assert.deepEqual(target.requests.map((r) => r.headers["x-wirepulse-delivery"]), [b]);
    assert.equal((await K.row(a)).attempts, 0, "A was left to whoever holds it");
  } finally { await holder.query("ROLLBACK"); holder.release(); }
  const row = await K.until(a, (r) => r.status === "delivered", "A to be delivered once it was free");
  assert.equal(row.attempts, 1);
});

test("shutting down waits for the delivery in progress and records its result before the database closes", { skip }, async (t) => {
  const solo = await isolated(t);
  const target = await startReceiver((_req, res) => { setTimeout(() => { res.statusCode = 200; res.end("ok"); }, 1500); });
  t.after(() => target.close());
  const workspaceId = await solo.kit.workspace(t, "shutdown");
  const hook = await solo.kit.hook(workspaceId, `${target.url}/slow`);
  const deliveryId = await solo.kit.ping(workspaceId, hook.id);
  await arrived(target, 1, "the slow delivery to start");

  const started = Date.now();
  await solo.stop();
  assert.ok(Date.now() - started >= 500, "shutdown waited for the receiver");
  const row = await solo.kit.row(deliveryId);
  assert.deepEqual([row.status, row.attempts, row.last_status, row.lease_expires_at], ["delivered", 1, 200, null], "the result was recorded, not lost with the pool");
  assert.ok(!solo.instance.logs().includes("outbox run failed"));
});

test("old deliveries are pruned, abandoned ones are closed out, and live or waiting ones are left alone", { skip }, async (t) => {
  const solo = await isolated(t, { ...LOOPBACK, OUTBOX_INTERVAL_MS: "2500" });
  const { pool: db } = solo;
  const workspaceId = await solo.kit.workspace(t, "retention");
  const hook = await solo.kit.hook(workspaceId, "https://127.0.0.1:9/never");
  const email = '{"to":"a@example.com","subject":"s","text":"body with invitation"}';
  const add = async (kind, status, { attempts = 0, finished = null, lease = null, next = "now() + interval '1 day'", created = "now()", payload = '{"message":"ping"}' } = {}) => (await db.query(
    `INSERT INTO outbox (workspace_id, kind, webhook_id, event_type, payload, status, attempts, finished_at, lease_expires_at, next_attempt_at, created_at)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, ${finished ?? "NULL"}, ${lease ?? "NULL"}, ${next}, ${created}) RETURNING id`,
    [workspaceId, kind, kind === "webhook" ? hook.id : null, kind === "webhook" ? "webhook.ping" : "email.invitation", payload, status, attempts])).rows[0].id;
  const old = "now() - interval '30 days'"; const recent = "now() - interval '1 day'";
  const rows = {
    oldDelivered: await add("webhook", "delivered", { attempts: 1, finished: old, created: old }),
    oldFailed: await add("webhook", "failed", { attempts: 8, finished: old, created: old }),
    oldEmail: await add("email", "delivered", { attempts: 1, finished: old, created: old, payload: '{"redacted":true}' }),
    recentDelivered: await add("webhook", "delivered", { attempts: 1, finished: recent, created: recent }),
    waiting: await add("webhook", "pending", { attempts: 2, created: old }),
    abandoned: await add("webhook", "pending", { attempts: 8, lease: "now() - interval '1 minute'" }),
    leased: await add("webhook", "pending", { attempts: 8, lease: "now() + interval '1 hour'" }),
    abandonedEmail: await add("email", "pending", { attempts: 8, payload: email })
  };
  await waitFor(async () => (await solo.kit.row(rows.abandoned))?.status === "failed", { timeoutMs: 15_000, message: "the first cleanup" });
  const present = async (id) => Boolean(await solo.kit.row(id));
  assert.deepEqual([await present(rows.oldDelivered), await present(rows.oldFailed), await present(rows.oldEmail)], [false, false, false], "finished rows past retention are deleted");
  assert.deepEqual([await present(rows.recentDelivered), await present(rows.waiting)], [true, true], "recent and waiting rows stay");
  const abandoned = await solo.kit.row(rows.abandoned);
  assert.deepEqual([abandoned.status, abandoned.last_error], ["failed", "abandoned"]); assert.ok(abandoned.finished_at);
  assert.deepEqual([(await solo.kit.row(rows.leased)).status, (await solo.kit.row(rows.waiting)).status], ["pending", "pending"], "a live lease is respected");
  const mail = await solo.kit.row(rows.abandonedEmail);
  assert.deepEqual([mail.status, mail.last_error, mail.payload], ["failed", "abandoned", { redacted: true }], "an abandoned email no longer holds its text");
});

test("edits take effect for deliveries still waiting: a new secret, a new destination, a disabled webhook, a deleted webhook", { skip }, async (t) => {
  const stale = await startReceiver((_req, res) => { res.statusCode = 500; res.end("no"); });
  const fresh = await startReceiver(ok);
  t.after(() => Promise.all([stale.close(), fresh.close()]));
  const workspaceId = await K.workspace(t, "edits");
  const hook = await K.hook(workspaceId, `${stale.url}/old`);
  const path = `${K.hooks(workspaceId)}/${hook.id}`;

  const first = await K.ping(workspaceId, hook.id);
  await K.until(first, (r) => r.attempts === 1 && r.status === "pending", "the first attempt to fail");
  const rotated = (await admin(`${path}/rotate-secret`, { method: "POST" })).body.secret;
  assert.equal((await admin(path, { method: "PATCH", body: { url: `${fresh.url}/new` } })).status, 200);
  await K.fastForward(first);
  await K.until(first, (r) => r.status === "delivered", "delivery to the new destination");
  assert.equal(stale.requests.length, 1, "the old destination heard nothing more");
  assert.equal(fresh.requests[0].url, "/new");
  assertSigned(fresh.requests[0], rotated, { event: "webhook.ping", deliveryId: first });
  assert.equal(verifySignature(hook.secret, fresh.requests[0].headers["x-wirepulse-signature"], fresh.requests[0].body, { now: fresh.requests[0].at }), false, "the old secret no longer verifies");

  // Disabling stops a waiting delivery for good (it is not silently held); re-enabling and redelivering works.
  fresh.setHandler((_req, res) => { res.statusCode = 500; res.end("no"); });
  const second = await K.ping(workspaceId, hook.id);
  await K.until(second, (r) => r.attempts === 1 && r.status === "pending", "the second ping to fail");
  assert.equal((await admin(path, { method: "PATCH", body: { enabled: false } })).status, 200);
  await K.fastForward(second);
  const closed = await K.until(second, (r) => r.status === "failed", "the disabled webhook to close its delivery");
  assert.deepEqual([closed.last_error, closed.attempts], ["webhook_disabled", 2]);
  await stillExactly(fresh, 2);
  fresh.setHandler(ok);
  assert.equal((await admin(path, { method: "PATCH", body: { enabled: true } })).status, 200);
  assert.equal((await admin(`${path}/deliveries/${second}/redeliver`, { method: "POST" })).status, 202);
  await K.until(second, (r) => r.status === "delivered", "the redelivery after re-enabling");

  // Deleting the webhook removes its waiting deliveries with it.
  fresh.setHandler((_req, res) => { res.statusCode = 500; res.end("no"); });
  const third = await K.ping(workspaceId, hook.id);
  await K.until(third, (r) => r.attempts === 1 && r.status === "pending", "the third ping to fail");
  assert.equal((await admin(path, { method: "DELETE" })).status, 204);
  assert.equal(await K.row(third), undefined);
  await K.fastForward(third);
  const requests = fresh.requests.length;
  await sleep(600);
  assert.equal(fresh.requests.length, requests);
});

test("destinations are judged again at delivery: a host name that resolves to a private address is never contacted, and the failure is permanent", { skip }, async (t) => {
  const solo = await isolated(t, COMMON); // no allow-list
  const target = await startReceiver(ok);
  t.after(() => target.close());
  const workspaceId = await solo.kit.workspace(t, "ssrf");
  const token = "tok-ssrf-91bd47";
  const hook = await solo.kit.hook(workspaceId, `http://localhost:${target.port}/hook?token=${token}`); // a name: accepted at configuration time
  const before = await deliveriesMetric(solo.instance, "blocked");
  const deliveryId = await solo.kit.ping(workspaceId, hook.id);
  const row = await solo.kit.until(deliveryId, (r) => r.status === "failed", "the blocked delivery to be closed");
  assert.deepEqual([row.attempts, row.last_status, row.last_error], [1, null, "destination_blocked"], "permanent after one attempt");
  await stillExactly(target, 0);
  const [listed] = await solo.kit.deliveries(workspaceId, hook.id);
  assert.deepEqual([listed.status, listed.lastError], ["failed", "destination_blocked"]);
  await waitFor(async () => (await deliveriesMetric(solo.instance, "blocked")) === before + 1, { message: "the blocked metric" });
  const entry = solo.instance.logEntries().find((e) => e.event === "outbox.failed" && e.outboxId === deliveryId);
  assert.equal(entry?.reason, "destination_blocked");
  assert.ok(!solo.instance.logs().includes(token) && !JSON.stringify(row).includes(token) && !JSON.stringify(listed).includes("127.0.0.1"));

  // A name that does not resolve is an ordinary, retryable failure (the receiver may simply not exist yet).
  const lost = await solo.kit.hook(workspaceId, "https://no-such-host.invalid/hook");
  const lostId = await solo.kit.ping(workspaceId, lost.id);
  const retry = await solo.kit.until(lostId, (r) => r.attempts === 1, "the unresolvable name to fail once");
  assert.deepEqual([retry.status, retry.last_error], ["pending", "dns_failed"]);
});

test("a job that is only handed back to the queue after its gateway's lease expires sends nothing; only the final timeout does", { skip }, async (t) => {
  const target = await startReceiver(ok);
  t.after(() => target.close());
  const workspaceId = await K.workspace(t, "requeue");
  await K.hook(workspaceId, `${target.url}/requeue`);
  const gateway = (await admin(`${ws(workspaceId)}/gateways`, { method: "POST", body: { name: "flaky" } })).body;
  const job = (await admin(`${ws(workspaceId)}/test-jobs`, { method: "POST", body: { definition: sampleDefinition(), idempotencyKey: "requeue" } })).body;
  const lose = (attempts) => pool.query("UPDATE test_jobs SET status = 'running', gateway_id = $2, attempts = $3, lease_expires_at = now() - interval '1 second' WHERE id = $1", [job.id, gateway.id, attempts]);
  const state = async () => (await admin(`${ws(workspaceId)}/test-jobs/${job.id}`)).body;

  await lose(1); // the gateway vanished mid-run with attempts left: the sweeper requeues it
  await waitFor(async () => (await state()).status === "queued", { message: "the job to be requeued" });
  assert.equal((await state()).error, "gateway_lease_expired");
  await stillExactly(target, 0);
  assert.equal(await K.count(workspaceId), 0);

  const { max_attempts: maxAttempts } = (await pool.query("SELECT max_attempts FROM test_jobs WHERE id = $1", [job.id])).rows[0];
  await lose(maxAttempts); // out of attempts: now it is final
  await waitFor(async () => (await state()).status === "timed_out", { message: "the job to time out" });
  await arrived(target, 1);
  await stillExactly(target, 1);
  const event = JSON.parse(target.requests[0].body);
  assert.deepEqual([event.type, event.data.id, event.data.status, event.data.error], ["job.finished", job.id, "timed_out", "gateway_lease_expired"]);
});
