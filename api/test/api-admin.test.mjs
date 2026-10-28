import test from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { createSimulatedTransport } from "../../gateway/src/transports.mjs";
import { runSuite } from "../../gateway/src/engine.mjs";
import { createMetrics } from "../src/metrics.mjs";
import { startRetention } from "../src/retention.mjs";
import { DEV_TOKEN, createClient, createTestDatabase, sampleDefinition, skip, startApi, startIssuer, ws } from "./helpers.mjs";

let database; let issuer; let api; let pool; let admin;
const as = async (sub, options = {}) => createClient(api.url, await issuer.sign({ sub, ...options }));
const newWorkspace = async (name) => (await admin("/v1/workspaces", { method: "POST", body: { name } })).body.id;
const verify = async (workspaceId) => (await admin(`${ws(workspaceId)}/audit/verify`)).body;
const addMember = (workspaceId, subject, role) => pool.query("INSERT INTO workspace_members (workspace_id, subject, email, role) VALUES ($1, $2, $3, $4)", [workspaceId, subject, `${subject}@example.com`, role]);

test.before(async () => {
  if (skip) return;
  database = await createTestDatabase();
  issuer = await startIssuer();
  api = await startApi({ databaseUrl: database.url, issuer });
  pool = new pg.Pool({ connectionString: database.url, max: 3 });
  admin = createClient(api.url, DEV_TOKEN);
});
test.after(async () => { await api?.stop(); await pool?.end(); await issuer?.stop(); await database?.drop(); });

test("API keys are workspace-scoped, role-limited, hashed at rest, and revocable", { skip }, async () => {
  const workspaceId = await newWorkspace("keys"); const otherId = await newWorkspace("keys-other");
  const created = await admin(`${ws(workspaceId)}/api-keys`, { method: "POST", body: { name: "ci", role: "engineer", expiresInDays: 30 } });
  assert.equal(created.status, 201);
  assert.match(created.body.token, /^wpk_[A-Za-z0-9_-]{40,}$/); assert.equal(created.body.prefix, created.body.token.slice(0, 12));
  const stored = await pool.query("SELECT token_hash FROM api_keys WHERE id = $1", [created.body.id]);
  assert.match(stored.rows[0].token_hash, /^[a-f0-9]{64}$/); assert.ok(!stored.rows[0].token_hash.includes(created.body.token));
  const listed = await admin(`${ws(workspaceId)}/api-keys`);
  assert.ok(!listed.text.includes(created.body.token)); assert.equal(listed.body[0].prefix, created.body.prefix);

  const ci = createClient(api.url, created.body.token);
  const mine = await ci("/v1/workspaces");
  assert.deepEqual(mine.body.map((item) => [item.id, item.role]), [[workspaceId, "engineer"]]);
  const queued = await ci(`${ws(workspaceId)}/test-jobs`, { method: "POST", body: { definition: sampleDefinition(), idempotencyKey: "ci-1" } });
  assert.equal(queued.status, 201); assert.equal(queued.body.requestedBy, `apikey:${created.body.id}`);
  assert.equal((await ci(`${ws(workspaceId)}/test-jobs/${queued.body.id}`)).status, 200);
  assert.equal((await ci(`${ws(otherId)}/test-jobs`)).status, 403, "scoped to its own workspace");
  assert.equal((await ci(`${ws(workspaceId)}/members`)).status, 403, "engineer keys cannot read members");
  assert.equal((await ci(`${ws(workspaceId)}/api-keys`)).status, 403);
  assert.equal((await ci(`${ws(workspaceId)}/api-keys`, { method: "POST", body: { name: "x", role: "viewer" } })).status, 403);
  assert.equal((await ci("/v1/workspaces", { method: "POST", body: { name: "from-a-key" } })).status, 403);
  assert.equal((await ci("/v1/invitations")).status, 403);
  const used = await pool.query("SELECT last_used_at FROM api_keys WHERE id = $1", [created.body.id]);
  assert.ok(used.rows[0].last_used_at, "last use is recorded");

  assert.equal((await admin(`${ws(workspaceId)}/api-keys`, { method: "POST", body: { name: "root", role: "administrator" } })).status, 400, "keys can never be administrators");
  assert.equal((await admin(`${ws(workspaceId)}/api-keys`, { method: "POST", body: { name: "forever", role: "viewer", expiresInDays: 100000 } })).status, 400);
  const defaulted = (await admin(`${ws(workspaceId)}/api-keys`, { method: "POST", body: { name: "default", role: "viewer" } })).body;
  assert.ok(new Date(defaulted.expiresAt) > new Date() && new Date(defaulted.expiresAt) < new Date(Date.now() + 91 * 86_400_000), "keys always expire");

  await pool.query("UPDATE api_keys SET expires_at = now() - interval '1 minute' WHERE id = $1", [defaulted.id]);
  assert.equal((await createClient(api.url, defaulted.token)("/v1/workspaces")).status, 401, "expired key");
  assert.equal((await admin(`${ws(workspaceId)}/api-keys/${created.body.id}`, { method: "DELETE" })).status, 204);
  assert.equal((await ci("/v1/workspaces")).status, 401, "revoked key");
  assert.equal((await admin(`${ws(workspaceId)}/api-keys/${created.body.id}`, { method: "DELETE" })).status, 404);
});

test("members: role changes are audited and the last administrator cannot be removed", { skip }, async () => {
  const workspaceId = await newWorkspace("members");
  await addMember(workspaceId, "pat", "viewer");
  const members = (await admin(`${ws(workspaceId)}/members`)).body;
  assert.deepEqual(members.map((item) => item.subject).sort(), ["dev-admin", "pat"]);
  assert.equal((await admin(`${ws(workspaceId)}/members/pat`, { method: "PUT", body: { role: "maintainer" } })).body.role, "maintainer");
  assert.equal((await admin(`${ws(workspaceId)}/members/pat`, { method: "PUT", body: { role: "root" } })).status, 400);
  assert.equal((await admin(`${ws(workspaceId)}/members/ghost`, { method: "PUT", body: { role: "viewer" } })).status, 404);
  assert.equal((await admin(`${ws(workspaceId)}/members/dev-admin`, { method: "PUT", body: { role: "viewer" } })).body.error, "last_administrator");
  assert.equal((await admin(`${ws(workspaceId)}/members/dev-admin`, { method: "DELETE" })).body.error, "last_administrator");
  assert.equal((await (await as("pat"))(`${ws(workspaceId)}/members/dev-admin`, { method: "DELETE" })).status, 403, "a maintainer cannot remove administrators");
  const changed = (await admin(`${ws(workspaceId)}/audit-events?action=member.role_changed`)).body;
  assert.equal(changed.length, 1); assert.equal(changed[0].actor_subject, "dev-admin"); assert.deepEqual(changed[0].details, { subject: "pat", role: "maintainer" });
  assert.equal((await admin(`${ws(workspaceId)}/members/pat`, { method: "DELETE" })).status, 204);
  assert.equal((await admin(`${ws(workspaceId)}/members/pat`, { method: "DELETE" })).status, 404);
});

test("two administrators cannot demote each other at the same time", { skip }, async () => {
  const workspaceId = await newWorkspace("admin-race");
  await addMember(workspaceId, "sam", "administrator");
  const sam = await as("sam");
  for (let round = 0; round < 3; round += 1) {
    const [a, b] = await Promise.all([
      admin(`${ws(workspaceId)}/members/sam`, { method: "PUT", body: { role: "viewer" } }),
      sam(`${ws(workspaceId)}/members/dev-admin`, { method: "PUT", body: { role: "viewer" } })
    ]);
    const administrators = (await pool.query("SELECT count(*)::int AS n FROM workspace_members WHERE workspace_id = $1 AND role = 'administrator'", [workspaceId])).rows[0].n;
    assert.ok(administrators >= 1, `round ${round}: statuses ${a.status}/${b.status}`);
    assert.ok([a.status, b.status].includes(409) || administrators === 1);
    await pool.query("UPDATE workspace_members SET role = 'administrator' WHERE workspace_id = $1", [workspaceId]);
  }
});

test("invitations are matched to a verified email and can be accepted once", { skip }, async () => {
  const workspaceId = await newWorkspace("invites");
  const invited = await admin(`${ws(workspaceId)}/invitations`, { method: "POST", body: { email: "Alice@Example.com", role: "engineer" } });
  assert.equal(invited.status, 201); assert.equal(invited.body.email, "alice@example.com");
  assert.equal((await admin(`${ws(workspaceId)}/invitations`, { method: "POST", body: { email: "alice@example.com", role: "viewer" } })).status, 409, "one pending invitation per email");
  assert.equal((await admin(`${ws(workspaceId)}/invitations`, { method: "POST", body: { email: "not-an-email", role: "viewer" } })).status, 400);
  assert.equal((await admin(`${ws(workspaceId)}/invitations`, { method: "POST", body: { email: "admin@wirepulse.local", role: "viewer" } })).body.error, "already_member");

  const alice = await as("alice-sub", { email: "alice@example.com" });
  const pending = await alice("/v1/invitations");
  assert.equal(pending.body.length, 1); assert.equal(pending.body[0].workspaceName, "invites"); assert.equal(pending.body[0].role, "engineer");
  // A different person, or the same email without verification, cannot use the invitation.
  assert.equal((await (await as("bob-sub", { email: "bob@example.com" }))(`/v1/invitations/${invited.body.id}/accept`, { method: "POST" })).status, 404);
  assert.equal((await (await as("mallory", { email: "alice@example.com", emailVerified: false }))(`/v1/invitations/${invited.body.id}/accept`, { method: "POST" })).status, 403);
  assert.equal((await alice(`${ws(workspaceId)}/test-suites`)).status, 403, "not a member yet");

  const accepted = await alice(`/v1/invitations/${invited.body.id}/accept`, { method: "POST" });
  assert.equal(accepted.status, 200); assert.deepEqual(accepted.body, { workspaceId, role: "engineer" });
  assert.equal((await alice(`${ws(workspaceId)}/test-suites`)).status, 200);
  assert.equal((await alice(`${ws(workspaceId)}/test-suites`, { method: "POST", body: { name: "mine", definition: {} } })).status, 201);
  assert.equal((await alice(`/v1/invitations/${invited.body.id}/accept`, { method: "POST" })).status, 404, "single use");
  assert.equal((await alice("/v1/invitations")).body.length, 0);

  const revoked = (await admin(`${ws(workspaceId)}/invitations`, { method: "POST", body: { email: "carol@example.com", role: "viewer" } })).body;
  assert.equal((await admin(`${ws(workspaceId)}/invitations/${revoked.id}`, { method: "DELETE" })).status, 204);
  assert.equal((await (await as("carol-sub", { email: "carol@example.com" }))(`/v1/invitations/${revoked.id}/accept`, { method: "POST" })).status, 404);
  const expired = (await admin(`${ws(workspaceId)}/invitations`, { method: "POST", body: { email: "dave@example.com", role: "viewer" } })).body;
  await pool.query("UPDATE workspace_invitations SET expires_at = now() - interval '1 minute' WHERE id = $1", [expired.id]);
  const dave = await as("dave-sub", { email: "dave@example.com" });
  assert.equal((await dave("/v1/invitations")).body.length, 0); assert.equal((await dave(`/v1/invitations/${expired.id}/accept`, { method: "POST" })).status, 404);
  const key = (await admin(`${ws(workspaceId)}/api-keys`, { method: "POST", body: { name: "k", role: "maintainer" } })).body;
  assert.equal((await createClient(api.url, key.token)(`${ws(workspaceId)}/invitations`)).status, 403, "keys cannot manage access");
});

test("test reports are stored only with verifiable evidence", { skip }, async () => {
  const workspaceId = await newWorkspace("reports"); const otherId = await newWorkspace("reports-other");
  const definition = sampleDefinition();
  const { results, evidence } = await runSuite({ tests: definition.tests, profile: definition.profile, transport: createSimulatedTransport({ responder: () => ["READY"] }) });
  const summary = { passed: 1, failed: 0, total: 1, evidenceSchema: evidence.schema, evidenceFinalHash: evidence.finalHash };
  const created = await admin(`${ws(workspaceId)}/test-reports`, { method: "POST", body: { summary, result: { results, evidence } } });
  assert.equal(created.status, 201); assert.equal(created.body.evidenceVerification, "verified");
  const tampered = structuredClone(evidence); tampered.events[1].payload = { ...tampered.events[1].payload, forged: true };
  const rejected = await admin(`${ws(workspaceId)}/test-reports`, { method: "POST", body: { summary, result: { results, evidence: tampered } } });
  assert.equal(rejected.status, 422); assert.equal(rejected.body.error, "evidence_verification_failed");
  assert.equal((await admin(`${ws(workspaceId)}/test-reports`)).body.length, 1);
  assert.equal((await admin(`${ws(workspaceId)}/test-reports/${created.body.id}`)).body.result.evidence.finalHash, evidence.finalHash);
  assert.match((await admin(`${ws(workspaceId)}/test-reports/${created.body.id}/junit.xml`)).text, /<testsuite /);
  assert.equal((await admin(`${ws(otherId)}/test-reports/${created.body.id}`)).status, 404, "reports do not cross workspaces");

  const foreign = (await admin(`${ws(otherId)}/test-suites`, { method: "POST", body: { name: "theirs", definition: {} } })).body;
  const own = (await admin(`${ws(workspaceId)}/test-suites`, { method: "POST", body: { name: "mine", definition: {} } })).body;
  const post = (suiteId) => admin(`${ws(workspaceId)}/test-reports`, { method: "POST", body: { suiteId, summary, result: { results, evidence } } });
  const refused = await post(foreign.id); const unknown = await post("00000000-0000-4000-8000-000000000000");
  assert.deepEqual([refused.status, refused.body.error], [404, "suite_not_found"]);
  assert.deepEqual([unknown.status, unknown.body.error], [404, "suite_not_found"], "a suite of another workspace is indistinguishable from an unknown one");
  assert.equal((await post(own.id)).status, 201);
});

test("multi-megabyte junk result and event arrays are refused quickly without exhausting memory", { skip }, async () => {
  const workspaceId = await newWorkspace("junk-arrays");
  // zod 3.x recorded one issue per invalid element (GHSA-mrhx-c7xc-m3w5): ~4M elements took ~2 GB of heap and ~11 s.
  // zod 4 enforces an array's .max() before it visits the elements, so every evidence array must carry one.
  const junk = "0,".repeat(3_900_000);
  for (const body of [`{"summary":{},"result":{"results":[${junk}0],"evidence":{}}}`, `{"summary":{},"result":{"results":[],"evidence":{"events":[${junk}0]}}}`]) {
    const started = Date.now();
    const refused = await admin(`${ws(workspaceId)}/test-reports`, { method: "POST", rawBody: body });
    assert.equal(refused.status, 400); assert.equal(refused.body.error, "invalid_request");
    assert.ok(Date.now() - started < 3000, `refusal took ${Date.now() - started} ms`);
  }
  assert.equal((await admin(`${ws(workspaceId)}/test-reports`)).body.length, 0);
});

test("the audit log is hash-chained, append-only, and verifiable", { skip }, async () => {
  const workspaceId = await newWorkspace("audit");
  await admin(`${ws(workspaceId)}/test-suites`, { method: "POST", body: { name: "a", definition: {} } });
  await admin(`${ws(workspaceId)}/gateways`, { method: "POST", body: { name: "g" } });
  await addMember(workspaceId, "pat", "viewer");
  await admin(`${ws(workspaceId)}/members/pat`, { method: "PUT", body: { role: "engineer" } });
  const events = (await admin(`${ws(workspaceId)}/audit-events?limit=100`)).body;
  assert.deepEqual(events.map((item) => item.action).reverse(), ["workspace.created", "test_suite.created", "gateway.registered", "member.role_changed"]);
  assert.deepEqual(events.map((item) => item.chain_seq).reverse(), ["1", "2", "3", "4"]);
  assert.ok(events.every((item) => item.request_id && item.actor_subject === "dev-admin" && /^[a-f0-9]{64}$/.test(item.row_hash)));
  for (let index = 1; index < events.length; index += 1) assert.equal(events[index - 1].prev_hash, events[index].row_hash, "each row links to the previous one");

  const intact = await verify(workspaceId);
  assert.equal(intact.valid, true); assert.equal(intact.checked, 4); assert.equal(intact.complete, true); assert.equal(intact.headHash, events[0].row_hash);

  const exported = await admin(`${ws(workspaceId)}/audit-events/export.ndjson`);
  assert.equal(exported.status, 200); assert.match(exported.headers.get("content-type"), /ndjson/);
  const lines = exported.text.trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(lines.length, 4); assert.equal(lines.at(-1).row_hash, intact.headHash);
  assert.equal((await admin(`${ws(workspaceId)}/audit-events/export.ndjson?afterSeq=2`)).text.trim().split("\n").length, 2);
  assert.equal((await (await as("viewer-x"))(`${ws(workspaceId)}/audit-events`)).status, 403);

  // The application cannot rewrite history.
  await assert.rejects(pool.query("UPDATE audit_events SET actor_subject = 'x' WHERE workspace_id = $1", [workspaceId]), /append-only/);
  await assert.rejects(pool.query("DELETE FROM audit_events WHERE workspace_id = $1", [workspaceId]), /append-only/);
  await assert.rejects(pool.query("TRUNCATE audit_events"), /append-only/);

  // Someone with DDL rights who bypasses the guard is still caught by verification.
  const tamper = new pg.Client({ connectionString: database.url }); await tamper.connect();
  try {
    const original = (await tamper.query("SELECT details FROM audit_events WHERE workspace_id = $1 AND chain_seq = 2", [workspaceId])).rows[0].details;
    await tamper.query("ALTER TABLE audit_events DISABLE TRIGGER audit_events_append_only");
    await tamper.query("UPDATE audit_events SET details = '{\"name\":\"forged\"}' WHERE workspace_id = $1 AND chain_seq = 2", [workspaceId]);
    await tamper.query("ALTER TABLE audit_events ENABLE TRIGGER audit_events_append_only");
    const broken = await verify(workspaceId);
    assert.equal(broken.valid, false); assert.equal(broken.firstBadSeq, 2);
    assert.ok(api.logEntries().some((entry) => entry.event === "audit.chain_broken" && entry.workspaceId === workspaceId));
    await tamper.query("ALTER TABLE audit_events DISABLE TRIGGER audit_events_append_only");
    await tamper.query("UPDATE audit_events SET details = $2 WHERE workspace_id = $1 AND chain_seq = 2", [workspaceId, original]);
    await tamper.query("ALTER TABLE audit_events ENABLE TRIGGER audit_events_append_only");
    assert.equal((await verify(workspaceId)).valid, true, "restoring the original row restores the chain");

    // Removing a row from the middle is detected as a gap.
    await tamper.query("BEGIN; SET LOCAL wirepulse.retention = 'on'");
    await tamper.query("DELETE FROM audit_events WHERE workspace_id = $1 AND chain_seq = 3", [workspaceId]);
    await tamper.query("COMMIT");
    const gap = await verify(workspaceId);
    assert.equal(gap.valid, false); assert.equal(gap.firstBadSeq, 4);
  } finally { await tamper.query("ALTER TABLE audit_events ENABLE TRIGGER audit_events_append_only").catch(() => {}); await tamper.end(); }
});

test("concurrent writers keep one unbroken audit chain", { skip }, async () => {
  const workspaceId = await newWorkspace("audit-concurrency");
  const results = await Promise.all(Array.from({ length: 30 }, (_, index) => admin(`${ws(workspaceId)}/test-suites`, { method: "POST", body: { name: `s${index}`, definition: {} } })));
  assert.ok(results.every((response) => response.status === 201));
  const state = await verify(workspaceId);
  assert.equal(state.valid, true); assert.equal(state.checked, 31);
  const seqs = (await pool.query("SELECT chain_seq FROM audit_events WHERE workspace_id = $1 ORDER BY chain_seq", [workspaceId])).rows.map((row) => Number(row.chain_seq));
  assert.deepEqual(seqs, Array.from({ length: 31 }, (_, index) => index + 1));
});

test("retention removes expired data only, keeps active jobs, and leaves a verifiable audit chain", { skip }, async () => {
  const workspace = (await pool.query("INSERT INTO workspaces (name, created_by) VALUES ('retention', 'dev-admin') RETURNING id")).rows[0].id;
  await pool.query("INSERT INTO workspace_members (workspace_id, subject, email, role) VALUES ($1, 'dev-admin', 'admin@wirepulse.local', 'administrator')", [workspace]);
  const oldAudit = (action) => pool.query("INSERT INTO audit_events (workspace_id, actor_subject, action, resource_type, request_id, created_at) VALUES ($1, 'old', $2, 'test', 'old', now() - interval '400 days')", [workspace, action]);
  for (const action of ["old.1", "old.2", "old.3"]) await oldAudit(action);
  const queue = async (key) => (await admin(`${ws(workspace)}/test-jobs`, { method: "POST", body: { definition: sampleDefinition(), idempotencyKey: key } })).body;
  const expired = await queue("expired"); const stillQueued = await queue("queued"); const recent = await queue("recent"); const running = await queue("running");
  await admin(`${ws(workspace)}/test-jobs/${expired.id}/cancel`, { method: "POST" });
  await admin(`${ws(workspace)}/test-jobs/${recent.id}/cancel`, { method: "POST" });
  const gateway = (await admin(`${ws(workspace)}/gateways`, { method: "POST", body: { name: "g" } })).body;
  await pool.query("UPDATE test_jobs SET status = 'running', gateway_id = $2, lease_expires_at = now() + interval '1 hour', created_at = now() - interval '400 days' WHERE id = $1", [running.id, gateway.id]);
  await pool.query("UPDATE test_jobs SET finished_at = now() - interval '400 days' WHERE id = $1", [expired.id]);
  await pool.query("UPDATE test_jobs SET created_at = now() - interval '400 days' WHERE id = $1", [stillQueued.id]);
  const report = (await pool.query("INSERT INTO test_reports (workspace_id, summary, result, created_by, created_at) VALUES ($1, '{}', '{}', 'x', now() - interval '400 days'), ($1, '{}', '{}', 'x', now()) RETURNING id", [workspace])).rows;
  // An out-of-order old row after newer ones is kept, so the chain never gets a hole.
  await oldAudit("old.late");

  const retention = startRetention({ db: api.db, config: { retention: { jobsDays: 30, reportsDays: 30, auditDays: 30, intervalHours: 24 } }, log: api.log, metrics: createMetrics({ db: api.db }) });
  try { await retention.runOnce(); } finally { retention.stop(); }

  const ids = (await pool.query("SELECT id FROM test_jobs WHERE workspace_id = $1", [workspace])).rows.map((row) => row.id).sort();
  assert.deepEqual(ids, [recent.id, running.id, stillQueued.id].sort(), "only the finished, expired job is deleted");
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM test_reports WHERE workspace_id = $1", [workspace])).rows[0].n, 1);
  const actions = (await pool.query("SELECT action FROM audit_events WHERE workspace_id = $1 ORDER BY chain_seq", [workspace])).rows.map((row) => row.action);
  assert.ok(!actions.includes("old.1") && !actions.includes("old.2") && !actions.includes("old.3"), "expired prefix removed");
  assert.ok(actions.includes("old.late"), "non-contiguous old row kept");
  assert.ok(actions.filter((action) => action === "retention.purged").length >= 3, "each purge is itself audited");
  assert.equal(report.length, 2);
  const state = await verify(workspace);
  assert.equal(state.valid, true, "chain still verifies after the prefix was purged");
});

test("profile and suite lists leave out the definitions; the item itself still has it", { skip }, async () => {
  const workspaceId = await newWorkspace("list-size");
  const big = { notes: "x".repeat(100_000) };
  for (const path of ["profiles", "test-suites"]) {
    const created = await admin(`${ws(workspaceId)}/${path}`, { method: "POST", body: { name: "big", definition: big } });
    assert.equal(created.status, 201);
    const list = await admin(`${ws(workspaceId)}/${path}`);
    assert.equal(list.status, 200);
    assert.ok(list.text.length < 1000, "a list does not carry the 100 kB definition");
    assert.deepEqual(Object.keys(list.body[0]).sort(), ["createdAt", "id", "name", "updatedAt", "updatedBy", "version"]);
    const item = await admin(`${ws(workspaceId)}/${path}/${created.body.id}`);
    assert.deepEqual(item.body.definition, big);
  }
});
