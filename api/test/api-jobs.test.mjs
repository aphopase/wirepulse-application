import test from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { createSimulatedTransport } from "../../gateway/src/transports.mjs";
import { runSuite } from "../../gateway/src/engine.mjs";
import { DEV_TOKEN, createClient, createTestDatabase, sampleDefinition, skip, sleep, startApi, waitFor, ws } from "./helpers.mjs";

let database; let api; let pool; let admin;

test.before(async () => {
  if (skip) return;
  database = await createTestDatabase();
  api = await startApi({ databaseUrl: database.url });
  pool = new pg.Pool({ connectionString: database.url, max: 3 });
  admin = createClient(api.url, DEV_TOKEN);
});
test.after(async () => { await api?.stop(); await pool?.end(); await database?.drop(); });

const newWorkspace = async (name) => (await admin("/v1/workspaces", { method: "POST", body: { name } })).body.id;
async function newGateway(workspaceId, name, extra = {}) {
  const response = await admin(`${ws(workspaceId)}/gateways`, { method: "POST", body: { name, ...extra } });
  assert.equal(response.status, 201);
  return { ...response.body, call: createClient(api.url, response.body.token) };
}
const queue = (workspaceId, key, extra = {}) => admin(`${ws(workspaceId)}/test-jobs`, { method: "POST", body: { definition: sampleDefinition(), idempotencyKey: key, ...extra } });
const getJob = async (workspaceId, id) => (await admin(`${ws(workspaceId)}/test-jobs/${id}`)).body;
const claim = (gateway) => gateway.call("/gateway/v1/jobs/claim", { method: "POST" });
async function runLocally(definition, answer = ["READY"]) {
  return runSuite({ tests: definition.tests, profile: definition.profile, transport: createSimulatedTransport({ responder: () => answer }) });
}
// Events arrive as `event: name` / `data: json` blocks; this collects them until closed.
async function openStream(workspaceId, token = DEV_TOKEN) {
  const controller = new AbortController();
  const response = await fetch(`${api.url}${ws(workspaceId)}/test-jobs/stream`, { headers: { authorization: `Bearer ${token}` }, signal: controller.signal });
  const events = [];
  if (response.status !== 200) return { status: response.status, events, close() {} };
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
  return { status: 200, events, close: () => controller.abort() };
}

test("gateway tokens are shown once and stored only as a hash", { skip }, async () => {
  const workspaceId = await newWorkspace("gateway-tokens");
  const gateway = await newGateway(workspaceId, "lab-1", { labels: { board: "x1" } });
  assert.match(gateway.token, /^wpg_[A-Za-z0-9_-]{40,}$/);
  assert.deepEqual(gateway.labels, { board: "x1" });
  const listed = await admin(`${ws(workspaceId)}/gateways`);
  assert.equal(listed.status, 200);
  assert.ok(!listed.text.includes(gateway.token));
  assert.ok(!("token" in listed.body[0]));
  const stored = await pool.query("SELECT token_hash FROM gateways WHERE id = $1", [gateway.id]);
  assert.notEqual(stored.rows[0].token_hash, gateway.token);
  assert.match(stored.rows[0].token_hash, /^[a-f0-9]{64}$/);
  // The human API does not accept gateway tokens, and the gateway API does not accept human tokens.
  assert.equal((await createClient(api.url, gateway.token)("/v1/workspaces")).status, 401);
  assert.equal((await admin("/gateway/v1/jobs/claim", { method: "POST" })).status, 401);
  assert.equal((await createClient(api.url, "wpg_does-not-exist-at-all")("/gateway/v1/jobs/claim", { method: "POST" })).status, 401);
});

test("gateway tokens can be rotated, expire, and be revoked", { skip }, async () => {
  const workspaceId = await newWorkspace("gateway-lifecycle");
  const gateway = await newGateway(workspaceId, "rotating", { expiresInDays: 30 });
  assert.ok(gateway.tokenExpiresAt);
  assert.equal((await gateway.call("/gateway/v1/heartbeat", { method: "POST", body: { agentVersion: "9.9.9" } })).status, 200);
  const rotated = await admin(`${ws(workspaceId)}/gateways/${gateway.id}/rotate`, { method: "POST" });
  assert.equal(rotated.status, 200); assert.notEqual(rotated.body.token, gateway.token);
  assert.equal((await gateway.call("/gateway/v1/heartbeat", { method: "POST" })).status, 401, "old token must stop working immediately");
  const fresh = createClient(api.url, rotated.body.token);
  assert.equal((await fresh("/gateway/v1/heartbeat", { method: "POST" })).status, 200);
  await pool.query("UPDATE gateways SET token_expires_at = now() - interval '1 minute' WHERE id = $1", [gateway.id]);
  assert.equal((await fresh("/gateway/v1/heartbeat", { method: "POST" })).status, 401, "expired token must be rejected");
  await pool.query("UPDATE gateways SET token_expires_at = NULL WHERE id = $1", [gateway.id]);
  assert.equal((await fresh("/gateway/v1/heartbeat", { method: "POST" })).status, 200);
  const listed = (await admin(`${ws(workspaceId)}/gateways`)).body.find((item) => item.id === gateway.id);
  assert.equal(listed.online, true); assert.equal(listed.agentVersion, "9.9.9");
  assert.equal((await admin(`${ws(workspaceId)}/gateways/${gateway.id}`, { method: "DELETE" })).status, 204);
  assert.equal((await fresh("/gateway/v1/heartbeat", { method: "POST" })).status, 401, "revoked token must be rejected");
  assert.equal((await admin(`${ws(workspaceId)}/gateways/${gateway.id}/rotate`, { method: "POST" })).status, 404);
  assert.equal((await admin(`${ws(workspaceId)}/gateways/${gateway.id}`, { method: "PATCH", body: { labels: {} } })).status, 404);
});

test("jobs record provenance, and idempotency keys replay or conflict", { skip }, async () => {
  const workspaceId = await newWorkspace("provenance");
  const suite = (await admin(`${ws(workspaceId)}/test-suites`, { method: "POST", body: { name: "smoke", definition: sampleDefinition() } })).body;
  const profile = (await admin(`${ws(workspaceId)}/profiles`, { method: "POST", body: { name: "uart", definition: { baud: 115200 } } })).body;
  const first = await queue(workspaceId, "k1", { suiteId: suite.id, profileId: profile.id });
  assert.equal(first.status, 201);
  assert.equal(first.body.suiteVersion, 1); assert.equal(first.body.profileVersion, 1);
  assert.match(first.body.definitionHash, /^[a-f0-9]{64}$/);
  assert.equal(first.body.requestedBy, "dev-admin"); assert.equal(first.body.status, "queued");
  // Editing the suite afterwards does not change what the earlier job recorded.
  await admin(`${ws(workspaceId)}/test-suites/${suite.id}`, { method: "PUT", body: { name: "smoke", definition: sampleDefinition() }, headers: { "if-match-version": "1" } });
  const second = await queue(workspaceId, "k2", { suiteId: suite.id });
  assert.equal(second.body.suiteVersion, 2);
  assert.equal((await getJob(workspaceId, first.body.id)).suiteVersion, 1);
  const replay = await queue(workspaceId, "k1", { suiteId: suite.id, profileId: profile.id });
  assert.equal(replay.status, 200); assert.equal(replay.body.id, first.body.id);
  const conflict = await admin(`${ws(workspaceId)}/test-jobs`, { method: "POST", body: { definition: sampleDefinition({ tests: [] }), idempotencyKey: "k1" } });
  assert.equal(conflict.status, 409); assert.equal(conflict.body.error, "idempotency_key_reused");
  const unknownSuite = await queue(workspaceId, "k3", { suiteId: "00000000-0000-4000-8000-000000000000" });
  assert.equal(unknownSuite.status, 404);
  assert.equal((await queue(workspaceId, "k4", { priority: 99 })).status, 400);
  assert.equal((await queue(workspaceId, "k5", { requirements: { board: 1 } })).status, 400);
  const audit = await admin(`${ws(workspaceId)}/audit-events?action=test_job.created`);
  const entry = audit.body.find((item) => item.resource_id === first.body.id);
  assert.equal(entry.details.suiteVersion, 1); assert.equal(entry.details.definitionHash, first.body.definitionHash);
});

test("job lists are paginated without gaps or duplicates, and omit bulky fields", { skip }, async () => {
  const workspaceId = await newWorkspace("pagination");
  const created = await Promise.all(Array.from({ length: 25 }, (_, index) => queue(workspaceId, `bulk-${index}`)));
  assert.ok(created.every((response) => response.status === 201));
  const seen = []; let cursor = null; let pages = 0;
  do {
    const page = await admin(`${ws(workspaceId)}/test-jobs?limit=7${cursor ? `&cursor=${cursor}` : ""}`);
    assert.equal(page.status, 200);
    for (const job of page.body) { assert.ok(!("definition" in job)); assert.ok(!("result" in job)); seen.push(job.id); }
    cursor = page.headers.get("x-next-cursor"); pages += 1;
  } while (cursor && pages < 10);
  assert.equal(pages, 4);
  assert.equal(new Set(seen).size, 25, "no duplicates");
  assert.deepEqual([...seen].sort(), created.map((response) => response.body.id).sort(), "no gaps");
  assert.equal((await admin(`${ws(workspaceId)}/test-jobs?status=queued&limit=100`)).body.length, 25);
  assert.equal((await admin(`${ws(workspaceId)}/test-jobs?status=passed`)).body.length, 0);
  assert.equal((await admin(`${ws(workspaceId)}/test-jobs?status=bogus`)).status, 400);
  assert.equal((await admin(`${ws(workspaceId)}/test-jobs?cursor=garbage`)).status, 400);
  assert.ok("definition" in (await getJob(workspaceId, created[0].body.id)));
});

test("claiming honours priority, then age, and label requirements", { skip }, async () => {
  const workspaceId = await newWorkspace("routing");
  const plain = await newGateway(workspaceId, "plain");
  const bench = await newGateway(workspaceId, "bench", { labels: { board: "x1", site: "lab" } });
  const a = (await queue(workspaceId, "a")).body; const b = (await queue(workspaceId, "b", { priority: 5 })).body;
  const c = (await queue(workspaceId, "c", { requirements: { board: "x1" } })).body; const d = (await queue(workspaceId, "d", { requirements: { board: "nope" } })).body;
  const first = await claim(plain); const second = await claim(plain);
  assert.equal(first.body.id, b.id, "higher priority first"); assert.equal(second.body.id, a.id, "then oldest");
  assert.equal((await claim(plain)).status, 204, "plain gateway cannot take labelled jobs");
  const matched = await claim(bench);
  assert.equal(matched.body.id, c.id); assert.equal(matched.body.gatewayId, bench.id); assert.deepEqual(matched.body.definition.tests.length, 1);
  assert.equal((await claim(bench)).status, 204, "board=nope is not satisfied");
  await admin(`${ws(workspaceId)}/gateways/${bench.id}`, { method: "PATCH", body: { labels: { board: "nope" } } });
  assert.equal((await claim(bench)).body.id, d.id, "label changes apply to the next claim");
  // Gateways in another workspace never see these jobs.
  const elsewhere = await newGateway(await newWorkspace("routing-other"), "elsewhere");
  await queue(workspaceId, "e");
  assert.equal((await claim(elsewhere)).status, 204);
});

test("a gateway runs the job; the server derives the result from verified evidence", { skip }, async () => {
  const workspaceId = await newWorkspace("execution");
  const gateway = await newGateway(workspaceId, "lab");
  assert.equal((await gateway.call("/gateway/v1/heartbeat", { method: "POST", body: { agentVersion: "1.2.3" } })).status, 200);
  const queued = (await queue(workspaceId, "run-1")).body;
  const claimed = (await claim(gateway)).body;
  assert.equal(claimed.id, queued.id); assert.equal(claimed.status, "assigned"); assert.equal(claimed.attempts, 1);
  assert.equal((await gateway.call(`/gateway/v1/jobs/${claimed.id}/start`, { method: "POST" })).status, 200);
  assert.equal((await gateway.call(`/gateway/v1/jobs/${claimed.id}/progress`, { method: "POST", body: { completed: 0, total: 1 } })).status, 200);
  assert.equal((await gateway.call(`/gateway/v1/jobs/${claimed.id}/progress`, { method: "POST", body: { completed: 3, total: 1 } })).status, 400);
  const running = await getJob(workspaceId, claimed.id);
  assert.equal(running.status, "running"); assert.deepEqual(running.progress, { completed: 0, total: 1 });
  const { results, evidence } = await runLocally(claimed.definition);
  const done = await gateway.call(`/gateway/v1/jobs/${claimed.id}/complete`, { method: "POST", body: { results, evidence } });
  assert.equal(done.status, 200); assert.equal(done.body.status, "passed");
  const job = await getJob(workspaceId, claimed.id);
  assert.equal(job.status, "passed"); assert.equal(job.summary.passed, 1); assert.equal(job.agentVersion, "1.2.3");
  assert.equal(job.engineFingerprint, evidence.fingerprints.engine); assert.ok(job.finishedAt); assert.equal(job.leaseExpiresAt, null);
  const reports = await admin(`${ws(workspaceId)}/test-reports`);
  assert.equal(reports.body.length, 1); assert.equal(reports.body[0].summary.evidenceFinalHash, evidence.finalHash);
  const junit = await admin(`${ws(workspaceId)}/test-jobs/${claimed.id}/junit.xml`);
  assert.equal(junit.status, 200); assert.match(junit.headers.get("content-type"), /xml/);
  assert.match(junit.text, /<testsuite [^>]*tests="1"[^>]*failures="0"/);
  assert.equal((await gateway.call(`/gateway/v1/jobs/${claimed.id}/complete`, { method: "POST", body: { results, evidence } })).status, 409, "a finished job cannot be completed twice");
  assert.equal((await claim(gateway)).status, 204);
  // A device that answers wrongly yields a failed job whose JUnit lists the failure.
  const failing = (await queue(workspaceId, "run-2")).body;
  const second = (await claim(gateway)).body;
  const bad = await runLocally(second.definition, ["ERROR"]);
  assert.equal((await gateway.call(`/gateway/v1/jobs/${failing.id}/complete`, { method: "POST", body: bad })).body.status, "failed");
  assert.match((await admin(`${ws(workspaceId)}/test-jobs/${failing.id}/junit.xml`)).text, /<failure/);
  assert.equal((await admin(`${ws(workspaceId)}/test-jobs/${queued.id}/junit.xml`, { token: DEV_TOKEN })).status, 200);
});

test("multi-megabyte junk result and event arrays are refused quickly and the job stays active", { skip }, async () => {
  const workspaceId = await newWorkspace("junk-arrays");
  const gateway = await newGateway(workspaceId, "lab");
  await queue(workspaceId, "junk-1");
  const claimed = (await claim(gateway)).body;
  const junk = (field) => (field === "results"
    ? `{"results":[${"0,".repeat(3_900_000)}0],"evidence":{}}`
    : `{"results":[],"evidence":{"events":[${"0,".repeat(3_900_000)}0]}}`);
  for (const field of ["results", "events"]) {
    const started = Date.now();
    const refused = await gateway.call(`/gateway/v1/jobs/${claimed.id}/complete`, { method: "POST", rawBody: junk(field) });
    assert.equal(refused.status, 400); assert.equal(refused.body.error, "invalid_request");
    assert.ok(Date.now() - started < 3000, `${field}: refusal took ${Date.now() - started} ms`);
  }
  assert.ok(["assigned", "running"].includes((await getJob(workspaceId, claimed.id)).status));
});

test("tampered, mismatched and inconsistent evidence is rejected and the job stays active", { skip }, async () => {
  const workspaceId = await newWorkspace("evidence");
  const gateway = await newGateway(workspaceId, "lab");
  const queued = (await queue(workspaceId, "ev-1")).body;
  const claimed = (await claim(gateway)).body;
  await gateway.call(`/gateway/v1/jobs/${claimed.id}/start`, { method: "POST" });
  const complete = (body) => gateway.call(`/gateway/v1/jobs/${queued.id}/complete`, { method: "POST", body });

  const tampered = await runLocally(claimed.definition);
  tampered.evidence.events[0].payload.testCount = 99;
  const rejected = await complete(tampered);
  assert.equal(rejected.status, 422); assert.equal(rejected.body.error, "evidence_verification_failed");

  // Valid evidence, but for a different suite than the one this job queued.
  const other = await runLocally(sampleDefinition({ tests: [{ ...claimed.definition.tests[0], id: "other", name: "other" }] }));
  const mismatch = await complete(other);
  assert.equal(mismatch.status, 422); assert.equal(mismatch.body.error, "evidence_job_mismatch");

  // Results that disagree with the evidence cannot turn a failure into a pass.
  const lying = await runLocally(claimed.definition, ["ERROR"]);
  lying.results[0].status = "passed";
  assert.equal((await complete(lying)).status, 422);

  assert.equal((await getJob(workspaceId, queued.id)).status, "running");
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM test_reports WHERE workspace_id = $1", [workspaceId])).rows[0].n, 0);
  // The honest result is still accepted afterwards.
  assert.equal((await complete(await runLocally(claimed.definition))).body.status, "passed");
});

test("cancelling tells the gateway to stop, and gateways cannot touch jobs they do not hold", { skip }, async () => {
  const workspaceId = await newWorkspace("cancel");
  const one = await newGateway(workspaceId, "one"); const two = await newGateway(workspaceId, "two");
  const queued = (await queue(workspaceId, "c1")).body;
  const claimed = (await claim(one)).body;
  const progress = (gateway, id = claimed.id) => gateway.call(`/gateway/v1/jobs/${id}/progress`, { method: "POST", body: { completed: 0, total: 1 } });
  assert.equal((await progress(two)).status, 409, "another gateway in the same workspace");
  const foreign = await newGateway(await newWorkspace("cancel-other"), "foreign");
  assert.equal((await progress(foreign)).status, 409, "a gateway in another workspace");
  assert.equal((await admin(`${ws(workspaceId)}/test-jobs/${queued.id}/cancel`, { method: "POST" })).body.status, "cancelled");
  const stop = await progress(one);
  assert.equal(stop.status, 409); assert.equal(stop.body.status, "cancelled");
  const finished = await runLocally(claimed.definition);
  assert.equal((await one.call(`/gateway/v1/jobs/${claimed.id}/complete`, { method: "POST", body: finished })).status, 409);
  assert.equal((await admin(`${ws(workspaceId)}/test-jobs/${queued.id}/cancel`, { method: "POST" })).status, 409, "already cancelled");
  assert.equal((await getJob(workspaceId, queued.id)).status, "cancelled");
});

test("abandoned leases are requeued, then time out after the attempt limit", { skip }, async () => {
  const workspaceId = await newWorkspace("leases");
  const gateway = await newGateway(workspaceId, "flaky");
  const queued = (await queue(workspaceId, "l1", { maxAttempts: 2 })).body;
  const expireLease = () => pool.query("UPDATE test_jobs SET lease_expires_at = now() - interval '1 second' WHERE id = $1", [queued.id]);
  assert.equal((await claim(gateway)).body.attempts, 1);
  await expireLease();
  await waitFor(async () => (await getJob(workspaceId, queued.id)).status === "queued", { message: "requeue" });
  const requeued = await getJob(workspaceId, queued.id);
  assert.equal(requeued.error, "gateway_lease_expired"); assert.equal(requeued.gatewayId, null);
  assert.equal((await claim(gateway)).body.attempts, 2);
  await expireLease();
  await waitFor(async () => (await getJob(workspaceId, queued.id)).status === "timed_out", { message: "timeout" });
  const timedOut = await getJob(workspaceId, queued.id);
  assert.equal(timedOut.error, "gateway_lease_expired"); assert.ok(timedOut.finishedAt);
  const actions = (await admin(`${ws(workspaceId)}/audit-events?limit=200`)).body.filter((item) => item.actor_subject === "system:sweeper").map((item) => item.action);
  assert.deepEqual(actions.sort(), ["test_job.requeued", "test_job.timed_out"]);
});

test("progress renews the lease, and jobs nobody picks up expire", { skip }, async () => {
  const workspaceId = await newWorkspace("ttl");
  const gateway = await newGateway(workspaceId, "lab");
  const live = (await queue(workspaceId, "t1")).body;
  await claim(gateway);
  await pool.query("UPDATE test_jobs SET lease_expires_at = now() + interval '1 second' WHERE id = $1", [live.id]);
  await gateway.call(`/gateway/v1/jobs/${live.id}/progress`, { method: "POST", body: { completed: 0, total: 1 } });
  const renewed = (await getJob(workspaceId, live.id)).leaseExpiresAt;
  assert.ok(new Date(renewed).getTime() > Date.now() + 3000, "lease extended by progress");
  const stale = (await queue(workspaceId, "t2")).body;
  await pool.query("UPDATE test_jobs SET created_at = now() - interval '2 hours' WHERE id = $1", [stale.id]);
  await waitFor(async () => (await getJob(workspaceId, stale.id)).status === "timed_out", { message: "queue ttl" });
  assert.equal((await getJob(workspaceId, stale.id)).error, "queue_ttl_expired");
  assert.equal((await getJob(workspaceId, live.id)).status, "running");
});

test("the database refuses impossible job states", { skip }, async () => {
  const workspaceId = await newWorkspace("invariants");
  const queued = (await queue(workspaceId, "i1")).body;
  await assert.rejects(pool.query("UPDATE test_jobs SET status = 'running' WHERE id = $1", [queued.id]), /test_jobs_state_invariants/);
  await assert.rejects(pool.query("UPDATE test_jobs SET lease_expires_at = now() + interval '1 minute' WHERE id = $1", [queued.id]), /test_jobs_state_invariants/);
  assert.equal((await getJob(workspaceId, queued.id)).status, "queued");
});

test("pagination cursors keep microsecond precision, so rows created in the same millisecond are not skipped", { skip }, async () => {
  const workspaceId = await newWorkspace("pagination-precision");
  const jobs = await Promise.all(["p1", "p2", "p3"].map(async (key) => (await queue(workspaceId, key)).body));
  const stamps = ["2026-01-01T00:00:00.123900Z", "2026-01-01T00:00:00.123500Z", "2026-01-01T00:00:00.123100Z"];
  for (const [index, job] of jobs.entries()) await pool.query("UPDATE test_jobs SET created_at = $2 WHERE id = $1", [job.id, stamps[index]]);
  const seen = []; let cursor = null;
  for (let page = 0; page < 5; page += 1) {
    const response = await admin(`${ws(workspaceId)}/test-jobs?limit=1${cursor ? `&cursor=${cursor}` : ""}`);
    seen.push(...response.body.map((job) => job.id));
    cursor = response.headers.get("x-next-cursor");
    if (!cursor) break;
  }
  assert.deepEqual(seen, jobs.map((job) => job.id));
  // Reports page on the same keyset.
  const reports = await admin(`${ws(workspaceId)}/test-reports?limit=1`);
  assert.equal(reports.status, 200);
});

test("a workspace cannot queue more jobs than its limit", { skip }, async () => {
  const limited = await startApi({ databaseUrl: database.url, env: { MAX_QUEUED_JOBS_PER_WORKSPACE: "2" } });
  try {
    const client = createClient(limited.url, DEV_TOKEN);
    const workspaceId = (await client("/v1/workspaces", { method: "POST", body: { name: "quota" } })).body.id;
    const make = (key) => client(`${ws(workspaceId)}/test-jobs`, { method: "POST", body: { definition: sampleDefinition(), idempotencyKey: key } });
    assert.equal((await make("q1")).status, 201); assert.equal((await make("q2")).status, 201);
    const full = await make("q3");
    assert.equal(full.status, 429); assert.equal(full.body.error, "queue_full");
    assert.equal((await make("q1")).status, 200, "replaying an existing key still works");
  } finally { await limited.stop(); }
});

test("live updates stream job changes to the right workspace only", { skip }, async () => {
  const watched = await newWorkspace("stream-a"); const unwatched = await newWorkspace("stream-b");
  const gateway = await newGateway(watched, "lab");
  const stream = await openStream(watched);
  const outsider = await openStream(unwatched);
  try {
    assert.equal(stream.status, 200);
    await waitFor(() => stream.events.some((item) => item.event === "ready"), { message: "ready event" });
    const queued = (await queue(watched, "s1")).body;
    await queue(unwatched, "s2");
    await waitFor(() => stream.events.some((item) => item.event === "job" && item.data.id === queued.id && item.data.status === "queued"), { message: "queued event" });
    await claim(gateway);
    await waitFor(() => stream.events.some((item) => item.event === "job" && item.data.id === queued.id && item.data.status === "assigned"), { message: "assigned event" });
    const leaked = stream.events.filter((item) => item.event === "job").some((item) => item.data.workspaceId && item.data.workspaceId !== watched);
    assert.equal(leaked, false);
    assert.ok(outsider.events.filter((item) => item.event === "job").every((item) => item.data.id !== queued.id), "other workspace sees nothing from this one");
    assert.ok(stream.events.filter((item) => item.event === "job").every((item) => !("definition" in item.data)));
  } finally { stream.close(); outsider.close(); }
  const denied = await fetch(`${api.url}${ws(watched)}/test-jobs/stream`);
  assert.equal(denied.status, 401);
  await sleep(50);
});
