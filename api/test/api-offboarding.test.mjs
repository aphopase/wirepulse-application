import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import path from "node:path";
import pg from "pg";
import { createSimulatedTransport } from "../../gateway/src/transports.mjs";
import { runSuite } from "../../gateway/src/engine.mjs";
import { PLANS } from "../src/plans.mjs";
import { startPurge } from "../src/purge.mjs";
import { DEV_TOKEN, createClient, createTestDatabase, sampleDefinition, skip, sleep, startApi, startIssuer, waitFor, ws } from "./helpers.mjs";

const CLI = path.join(import.meta.dirname, "..", "src", "admin-cli.mjs");
// Everything a workspace owns, as the purge worker sees it.
const OWNED = ["outbox", "webhooks", "test_reports", "test_jobs", "resource_versions", "test_suites", "shared_profiles", "gateways", "api_keys", "workspace_invitations", "workspace_members", "workspace_usage"];

let dbA; let dbB; let issuer; let api; let capped; let purgerOne; let purgerTwo; let poolA; let poolB; let admin; let adminB;
const as = async (client, sub, options = {}) => createClient(client.url, await issuer.sign({ sub, ...options }));

test.before(async () => {
  if (skip) return;
  issuer = await startIssuer();
  // Database A: nothing purges here (the purge interval is the default five minutes), so a deleted workspace stays inspectable.
  dbA = await createTestDatabase();
  api = await startApi({ databaseUrl: dbA.url, issuer, env: { WORKSPACE_PURGE_GRACE_DAYS: "7" } });
  capped = await startApi({ databaseUrl: dbA.url, issuer, env: { WORKSPACE_PURGE_GRACE_DAYS: "7", MAX_WORKSPACES_PER_USER: "2" } });
  poolA = new pg.Pool({ connectionString: dbA.url, max: 3 });
  admin = createClient(api.url, DEV_TOKEN);
  // Database B: two instances purge every 100 ms.
  dbB = await createTestDatabase();
  const purging = { WORKSPACE_PURGE_GRACE_DAYS: "1", WORKSPACE_PURGE_INTERVAL_MS: "100" };
  purgerOne = await startApi({ databaseUrl: dbB.url, issuer, env: purging });
  purgerTwo = await startApi({ databaseUrl: dbB.url, issuer, env: purging });
  poolB = new pg.Pool({ connectionString: dbB.url, max: 3 });
  adminB = createClient(purgerOne.url, DEV_TOKEN);
});
test.after(async () => {
  await purgerTwo?.stop(); await purgerOne?.stop(); await capped?.stop(); await api?.stop();
  await poolA?.end(); await poolB?.end(); await issuer?.stop(); await dbA?.drop(); await dbB?.drop();
});

const cli = (database, ...args) => new Promise((resolve) => {
  execFile(process.execPath, [CLI, ...args], { env: { ...process.env, DATABASE_URL: database.url, DEV_BEARER_TOKEN: DEV_TOKEN, LOG_LEVEL: "silent" } }, (error, stdout, stderr) => resolve({ code: error ? error.code : 0, stdout, stderr: stderr.trim() }));
});
const newWorkspace = async (client, name) => (await client("/v1/workspaces", { method: "POST", body: { name } })).body.id;
const counts = async (pool, workspaceId) => Object.fromEntries(await Promise.all(OWNED.map(async (table) => [table, (await pool.query(`SELECT count(*)::int AS n FROM ${table} WHERE workspace_id = $1`, [workspaceId])).rows[0].n])));
const row = async (pool, workspaceId) => (await pool.query("SELECT * FROM workspaces WHERE id = $1", [workspaceId])).rows[0];
const auditActions = async (pool, workspaceId) => (await pool.query("SELECT action, actor_subject FROM audit_events WHERE workspace_id = $1 ORDER BY chain_seq", [workspaceId])).rows;
const verifyChain = async (pool, workspaceId) => (await pool.query("SELECT checked, first_bad_seq FROM wirepulse_audit_verify($1, 0, 100000)", [workspaceId])).rows[0];
const remove = (client, workspaceId, name) => client(`${ws(workspaceId)}?confirm=${encodeURIComponent(name)}`, { method: "DELETE" });
async function suiteResult() {
  const definition = sampleDefinition();
  return runSuite({ tests: definition.tests, profile: definition.profile, transport: createSimulatedTransport({ responder: () => ["READY"] }) });
}

// One of everything the workspace can own, through the real API where there is one.
async function populate(name) {
  const workspaceId = await newWorkspace(admin, name);
  const base = ws(workspaceId);
  assert.equal((await admin(`${base}/test-suites`, { method: "POST", body: { name: "suite", definition: sampleDefinition() } })).status, 201);
  assert.equal((await admin(`${base}/profiles`, { method: "POST", body: { name: "profile", definition: { baudRate: 9600 } } })).status, 201);
  const gateway = (await admin(`${base}/gateways`, { method: "POST", body: { name: "lab" } })).body;
  const key = (await admin(`${base}/api-keys`, { method: "POST", body: { name: "ci", role: "maintainer" } })).body;
  assert.equal((await admin(`${base}/invitations`, { method: "POST", body: { email: "later@example.com", role: "viewer" } })).status, 201);
  assert.equal((await admin(`${base}/test-jobs`, { method: "POST", body: { definition: sampleDefinition(), idempotencyKey: "running-one" } })).status, 201);
  assert.equal((await admin(`${base}/test-jobs`, { method: "POST", body: { definition: sampleDefinition(), idempotencyKey: "queued-one" } })).status, 201);
  const agent = createClient(api.url, gateway.token);
  const claimed = (await agent("/gateway/v1/jobs/claim", { method: "POST" })).body;
  assert.equal((await agent(`/gateway/v1/jobs/${claimed.id}/start`, { method: "POST" })).status, 200);
  const { results, evidence } = await suiteResult();
  const summary = { passed: 1, failed: 0, total: 1, evidenceSchema: evidence.schema, evidenceFinalHash: evidence.finalHash };
  assert.equal((await admin(`${base}/test-reports`, { method: "POST", body: { summary, result: { results, evidence } } })).status, 201);
  const hook = (await poolA.query("INSERT INTO webhooks (workspace_id, name, url, events, created_by) VALUES ($1, 'hook', 'https://example.com/hook', '{job.finished}', 'dev-admin') RETURNING id", [workspaceId])).rows[0].id;
  await poolA.query("INSERT INTO outbox (workspace_id, kind, webhook_id, event_type, payload) VALUES ($1, 'webhook', $2, 'job.finished', '{\"waiting\":true}')", [workspaceId, hook]);
  await poolA.query("INSERT INTO outbox (workspace_id, kind, event_type, payload) VALUES ($1, 'email', 'email.invitation', '{\"to\":\"later@example.com\",\"subject\":\"s\",\"text\":\"secret text\"}')", [workspaceId]);
  await poolA.query("INSERT INTO outbox (workspace_id, kind, webhook_id, event_type, payload, status, finished_at) VALUES ($1, 'webhook', $2, 'job.finished', '{}', 'delivered', now())", [workspaceId, hook]);
  return { workspaceId, gateway: agent, gatewayToken: gateway.token, keyToken: key.token, runningJob: claimed.id };
}

test("deleting a workspace needs its exact name, an administrator and a person", { skip }, async () => {
  const workspaceId = await newWorkspace(admin, "Guarded Workspace");
  const base = ws(workspaceId);
  const key = (await admin(`${base}/api-keys`, { method: "POST", body: { name: "robot", role: "maintainer" } })).body;
  const engineer = (await admin(`${base}/api-keys`, { method: "POST", body: { name: "eng", role: "engineer" } })).body;
  await poolA.query("INSERT INTO workspace_members (workspace_id, subject, email, role) VALUES ($1, 'maintainer-1', 'm@example.com', 'maintainer')", [workspaceId]);

  assert.equal((await admin(base, { method: "DELETE" })).status, 400, "no confirmation");
  const wrong = await remove(admin, workspaceId, "guarded workspace");
  assert.equal(wrong.status, 400); assert.equal(wrong.body.error, "confirmation_mismatch", "the name is case sensitive");
  assert.equal((await remove(admin, workspaceId, "Guarded Workspace ")).status, 400, "and exact");
  assert.equal((await admin(`${base}?confirm=Guarded%20Workspace&extra=1`, { method: "DELETE" })).status, 400, "unknown query parameters are refused");
  assert.equal((await remove(createClient(api.url, null), workspaceId, "Guarded Workspace")).status, 401);
  assert.equal((await remove(await as(api, "maintainer-1"), workspaceId, "Guarded Workspace")).status, 403, "only administrators");
  assert.equal((await remove(createClient(api.url, key.token), workspaceId, "Guarded Workspace")).status, 403, "an API key can never be an administrator");
  assert.equal((await remove(createClient(api.url, engineer.token), workspaceId, "Guarded Workspace")).status, 403);
  assert.equal((await remove(await as(api, "stranger"), workspaceId, "Guarded Workspace")).status, 403);
  assert.equal((await row(poolA, workspaceId)).deleted_at, null, "none of that deleted anything");
  assert.deepEqual((await auditActions(poolA, workspaceId)).filter((event) => event.action === "workspace.deleted"), []);

  const done = await remove(admin, workspaceId, "Guarded Workspace");
  assert.equal(done.status, 200);
  assert.equal((await remove(admin, workspaceId, "Guarded Workspace")).status, 403, "a deleted workspace is gone for its administrators too");
});

test("deleting stops everything at once: access, jobs, gateways, keys, invitations, webhooks and queued messages", { skip }, async () => {
  const keep = await populate("Keep Me");
  const target = await populate("Offboard Me");
  const alice = await as(api, "alice");
  await poolA.query("INSERT INTO workspace_members (workspace_id, subject, email, role) VALUES ($1, 'alice', 'alice@example.com', 'viewer')", [target.workspaceId]);
  const before = await counts(poolA, target.workspaceId);
  assert.deepEqual(before, { outbox: 3, webhooks: 1, test_reports: 1, test_jobs: 2, resource_versions: 2, test_suites: 1, shared_profiles: 1, gateways: 1, api_keys: 1, workspace_invitations: 1, workspace_members: 2, workspace_usage: 1 });
  assert.equal((await alice(`${ws(target.workspaceId)}/test-suites`)).status, 200);

  const done = await remove(admin, target.workspaceId, "Offboard Me");
  assert.equal(done.status, 200);
  assert.equal(done.body.id, target.workspaceId);
  assert.equal(Math.round((Date.parse(done.body.purgeAfter) - Date.parse(done.body.deletedAt)) / 86_400_000), 7, "the grace period comes from the configuration");

  // Access ends at once, for every kind of credential, and nothing else is affected.
  for (const request of [admin, alice]) {
    assert.equal((await request(`${ws(target.workspaceId)}/usage`)).status, 403);
    assert.equal((await request(`${ws(target.workspaceId)}/test-suites`)).status, 403);
  }
  assert.equal((await createClient(api.url, target.keyToken)(`${ws(target.workspaceId)}/usage`)).status, 401, "its API keys are revoked");
  assert.equal((await target.gateway("/gateway/v1/jobs/claim", { method: "POST" })).status, 401, "the gateway can no longer claim work");
  assert.equal((await target.gateway(`/gateway/v1/jobs/${target.runningJob}/start`, { method: "POST" })).status, 401);
  assert.ok(!(await admin("/v1/workspaces")).body.some((item) => item.id === target.workspaceId), "it disappears from the list");
  assert.ok(!(await alice("/v1/workspaces")).body.some((item) => item.id === target.workspaceId));
  assert.equal((await createClient(api.url, keep.keyToken)(`${ws(keep.workspaceId)}/usage`)).status, 200, "other workspaces keep working");
  assert.equal((await keep.gateway("/gateway/v1/heartbeat", { method: "POST", body: {} })).status, 200);

  // Everything that could still act for it is stopped, in the same transaction.
  assert.deepEqual((await poolA.query("SELECT status, count(*)::int AS n FROM test_jobs WHERE workspace_id = $1 GROUP BY status", [target.workspaceId])).rows, [{ status: "cancelled", n: 2 }]);
  assert.equal((await poolA.query("SELECT count(*)::int AS n FROM test_jobs WHERE workspace_id = $1 AND finished_at IS NULL", [target.workspaceId])).rows[0].n, 0);
  assert.equal((await poolA.query("SELECT count(*)::int AS n FROM gateways WHERE workspace_id = $1 AND revoked_at IS NULL", [target.workspaceId])).rows[0].n, 0);
  assert.equal((await poolA.query("SELECT count(*)::int AS n FROM api_keys WHERE workspace_id = $1 AND revoked_at IS NULL", [target.workspaceId])).rows[0].n, 0);
  assert.equal((await poolA.query("SELECT count(*)::int AS n FROM workspace_invitations WHERE workspace_id = $1 AND revoked_at IS NULL", [target.workspaceId])).rows[0].n, 0);
  assert.equal((await poolA.query("SELECT count(*)::int AS n FROM webhooks WHERE workspace_id = $1 AND enabled", [target.workspaceId])).rows[0].n, 0);
  const outbox = (await poolA.query("SELECT kind, status, last_error, payload FROM outbox WHERE workspace_id = $1 ORDER BY kind, status", [target.workspaceId])).rows;
  assert.deepEqual(outbox.map((message) => [message.kind, message.status, message.last_error]), [["email", "failed", "workspace_deleted"], ["webhook", "delivered", null], ["webhook", "failed", "workspace_deleted"]]);
  assert.deepEqual(outbox[0].payload, { redacted: true }, "a queued email's text is not kept");
  // The other workspace was not touched at all.
  assert.equal((await poolA.query("SELECT count(*)::int AS n FROM test_jobs WHERE workspace_id = $1 AND status IN ('queued', 'running', 'assigned')", [keep.workspaceId])).rows[0].n, 2);
  assert.equal((await poolA.query("SELECT count(*)::int AS n FROM outbox WHERE workspace_id = $1 AND status = 'pending'", [keep.workspaceId])).rows[0].n, 2);

  // Nothing was removed yet: that waits for the end of the grace period.
  assert.deepEqual(await counts(poolA, target.workspaceId), before);
  const tombstone = await row(poolA, target.workspaceId);
  assert.equal(tombstone.deleted_by, "dev-admin"); assert.equal(tombstone.purged_at, null);
  const events = await auditActions(poolA, target.workspaceId);
  assert.equal(events.at(-1).action, "workspace.deleted"); assert.equal(events.at(-1).actor_subject, "dev-admin");
  assert.equal((await verifyChain(poolA, target.workspaceId)).first_bad_seq, null, "the audit chain stays intact");
});

test("a person can offboard a workspace only while it exists, and a deleted one frees the per-user workspace cap", { skip }, async () => {
  const owner = await as(capped, "capped-owner", { email: "owner@example.com" });
  const first = (await owner("/v1/workspaces", { method: "POST", body: { name: "one" } })).body.id;
  const second = (await owner("/v1/workspaces", { method: "POST", body: { name: "two" } })).body.id;
  const refused = await owner("/v1/workspaces", { method: "POST", body: { name: "three" } });
  assert.equal(refused.status, 403); assert.equal(refused.body.error, "workspace_limit_reached");
  assert.equal((await remove(owner, first, "one")).status, 200);
  assert.equal((await owner("/v1/workspaces", { method: "POST", body: { name: "three" } })).status, 201, "the slot comes back at once, not after the purge");
  assert.equal((await remove(owner, second, "two")).status, 200);
});

test("deleting while the workspace is being written to leaves nothing running behind", { skip }, async () => {
  const outcomes = {};
  for (let round = 0; round < 6; round += 1) {
    const name = `Busy ${round}`;
    const workspaceId = await newWorkspace(admin, name);
    const base = ws(workspaceId);
    const write = (index) => {
      if (index % 3 === 0) return admin(`${base}/test-jobs`, { method: "POST", body: { definition: sampleDefinition(), idempotencyKey: `busy-${index}` } });
      if (index % 3 === 1) return admin(`${base}/api-keys`, { method: "POST", body: { name: `key-${index}`, role: "viewer" } });
      return admin(`${base}/gateways`, { method: "POST", body: { name: `gw-${index}` } });
    };
    const responses = await Promise.all(Array.from({ length: 36 }, (_, index) => index === 18 ? remove(admin, workspaceId, name) : write(index)));
    assert.equal(responses[18].status, 200, "the deletion itself always succeeds");
    for (const response of responses) { outcomes[response.status] = (outcomes[response.status] ?? 0) + 1; assert.ok([200, 201, 403, 404].includes(response.status), `unexpected ${response.status} ${response.text}`); }
    // Every write either completed before the deletion and was stopped by it, or was refused afterwards: nothing is left alive.
    assert.equal((await poolA.query("SELECT count(*)::int AS n FROM test_jobs WHERE workspace_id = $1 AND status IN ('queued', 'assigned', 'running')", [workspaceId])).rows[0].n, 0, `round ${round}: a job was queued after the deletion`);
    assert.equal((await poolA.query("SELECT count(*)::int AS n FROM api_keys WHERE workspace_id = $1 AND revoked_at IS NULL", [workspaceId])).rows[0].n, 0, `round ${round}: an API key was issued after the deletion`);
    assert.equal((await poolA.query("SELECT count(*)::int AS n FROM gateways WHERE workspace_id = $1 AND revoked_at IS NULL", [workspaceId])).rows[0].n, 0, `round ${round}: a gateway was enrolled after the deletion`);
    const events = await auditActions(poolA, workspaceId);
    assert.equal(events.filter((event) => event.action === "workspace.deleted").length, 1);
    assert.equal(events.at(-1).action, "workspace.deleted", `round ${round}: something was recorded after the deletion`);
    assert.equal((await verifyChain(poolA, workspaceId)).first_bad_seq, null);
  }
  assert.ok((outcomes[201] ?? 0) > 0 && (outcomes[403] ?? 0) + (outcomes[404] ?? 0) > 0, `the race was not exercised: ${JSON.stringify(outcomes)}`);

  // Two people deleting at once: one wins, the other is told it is gone.
  const workspaceId = await newWorkspace(admin, "Twice");
  const both = await Promise.all([remove(admin, workspaceId, "Twice"), remove(admin, workspaceId, "Twice"), remove(admin, workspaceId, "Twice")]);
  assert.equal(both.filter((response) => response.status === 200).length, 1);
  assert.ok(both.every((response) => [200, 403, 404].includes(response.status)), JSON.stringify(both.map((response) => response.status)));
  assert.equal((await auditActions(poolA, workspaceId)).filter((event) => event.action === "workspace.deleted").length, 1);
});

test("the operator CLI shows and sets plans, lists workspaces, and every change is audited", { skip }, async () => {
  const workspaceId = await newWorkspace(admin, "Plan Target");
  assert.equal((await cli(dbA)).code, 2);
  assert.equal((await cli(dbA, "plan", "show", "not-a-uuid")).code, 2);
  assert.equal((await cli(dbA, "plan", "set", workspaceId, "platinum")).code, 2, "an unknown plan is refused before anything is touched");
  assert.equal((await cli(dbA, "workspace", "delete", workspaceId)).code, 2, "the CLI cannot delete; that is an administrator's decision in the API");
  const missing = await cli(dbA, "plan", "show", "00000000-0000-4000-8000-000000000000");
  assert.equal(missing.code, 1); assert.equal(missing.stderr, "workspace not found");

  const shown = JSON.parse((await cli(dbA, "plan", "show", workspaceId)).stdout);
  assert.equal(shown.plan, "enterprise"); assert.deepEqual(shown.limits, PLANS.enterprise); assert.equal(shown.usage.members, 1);

  const changed = await cli(dbA, "plan", "set", workspaceId, "free");
  assert.equal(changed.code, 0);
  assert.deepEqual(JSON.parse(changed.stdout), { id: workspaceId, plan: "free", previous: "enterprise", changed: true, limits: PLANS.free });
  const live = await admin(`${ws(workspaceId)}/usage`);
  assert.equal(live.body.plan, "free"); assert.deepEqual(live.body.limits, PLANS.free, "the new plan applies to the next request, on every instance");
  assert.deepEqual(JSON.parse((await cli(dbA, "plan", "set", workspaceId, "free")).stdout), { id: workspaceId, plan: "free", changed: false });
  const events = (await poolA.query("SELECT actor_subject, details FROM audit_events WHERE workspace_id = $1 AND action = 'workspace.plan_changed'", [workspaceId])).rows;
  assert.equal(events.length, 1, "a no-op is not an event");
  assert.match(events[0].actor_subject, /^operator:.+/); assert.deepEqual(events[0].details, { from: "enterprise", to: "free" });
  assert.equal((await verifyChain(poolA, workspaceId)).first_bad_seq, null);

  const listed = JSON.parse((await cli(dbA, "workspace", "list")).stdout);
  assert.ok(listed.some((item) => item.id === workspaceId && item.plan === "free" && item.deletedAt === null));
  await remove(admin, workspaceId, "Plan Target");
  const deleted = JSON.parse((await cli(dbA, "workspace", "list", "--deleted")).stdout);
  assert.ok(deleted.some((item) => item.id === workspaceId && item.deletedAt && item.purgeAfter));
  assert.ok(deleted.every((item) => item.deletedAt), "--deleted lists only offboarded workspaces");
  const upgraded = await cli(dbA, "plan", "set", workspaceId, "team");
  assert.equal(upgraded.code, 0, "a plan can be set while the workspace waits for its purge");
});

test("restore brings a workspace back inside the grace period, and never after it", { skip }, async () => {
  const target = await populate("Restore Me");
  const before = await counts(poolA, target.workspaceId);
  assert.equal((await cli(dbA, "workspace", "restore", target.workspaceId)).stderr, "workspace is not deleted");
  assert.equal((await remove(admin, target.workspaceId, "Restore Me")).status, 200);
  const restored = await cli(dbA, "workspace", "restore", target.workspaceId);
  assert.equal(restored.code, 0); assert.deepEqual(JSON.parse(restored.stdout), { id: target.workspaceId, name: "Restore Me", restored: true });

  assert.deepEqual(await counts(poolA, target.workspaceId), before, "nothing was lost");
  assert.equal((await admin(`${ws(target.workspaceId)}/usage`)).status, 200, "people are back in");
  const state = await row(poolA, target.workspaceId);
  assert.deepEqual([state.deleted_at, state.deleted_by, state.purge_after], [null, null, null]);
  // What the deletion revoked or cancelled stays that way: access is handed out again deliberately.
  assert.equal((await createClient(api.url, target.keyToken)(`${ws(target.workspaceId)}/usage`)).status, 401);
  assert.equal((await target.gateway("/gateway/v1/jobs/claim", { method: "POST" })).status, 401);
  assert.equal((await poolA.query("SELECT count(*)::int AS n FROM test_jobs WHERE workspace_id = $1 AND status = 'cancelled'", [target.workspaceId])).rows[0].n, 2);
  assert.equal((await poolA.query("SELECT count(*)::int AS n FROM webhooks WHERE workspace_id = $1 AND enabled", [target.workspaceId])).rows[0].n, 0, "webhooks come back disabled");
  assert.equal((await admin(`${ws(target.workspaceId)}/gateways`, { method: "POST", body: { name: "lab" } })).status, 201, "the name of the revoked gateway is free again");
  const events = await auditActions(poolA, target.workspaceId);
  const actions = events.map((event) => event.action);
  assert.equal(actions[actions.indexOf("workspace.deleted") + 1], "workspace.restored");
  assert.ok(events.some((event) => event.action === "workspace.restored" && /^operator:/.test(event.actor_subject)));
  assert.equal((await verifyChain(poolA, target.workspaceId)).first_bad_seq, null);
  assert.equal((await cli(dbA, "workspace", "restore", target.workspaceId)).stderr, "workspace is not deleted", "restoring twice is refused");

  // Past the deadline it is too late even though nothing has been removed yet: the purge may be about to start.
  assert.equal((await remove(admin, target.workspaceId, "Restore Me")).status, 200);
  await poolA.query("UPDATE workspaces SET purge_after = now() - interval '1 second' WHERE id = $1", [target.workspaceId]);
  const late = await cli(dbA, "workspace", "restore", target.workspaceId);
  assert.equal(late.code, 1); assert.equal(late.stderr, "the grace period is over; the content is being purged");
  assert.notEqual((await row(poolA, target.workspaceId)).deleted_at, null);
  assert.equal((await auditActions(poolA, target.workspaceId)).filter((event) => event.action === "workspace.restored").length, 1, "a refused restore leaves no trace");
  await poolA.query("UPDATE workspaces SET purged_at = now() WHERE id = $1", [target.workspaceId]);
  assert.equal((await cli(dbA, "workspace", "restore", target.workspaceId)).stderr, "workspace was purged; its content is gone");
  assert.equal((await cli(dbA, "plan", "set", target.workspaceId, "free")).stderr, "workspace was purged");
});

test("after the grace period the content is purged in slices; the tombstone and the audit trail stay", { skip }, async () => {
  const keepId = await newWorkspace(adminB, "Untouched");
  const targetId = await newWorkspace(adminB, "To Purge");
  for (const [workspaceId, jobs] of [[keepId, 30], [targetId, 2500]]) {
    await poolB.query("INSERT INTO test_suites (workspace_id, name, definition, created_by, updated_by) VALUES ($1, 'suite', '{}', 'dev-admin', 'dev-admin')", [workspaceId]);
    await poolB.query("INSERT INTO shared_profiles (workspace_id, name, definition, created_by, updated_by) VALUES ($1, 'profile', '{}', 'dev-admin', 'dev-admin')", [workspaceId]);
    await poolB.query("INSERT INTO test_jobs (workspace_id, requested_by, idempotency_key, definition, status, finished_at) SELECT $1, 'dev-admin', 'bulk-' || g, '{}', 'passed', now() FROM generate_series(1, $2) g", [workspaceId, jobs]);
    await poolB.query("INSERT INTO test_reports (workspace_id, summary, result, created_by) SELECT $1, '{}', '{}', 'dev-admin' FROM generate_series(1, 5)", [workspaceId]);
    await poolB.query("INSERT INTO webhooks (workspace_id, name, url, events, created_by) VALUES ($1, 'hook', 'https://example.com/h', '{job.finished}', 'dev-admin')", [workspaceId]);
    await poolB.query("INSERT INTO outbox (workspace_id, kind, event_type, payload, status, finished_at) SELECT $1, 'email', 'email.invitation', '{}', 'delivered', now() FROM generate_series(1, 1200)", [workspaceId]);
  }
  const keepBefore = await counts(poolB, keepId);
  const targetBefore = await counts(poolB, targetId);
  assert.equal(targetBefore.test_jobs, 2500); assert.equal(targetBefore.outbox, 1200);

  assert.equal((await remove(adminB, targetId, "To Purge")).status, 200);
  // An anchor, as the anchoring job writes it: it is part of the audit trail, so the purge must leave it alone.
  await poolB.query("INSERT INTO audit_anchors (workspace_id, seq, head_hash, event_at) SELECT workspace_id, chain_seq, row_hash, created_at FROM audit_events WHERE workspace_id = $1 ORDER BY chain_seq DESC LIMIT 1", [targetId]);
  const anchorBefore = (await poolB.query("SELECT seq, head_hash FROM audit_anchors WHERE workspace_id = $1", [targetId])).rows;
  assert.equal(anchorBefore.length, 1);
  await sleep(700); // seven purge intervals on each of two instances
  assert.deepEqual(await counts(poolB, targetId), targetBefore, "nothing is removed during the grace period");
  assert.equal((await row(poolB, targetId)).purged_at, null);

  await poolB.query("UPDATE workspaces SET purge_after = now() - interval '1 second' WHERE id = $1", [targetId]);
  await waitFor(async () => (await row(poolB, targetId)).purged_at !== null, { timeoutMs: 20_000, message: "workspace purged" });
  const empty = Object.fromEntries(OWNED.map((table) => [table, 0]));
  assert.deepEqual(await counts(poolB, targetId), empty);
  const tombstone = await row(poolB, targetId);
  assert.equal(tombstone.name, "purged workspace"); assert.equal(tombstone.deleted_by, "dev-admin"); assert.notEqual(tombstone.deleted_at, null);

  const events = await auditActions(poolB, targetId);
  assert.deepEqual(events.map((event) => event.action).filter((action) => action.startsWith("workspace.")), ["workspace.created", "workspace.deleted", "workspace.purged"]);
  assert.equal(events.at(-1).actor_subject, "system:purge");
  assert.equal((await verifyChain(poolB, targetId)).first_bad_seq, null, "the audit trail of a purged workspace still verifies");
  assert.deepEqual((await poolB.query("SELECT seq, head_hash FROM audit_anchors WHERE workspace_id = $1", [targetId])).rows, anchorBefore, "the audit anchors outlive the content too");
  assert.deepEqual(await counts(poolB, keepId), keepBefore, "another workspace was not touched");
  assert.equal((await row(poolB, keepId)).deleted_at, null);

  // Restart-safe and idempotent: a purged workspace is never picked up again.
  await sleep(500);
  assert.equal((await auditActions(poolB, targetId)).filter((event) => event.action === "workspace.purged").length, 1);
  const metrics = (await (await fetch(`${purgerOne.url}/metrics`)).text()) + (await (await fetch(`${purgerTwo.url}/metrics`)).text());
  const purged = metrics.split("\n").filter((line) => /workspaces_purged_total /.test(line) && !line.startsWith("#")).map((line) => Number(line.split(" ")[1]));
  assert.equal(purged.reduce((sum, value) => sum + value, 0), 1, "exactly one instance did the work");
});

test("two instances purging the same database never purge a workspace twice", { skip }, async () => {
  const ids = [];
  for (let index = 0; index < 8; index += 1) {
    const workspaceId = await newWorkspace(adminB, `Shared ${index}`);
    await poolB.query("INSERT INTO test_jobs (workspace_id, requested_by, idempotency_key, definition, status, finished_at) SELECT $1, 'dev-admin', 'k' || g, '{}', 'passed', now() FROM generate_series(1, 1500) g", [workspaceId]);
    ids.push([workspaceId, `Shared ${index}`]);
  }
  await Promise.all(ids.map(([workspaceId, name]) => remove(adminB, workspaceId, name)));
  await poolB.query("UPDATE workspaces SET purge_after = now() - interval '1 second' WHERE id = ANY($1)", [ids.map(([workspaceId]) => workspaceId)]);
  await waitFor(async () => (await poolB.query("SELECT count(*)::int AS n FROM workspaces WHERE id = ANY($1) AND purged_at IS NOT NULL", [ids.map(([workspaceId]) => workspaceId)])).rows[0].n === 8, { timeoutMs: 30_000, message: "all purged" });
  for (const [workspaceId] of ids) {
    assert.equal((await auditActions(poolB, workspaceId)).filter((event) => event.action === "workspace.purged").length, 1);
    assert.equal((await counts(poolB, workspaceId)).test_jobs, 0);
    assert.equal((await verifyChain(poolB, workspaceId)).first_bad_seq, null);
  }
});

test("a restore racing the purge deadline ends in exactly one state: whole or gone", { skip }, async () => {
  const rounds = 12;
  const outcomes = await Promise.all(Array.from({ length: rounds }, async (_, round) => {
    const workspaceId = await newWorkspace(adminB, `Race ${round}`);
    await poolB.query("INSERT INTO test_jobs (workspace_id, requested_by, idempotency_key, definition, status, finished_at) SELECT $1, 'dev-admin', 'r' || g, '{}', 'passed', now() FROM generate_series(1, 2200) g", [workspaceId]);
    await poolB.query("INSERT INTO test_suites (workspace_id, name, definition, created_by, updated_by) VALUES ($1, 'suite', '{}', 'dev-admin', 'dev-admin')", [workspaceId]);
    const whole = await counts(poolB, workspaceId);
    assert.equal((await remove(adminB, workspaceId, `Race ${round}`)).status, 200);
    // The deadline lands at a different moment in each round, around when the restore reaches the database.
    await poolB.query("UPDATE workspaces SET purge_after = now() + make_interval(secs => $2) WHERE id = $1", [workspaceId, 0.05 + (round * 0.03)]);
    const attempt = await cli(dbB, "workspace", "restore", workspaceId);
    await waitFor(async () => { const state = await row(poolB, workspaceId); return state.purged_at !== null || state.deleted_at === null; }, { timeoutMs: 20_000, message: `round ${round} settled` });
    await sleep(300);
    const state = await row(poolB, workspaceId);
    if (state.deleted_at === null) {
      assert.equal(attempt.code, 0, `round ${round}: restored but the CLI reported ${attempt.stderr}`);
      assert.equal(state.purged_at, null);
      assert.deepEqual(await counts(poolB, workspaceId), whole, `round ${round}: restored workspace lost content`);
      return "restored";
    }
    assert.equal(attempt.code, 1, `round ${round}: purged but the CLI reported success`);
    assert.notEqual(state.purged_at, null);
    assert.deepEqual(await counts(poolB, workspaceId), Object.fromEntries(OWNED.map((table) => [table, 0])), `round ${round}: purged workspace kept content`);
    assert.equal((await auditActions(poolB, workspaceId)).filter((event) => event.action === "workspace.restored").length, 0);
    return "purged";
  }));
  const tally = outcomes.reduce((all, outcome) => ({ ...all, [outcome]: (all[outcome] ?? 0) + 1 }), {});
  console.log(`# restore/purge race outcomes: ${JSON.stringify(tally)}`);
  assert.equal(outcomes.length, rounds);
});

test("stopping the purge worker waits for the slice that is running", async () => {
  let release; const gate = new Promise((resolve) => { release = resolve; });
  let sliceEnded = false; let stopped = false;
  const db = { query: async () => ({ rows: [{ id: "00000000-0000-4000-8000-000000000001" }] }), transaction: async () => { await gate; sliceEnded = true; return null; } };
  const purge = startPurge({ db, config: { saas: { purgeIntervalMs: 600_000 } }, log: { info() {}, error() {} }, metrics: { workspacesPurged: { inc() {} } } });
  const run = purge.runOnce();
  await sleep(50);
  const stopping = purge.stop().then(() => { stopped = true; });
  await sleep(100);
  assert.equal(stopped, false, "stop() resolved while a slice was still running: shutdown would close the pool under it");
  release();
  await stopping; await run;
  assert.equal(sliceEnded, true);
});
