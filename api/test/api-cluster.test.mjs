// Three API instances on one database, the way a scaled deployment runs: whatever one instance does, the others must see and
// must not repeat. Rate limits and quotas shared through Redis are in api-redis.test.mjs; the outbox and purge workers have their
// own two-instance tests. This file covers the job path: live updates, claims and lease recovery.
import test from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { DEV_TOKEN, createClient, createTestDatabase, sampleDefinition, skip, startApi, waitFor, ws } from "./helpers.mjs";

let database; let pool; let instances; let admins; let workspaceId;
const SMALL = { DB_POOL_SIZE: "3" }; // three instances, each with a pool and a listener: keep the suite's connection count down

test.before(async () => {
  if (skip) return;
  database = await createTestDatabase();
  instances = [];
  for (let i = 0; i < 3; i += 1) instances.push(await startApi({ databaseUrl: database.url, env: SMALL }));
  admins = instances.map((instance) => createClient(instance.url, DEV_TOKEN));
  pool = new pg.Pool({ connectionString: database.url, max: 3 });
  workspaceId = (await admins[0]("/v1/workspaces", { method: "POST", body: { name: "cluster" } })).body.id;
});
test.after(async () => { for (const instance of instances ?? []) await instance.stop(); await pool?.end(); await database?.drop(); });

const queue = (key) => admins[0](`${ws(workspaceId)}/test-jobs`, { method: "POST", body: { definition: sampleDefinition(), idempotencyKey: key } });
async function newGateway(name, instance) {
  const response = await admins[0](`${ws(workspaceId)}/gateways`, { method: "POST", body: { name } });
  assert.equal(response.status, 201);
  return createClient(instance.url, response.body.token);
}
const claim = (gateway) => gateway("/gateway/v1/jobs/claim", { method: "POST" });

// Events arrive as `event: name` / `data: json` blocks.
async function openStream(instance) {
  const controller = new AbortController();
  const response = await fetch(`${instance.url}${ws(workspaceId)}/test-jobs/stream`, { headers: { authorization: `Bearer ${DEV_TOKEN}` }, signal: controller.signal });
  assert.equal(response.status, 200);
  const events = [];
  (async () => {
    let buffer = ""; const decoder = new TextDecoder();
    try {
      for await (const chunk of response.body) {
        buffer += decoder.decode(chunk, { stream: true });
        let end;
        while ((end = buffer.indexOf("\n\n")) >= 0) {
          const block = buffer.slice(0, end); buffer = buffer.slice(end + 2);
          const name = /^event: (.+)$/m.exec(block); const data = /^data: (.+)$/m.exec(block);
          if (name && data) events.push({ event: name[1], data: JSON.parse(data[1]) });
        }
      }
    } catch { /* aborted */ }
  })();
  return { events, close: () => controller.abort() };
}

test("a job moves through three instances and the live stream on the third sees every step", { skip }, async () => {
  const stream = await openStream(instances[2]);
  try {
    await waitFor(() => stream.events.some((item) => item.event === "ready" && item.data.listener === true), { message: "stream ready with its database listener" });
    const gateway = await newGateway("lab-b", instances[1]);
    // The stream sends a job's state as of the moment it flushes (a hundred milliseconds after a change), so each step is awaited.
    const seen = (id, status) => waitFor(() => stream.events.some((item) => item.event === "job" && item.data.id === id && item.data.status === status), { message: `"${status}" on the third instance's stream` });
    const queued = (await queue("cluster-one")).body; // instance 0
    await seen(queued.id, "queued");
    const claimed = (await claim(gateway)).body; // instance 1
    assert.equal(claimed.id, queued.id);
    await seen(queued.id, "assigned");
    assert.equal((await gateway(`/gateway/v1/jobs/${claimed.id}/start`, { method: "POST" })).status, 200);
    await seen(queued.id, "running");
    assert.equal((await admins[0](`${ws(workspaceId)}/test-jobs/${queued.id}/cancel`, { method: "POST" })).status, 200); // instance 0 again
    await seen(queued.id, "cancelled");
  } finally {
    stream.close();
    // If a step above failed the job may still be open, and the next test hands out every queued job.
    await pool.query("UPDATE test_jobs SET status = 'cancelled', lease_expires_at = NULL, finished_at = now() WHERE idempotency_key = 'cluster-one' AND status IN ('queued', 'assigned', 'running')");
  }
});

test("gateways on different instances claim every queued job exactly once", { skip }, async () => {
  const total = 45;
  const keys = Array.from({ length: total }, (_, i) => `spread-${i}`);
  const queuedIds = new Set();
  for (let i = 0; i < total; i += 5) {
    const batch = await Promise.all(keys.slice(i, i + 5).map((key, j) => admins[(i + j) % 3](`${ws(workspaceId)}/test-jobs`, { method: "POST", body: { definition: sampleDefinition(), idempotencyKey: key } })));
    for (const response of batch) { assert.equal(response.status, 201); queuedIds.add(response.body.id); }
  }
  const gateways = await Promise.all(Array.from({ length: 6 }, (_, i) => newGateway(`spread-gw-${i}`, instances[i % 3])));
  const taken = gateways.map(() => []);
  await Promise.all(gateways.map(async (gateway, index) => {
    for (;;) {
      const response = await claim(gateway);
      if (response.status === 204) return;
      assert.equal(response.status, 200);
      taken[index].push(response.body.id);
    }
  }));
  const all = taken.flat();
  assert.equal(all.length, total, "every job was handed out");
  assert.equal(new Set(all).size, total, "and none of them twice");
  assert.deepEqual(new Set(all), queuedIds);
  assert.ok(taken.every((ids) => ids.length > 0), `every gateway got work: ${taken.map((ids) => ids.length)}`);
  const attempts = await pool.query("SELECT DISTINCT attempts FROM test_jobs WHERE id = ANY($1)", [[...queuedIds]]);
  assert.deepEqual(attempts.rows, [{ attempts: 1 }]);
});

test("when the instance a gateway was talking to disappears, a surviving instance recovers its job", { skip }, async () => {
  const doomed = await startApi({ databaseUrl: database.url, env: SMALL });
  try {
    const gateway = await newGateway("lab-doomed", doomed);
    const queued = (await queue("cluster-lease")).body;
    const claimed = (await claim(gateway)).body;
    assert.equal(claimed.id, queued.id);
    assert.equal((await gateway(`/gateway/v1/jobs/${claimed.id}/start`, { method: "POST" })).status, 200);
  } finally { await doomed.stop(); }
  // The gateway never renews the lease (JOB_LEASE_SECONDS is 5 in the harness): another instance's sweeper puts the job back.
  await waitFor(async () => (await admins[1](`${ws(workspaceId)}/test-jobs/${(await pool.query("SELECT id FROM test_jobs WHERE idempotency_key = 'cluster-lease'")).rows[0].id}`)).body.status === "queued", { timeoutMs: 20_000, message: "job requeued by a surviving instance" });
  const rescuer = await newGateway("lab-rescuer", instances[0]);
  const again = await claim(rescuer);
  assert.equal(again.status, 200);
  assert.equal(again.body.attempts, 2);
  const row = (await pool.query("SELECT status, error, attempts FROM test_jobs WHERE id = $1", [again.body.id])).rows[0];
  assert.equal(row.status, "assigned"); assert.equal(row.attempts, 2);
});
