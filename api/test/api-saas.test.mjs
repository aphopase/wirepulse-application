import test from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { createSimulatedTransport } from "../../gateway/src/transports.mjs";
import { runSuite } from "../../gateway/src/engine.mjs";
import { PLANS } from "../src/plans.mjs";
import { DEV_TOKEN, createClient, createTestDatabase, sampleDefinition, skip, startApi, startIssuer, ws } from "./helpers.mjs";

let database; let issuer; let api; let capped; let pool; let admin;
const as = async (sub, options = {}) => createClient(api.url, await issuer.sign({ sub, ...options }));

test.before(async () => {
  if (skip) return;
  database = await createTestDatabase();
  issuer = await startIssuer();
  // Every workspace starts on the free plan, as it would on a SaaS deployment. `capped` is a second instance on the same database
  // that also limits how many workspaces one person may own.
  api = await startApi({ databaseUrl: database.url, issuer, env: { DEFAULT_PLAN: "free" } });
  capped = await startApi({ databaseUrl: database.url, issuer, env: { DEFAULT_PLAN: "free", MAX_WORKSPACES_PER_USER: "2" } });
  pool = new pg.Pool({ connectionString: database.url, max: 3 });
  admin = createClient(api.url, DEV_TOKEN);
});
test.after(async () => { await capped?.stop(); await api?.stop(); await pool?.end(); await issuer?.stop(); await database?.drop(); });

const newWorkspace = async (name) => (await admin("/v1/workspaces", { method: "POST", body: { name } })).body.id;
const usage = async (workspaceId) => (await admin(`${ws(workspaceId)}/usage`)).body;
const setUsage = (workspaceId, jobs, reports) => pool.query(
  `INSERT INTO workspace_usage (workspace_id, period, jobs_created, reports_created) VALUES ($1, date_trunc('month', now() AT TIME ZONE 'UTC')::date, $2, $3)
   ON CONFLICT (workspace_id, period) DO UPDATE SET jobs_created = EXCLUDED.jobs_created, reports_created = EXCLUDED.reports_created`, [workspaceId, jobs, reports]);
const queue = (workspaceId, key) => admin(`${ws(workspaceId)}/test-jobs`, { method: "POST", body: { definition: sampleDefinition(), idempotencyKey: key } });
const addMember = (workspaceId, subject, role = "viewer") => pool.query("INSERT INTO workspace_members (workspace_id, subject, email, role) VALUES ($1, $2, $3, $4)", [workspaceId, subject, `${subject}@example.com`, role]);
const tally = (responses) => responses.reduce((counts, response) => ({ ...counts, [response.status]: (counts[response.status] ?? 0) + 1 }), {});
const concurrently = (count, make) => Promise.all(Array.from({ length: count }, (_, index) => make(index)));
async function suiteResult() {
  const definition = sampleDefinition();
  return runSuite({ tests: definition.tests, profile: definition.profile, transport: createSimulatedTransport({ responder: () => ["READY"] }) });
}

test("a new workspace takes the default plan and /usage reports plan, limits and live counts", { skip }, async () => {
  const created = await admin("/v1/workspaces", { method: "POST", body: { name: "usage" } });
  assert.equal(created.status, 201); assert.equal(created.body.plan, "free");
  const workspaceId = created.body.id;
  assert.equal((await admin("/v1/workspaces")).body.find((item) => item.id === workspaceId).plan, "free");

  const empty = await admin(`${ws(workspaceId)}/usage`);
  assert.equal(empty.status, 200); assert.equal(empty.body.plan, "free"); assert.deepEqual(empty.body.limits, PLANS.free);
  assert.match(empty.body.usage.period, /^\d{4}-\d{2}-01$/);
  const { period, ...counts } = empty.body.usage;
  assert.deepEqual(counts, { members: 1, pendingInvitations: 0, gateways: 0, apiKeys: 0, webhooks: 0, queuedJobs: 0, jobsThisMonth: 0, reportsThisMonth: 0 });

  const key = (await admin(`${ws(workspaceId)}/api-keys`, { method: "POST", body: { name: "viewer", role: "viewer" } })).body;
  assert.equal((await admin(`${ws(workspaceId)}/gateways`, { method: "POST", body: { name: "lab" } })).status, 201);
  assert.equal((await queue(workspaceId, "u-1")).status, 201);
  const viewer = createClient(api.url, key.token);
  const seen = await viewer(`${ws(workspaceId)}/usage`);
  assert.equal(seen.status, 200, "any member role can read usage");
  assert.deepEqual({ ...seen.body.usage, period: undefined }, { period: undefined, members: 1, pendingInvitations: 0, gateways: 1, apiKeys: 1, webhooks: 0, queuedJobs: 1, jobsThisMonth: 1, reportsThisMonth: 0 });

  assert.equal((await createClient(api.url, null)(`${ws(workspaceId)}/usage`)).status, 401);
  const stranger = await as("not-a-member", { email: "x@example.com" });
  assert.equal((await stranger(`${ws(workspaceId)}/usage`)).status, 403, "usage is not visible outside the workspace");

  // A plan name this version does not know must not unlock anything: it is limited like the free plan.
  await pool.query("UPDATE workspaces SET plan = 'mystery' WHERE id = $1", [workspaceId]);
  const unknown = await admin(`${ws(workspaceId)}/usage`);
  assert.equal(unknown.body.plan, "mystery"); assert.deepEqual(unknown.body.limits, PLANS.free);
});

test("API keys and gateways are capped by plan, and concurrent requests cannot overshoot the cap", { skip }, async () => {
  const workspaceId = await newWorkspace("caps");
  const keys = await concurrently(6, (index) => admin(`${ws(workspaceId)}/api-keys`, { method: "POST", body: { name: `k${index}`, role: "viewer" } }));
  assert.deepEqual(tally(keys), { 201: PLANS.free.apiKeys, 403: 6 - PLANS.free.apiKeys });
  const refused = keys.find((response) => response.status === 403);
  assert.equal(refused.body.error, "plan_limit_reached");
  assert.deepEqual(refused.body.details, { resource: "api_keys", plan: "free", limit: PLANS.free.apiKeys });
  assert.equal((await usage(workspaceId)).usage.apiKeys, PLANS.free.apiKeys);
  const revoked = keys.find((response) => response.status === 201).body.id;
  assert.equal((await admin(`${ws(workspaceId)}/api-keys/${revoked}`, { method: "DELETE" })).status, 204);
  assert.equal((await admin(`${ws(workspaceId)}/api-keys`, { method: "POST", body: { name: "again", role: "viewer" } })).status, 201, "a revoked key frees its slot");

  const gateways = await concurrently(4, (index) => admin(`${ws(workspaceId)}/gateways`, { method: "POST", body: { name: `gw${index}` } }));
  assert.deepEqual(tally(gateways), { 201: PLANS.free.gateways, 403: 4 - PLANS.free.gateways });
  assert.deepEqual(gateways.find((response) => response.status === 403).body.details, { resource: "gateways", plan: "free", limit: PLANS.free.gateways });
  const kept = gateways.find((response) => response.status === 201).body;
  assert.equal((await admin(`${ws(workspaceId)}/gateways/${kept.id}`, { method: "DELETE" })).status, 204);
  assert.equal((await admin(`${ws(workspaceId)}/gateways`, { method: "POST", body: { name: "replacement" } })).status, 201, "a revoked gateway frees its slot");
});

test("members are capped by plan, counting pending invitations and re-checked when an invitation is accepted", { skip }, async () => {
  const workspaceId = await newWorkspace("members");
  const invite = (email) => admin(`${ws(workspaceId)}/invitations`, { method: "POST", body: { email, role: "viewer" } });
  // The administrator is member 1 of 3; two pending invitations reserve the other two seats.
  const first = await invite("a@example.com"); const second = await invite("b@example.com");
  assert.equal(first.status, 201); assert.equal(second.status, 201);
  const refused = await invite("c@example.com");
  assert.equal(refused.status, 403); assert.deepEqual(refused.body.details, { resource: "members", plan: "free", limit: PLANS.free.members });
  assert.equal((await admin(`${ws(workspaceId)}/invitations/${second.body.id}`, { method: "DELETE" })).status, 204);
  assert.equal((await invite("c@example.com")).status, 201, "revoking an invitation releases its seat");

  const alice = await as("alice", { email: "a@example.com" });
  assert.equal((await alice(`/v1/invitations/${first.body.id}/accept`, { method: "POST" })).status, 200);
  const afterAccept = (await usage(workspaceId)).usage;
  assert.equal(afterAccept.members, 2); assert.equal(afterAccept.pendingInvitations, 1);

  // Seats can fill up behind a pending invitation's back (a plan change, or members added directly); accepting must not exceed the limit.
  await addMember(workspaceId, "sneaked-in");
  const carol = await as("carol", { email: "c@example.com" });
  const blocked = await carol(`/v1/invitations/${(await admin(`${ws(workspaceId)}/invitations`)).body.find((item) => item.email === "c@example.com").id}/accept`, { method: "POST" });
  assert.equal(blocked.status, 403); assert.equal(blocked.body.error, "plan_limit_reached");
  assert.equal((await usage(workspaceId)).usage.members, 3, "the refused acceptance changed nothing");
  await pool.query("DELETE FROM workspace_members WHERE workspace_id = $1 AND subject = 'sneaked-in'", [workspaceId]);
  const retry = await carol(`/v1/invitations/${(await admin(`${ws(workspaceId)}/invitations`)).body.find((item) => item.email === "c@example.com").id}/accept`, { method: "POST" });
  assert.equal(retry.status, 200, "the invitation stays valid and works once there is room");
});

test("the queue is capped by plan and concurrent submissions cannot overshoot it", { skip }, async () => {
  const workspaceId = await newWorkspace("queue");
  const responses = await concurrently(PLANS.free.queuedJobs + 10, (index) => queue(workspaceId, `q-${index}`));
  assert.deepEqual(tally(responses), { 201: PLANS.free.queuedJobs, 429: 10 });
  assert.equal(responses.find((response) => response.status === 429).body.error, "queue_full");
  const now = (await usage(workspaceId)).usage;
  assert.equal(now.queuedJobs, PLANS.free.queuedJobs); assert.equal(now.jobsThisMonth, PLANS.free.queuedJobs, "refused submissions are not metered");
  const acceptedIndex = responses.findIndex((response) => response.status === 201); const accepted = responses[acceptedIndex].body;
  const replay = await queue(workspaceId, `q-${acceptedIndex}`);
  assert.equal(replay.status, 200, "a retried submission still returns the original job when the queue is full");
  assert.equal(replay.body.id, accepted.id);
  assert.equal((await usage(workspaceId)).usage.jobsThisMonth, PLANS.free.queuedJobs, "a replay is not metered twice");
});

test("monthly job and report quotas are metered atomically and reset with the month", { skip }, async () => {
  const workspaceId = await newWorkspace("monthly");
  await setUsage(workspaceId, PLANS.free.jobsPerMonth - 1, PLANS.free.reportsPerMonth - 1);
  const first = await queue(workspaceId, "m-1");
  assert.equal(first.status, 201);
  assert.equal((await queue(workspaceId, "m-1")).status, 200); assert.equal((await usage(workspaceId)).usage.jobsThisMonth, PLANS.free.jobsPerMonth, "a replay does not consume quota");
  const over = await queue(workspaceId, "m-2");
  assert.equal(over.status, 403); assert.equal(over.body.error, "plan_limit_reached");
  assert.deepEqual(over.body.details, { resource: "jobs_per_month", plan: "free", limit: PLANS.free.jobsPerMonth });
  assert.equal((await admin(`${ws(workspaceId)}/test-jobs/${first.body.id}/cancel`, { method: "POST" })).status, 200);
  assert.equal((await queue(workspaceId, "m-3")).status, 403, "cancelling does not hand quota back");

  const { results, evidence } = await suiteResult();
  const summary = { passed: 1, failed: 0, total: 1, evidenceSchema: evidence.schema, evidenceFinalHash: evidence.finalHash };
  const tampered = structuredClone(evidence); tampered.events[1].payload = { ...tampered.events[1].payload, forged: true };
  assert.equal((await admin(`${ws(workspaceId)}/test-reports`, { method: "POST", body: { summary, result: { results, evidence: tampered } } })).status, 422);
  assert.equal((await usage(workspaceId)).usage.reportsThisMonth, PLANS.free.reportsPerMonth - 1, "a rejected report is not metered");
  assert.equal((await admin(`${ws(workspaceId)}/test-reports`, { method: "POST", body: { summary, result: { results, evidence } } })).status, 201);
  const full = await admin(`${ws(workspaceId)}/test-reports`, { method: "POST", body: { summary, result: { results, evidence } } });
  assert.equal(full.status, 403); assert.deepEqual(full.body.details, { resource: "reports_per_month", plan: "free", limit: PLANS.free.reportsPerMonth });

  // Counters are per calendar month: last month's usage does not count against this month.
  await pool.query("UPDATE workspace_usage SET period = (period - interval '1 month')::date WHERE workspace_id = $1", [workspaceId]);
  const fresh = (await usage(workspaceId)).usage;
  assert.equal(fresh.jobsThisMonth, 0); assert.equal(fresh.reportsThisMonth, 0);
  assert.equal((await queue(workspaceId, "m-4")).status, 201);
});

test("concurrent submissions cannot overshoot the monthly job quota", { skip }, async () => {
  const workspaceId = await newWorkspace("monthly-race");
  await setUsage(workspaceId, PLANS.free.jobsPerMonth - 10, 0);
  const responses = await concurrently(25, (index) => queue(workspaceId, `race-${index}`));
  assert.deepEqual(tally(responses), { 201: 10, 403: 15 });
  assert.equal((await usage(workspaceId)).usage.jobsThisMonth, PLANS.free.jobsPerMonth);
});

test("jobs finished by a gateway are metered as reports in the same transaction", { skip }, async () => {
  const workspaceId = await newWorkspace("gateway-metering");
  const gatewayToken = (await admin(`${ws(workspaceId)}/gateways`, { method: "POST", body: { name: "lab" } })).body.token;
  const gateway = createClient(api.url, gatewayToken);
  const queued = (await queue(workspaceId, "g-1")).body;
  const claimed = (await gateway("/gateway/v1/jobs/claim", { method: "POST" })).body;
  assert.equal(claimed.id, queued.id);
  const { results, evidence } = await suiteResult();
  assert.equal((await gateway(`/gateway/v1/jobs/${claimed.id}/complete`, { method: "POST", body: { results, evidence } })).status, 200);
  const now = (await usage(workspaceId)).usage;
  assert.equal(now.jobsThisMonth, 1); assert.equal(now.reportsThisMonth, 1); assert.equal(now.queuedJobs, 0);
  assert.equal((await gateway(`/gateway/v1/jobs/${claimed.id}/complete`, { method: "POST", body: { results, evidence } })).status, 409);
  assert.equal((await usage(workspaceId)).usage.reportsThisMonth, 1, "a refused second completion is not metered");
  assert.equal((await admin(`${ws(workspaceId)}/audit/verify`)).body.valid, true, "metering does not disturb the audit chain");
});

test("one person can own only a limited number of workspaces, even when asking concurrently", { skip }, async () => {
  const builder = createClient(capped.url, await issuer.sign({ sub: "builder", email: "builder@example.com" }));
  const responses = await concurrently(6, (index) => builder("/v1/workspaces", { method: "POST", body: { name: `b${index}` } }));
  assert.deepEqual(tally(responses), { 201: 2, 403: 4 });
  const refused = responses.find((response) => response.status === 403);
  assert.equal(refused.body.error, "workspace_limit_reached"); assert.deepEqual(refused.body.details, { limit: 2 });
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM workspaces WHERE created_by = 'builder'")).rows[0].n, 2);

  const other = createClient(capped.url, await issuer.sign({ sub: "someone-else", email: "else@example.com" }));
  assert.equal((await other("/v1/workspaces", { method: "POST", body: { name: "unaffected" } })).status, 201, "the cap is per person");
  // Joining someone else's workspace is not owning one.
  const joined = (await other("/v1/workspaces")).body[0].id;
  await addMember(joined, "builder", "viewer");
  assert.equal((await builder("/v1/workspaces", { method: "POST", body: { name: "over" } })).status, 403);
  // A deleted workspace no longer counts toward the cap.
  const owned = (await pool.query("SELECT id FROM workspaces WHERE created_by = 'builder' LIMIT 1")).rows[0].id;
  await pool.query("UPDATE workspaces SET deleted_at = now(), deleted_by = 'builder' WHERE id = $1", [owned]);
  assert.equal((await builder("/v1/workspaces", { method: "POST", body: { name: "after-delete" } })).status, 201);
  assert.equal((await admin("/v1/workspaces", { method: "POST", body: { name: "uncapped" } })).status, 201, "an instance without the setting has no cap");
});

test("each workspace has its own request budget from its plan", { skip }, async () => {
  const busy = await newWorkspace("rate-busy"); const quiet = await newWorkspace("rate-quiet"); const unlimited = await newWorkspace("rate-unlimited");
  await pool.query("UPDATE workspaces SET plan = 'enterprise' WHERE id = $1", [unlimited]);
  const budget = PLANS.free.requestsPerMinute;
  const burst = await concurrently(budget + 20, () => admin(`${ws(busy)}/usage`));
  assert.deepEqual(tally(burst), { 200: budget, 429: 20 });
  const limited = burst.find((response) => response.status === 429);
  assert.equal(limited.body.error, "rate_limited"); assert.ok(Number(limited.headers.get("retry-after")) > 0, "tells the client when to retry");
  assert.equal((await admin(`${ws(quiet)}/usage`)).status, 200, "another tenant is not affected by a noisy one");
  assert.equal((await admin("/v1/workspaces")).status, 200, "account-level calls are not charged to a workspace");
  assert.deepEqual(tally(await concurrently(budget + 20, () => admin(`${ws(unlimited)}/usage`))), { 200: budget + 20 }, "an unlimited plan is not throttled");
  const bigger = await newWorkspace("rate-team");
  await pool.query("UPDATE workspaces SET plan = 'team' WHERE id = $1", [bigger]);
  assert.deepEqual(tally(await concurrently(budget + 20, () => admin(`${ws(bigger)}/usage`))), { 200: budget + 20 }, "a larger plan has a larger budget");
});
