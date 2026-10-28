// Webhook management over the real API and PostgreSQL: lifecycle, secrets, roles and isolation, plan quota, and destination rules.
// (Delivery behaviour is in api-outbox.test.mjs; the sender itself in webhook-send.test.mjs.)
import test from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { PLANS } from "../src/plans.mjs";
import { secretFor } from "../src/webhook-send.mjs";
import { DEV_TOKEN, createClient, createTestDatabase, skip, startApi, startIssuer, ws } from "./helpers.mjs";

const SIGNING_KEY = "webhook-api-test-signing-key-0123456789";
let database; let issuer; let api; let strict; let pool; let admin; let strictAdmin;
const as = async (sub, options = {}) => createClient(api.url, await issuer.sign({ sub, ...options }));

test.before(async () => {
  if (skip) return;
  database = await createTestDatabase();
  issuer = await startIssuer();
  // The outbox worker is parked on both instances: these tests look at configuration, not delivery.
  const common = { WEBHOOK_SIGNING_KEY: SIGNING_KEY, OUTBOX_INTERVAL_MS: "600000" };
  api = await startApi({ databaseUrl: database.url, issuer, env: { ...common, WEBHOOK_ALLOWED_CIDRS: "127.0.0.0/8,10.0.0.0/8,169.254.0.0/16" } });
  strict = await startApi({ databaseUrl: database.url, issuer, env: common });
  pool = new pg.Pool({ connectionString: database.url, max: 3 });
  admin = createClient(api.url, DEV_TOKEN);
  strictAdmin = createClient(strict.url, DEV_TOKEN);
});
test.after(async () => { await strict?.stop(); await api?.stop(); await pool?.end(); await issuer?.stop(); await database?.drop(); });

const newWorkspace = async (name, plan = "enterprise") => {
  const id = (await admin("/v1/workspaces", { method: "POST", body: { name } })).body.id;
  await pool.query("UPDATE workspaces SET plan = $2 WHERE id = $1", [id, plan]);
  return id;
};
const hooks = (workspaceId) => `${ws(workspaceId)}/webhooks`;
const createHook = async (workspaceId, body, client = admin) => { const response = await client(hooks(workspaceId), { method: "POST", body }); assert.equal(response.status, 201, response.text); return response.body; };
const addMember = (workspaceId, subject, role) => pool.query("INSERT INTO workspace_members (workspace_id, subject, email, role) VALUES ($1, $2, $3, $4)", [workspaceId, subject, `${subject}@example.com`, role]);
const tally = (responses) => responses.reduce((counts, response) => ({ ...counts, [response.status]: (counts[response.status] ?? 0) + 1 }), {});
const outboxCount = async (workspaceId) => (await pool.query("SELECT count(*)::int AS n FROM outbox WHERE workspace_id = $1", [workspaceId])).rows[0].n;

test("lifecycle: create, read, update, rotate and delete; the secret appears on create and rotate only and is derived, not stored", { skip }, async () => {
  const workspaceId = await newWorkspace("lifecycle");
  const token = "tok-9f8e7d6c5b4a39281706";
  const created = await createHook(workspaceId, { name: "Primary", url: `http://127.0.0.1:9/hook?token=${token}` });
  assert.match(created.secret, /^whsec_[A-Za-z0-9_-]{43}$/);
  assert.equal(created.secret, secretFor(SIGNING_KEY, created.id, 1), "the secret is HMAC(operator key, webhook id and version): nothing secret is in the database");
  assert.deepEqual([created.secretVersion, created.enabled, created.events, created.createdBy], [1, true, ["job.finished"], "dev-admin"]);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM webhooks WHERE to_jsonb(webhooks)::text LIKE '%whsec_%'")).rows[0].n, 0);

  const listed = await admin(hooks(workspaceId)); const one = await admin(`${hooks(workspaceId)}/${created.id}`);
  for (const response of [listed, one]) { assert.equal(response.status, 200); assert.ok(!response.text.includes(created.secret) && !response.text.includes("whsec_"), "reads never return the secret"); }
  assert.deepEqual(one.body, (({ secret, ...view }) => view)(created));

  // Names are unique per workspace, regardless of case.
  assert.equal((await admin(hooks(workspaceId), { method: "POST", body: { name: "primary", url: "https://127.0.0.1:9/x" } })).status, 409);

  const renamed = await admin(`${hooks(workspaceId)}/${created.id}`, { method: "PATCH", body: { name: "Renamed", url: "https://127.0.0.1:9/new", events: ["job.finished"], enabled: false } });
  assert.equal(renamed.status, 200); assert.deepEqual([renamed.body.name, renamed.body.url, renamed.body.enabled, renamed.body.secretVersion], ["Renamed", "https://127.0.0.1:9/new", false, 1]);
  assert.ok(new Date(renamed.body.updatedAt) >= new Date(created.updatedAt));
  assert.equal(renamed.body.secret, undefined);

  const rotated = await admin(`${hooks(workspaceId)}/${created.id}/rotate-secret`, { method: "POST" });
  assert.equal(rotated.status, 200); assert.equal(rotated.body.secretVersion, 2);
  assert.equal(rotated.body.secret, secretFor(SIGNING_KEY, created.id, 2)); assert.notEqual(rotated.body.secret, created.secret);
  assert.equal((await admin(`${hooks(workspaceId)}/${created.id}`)).body.secretVersion, 2);

  assert.equal((await admin(`${hooks(workspaceId)}/${created.id}`, { method: "DELETE" })).status, 204);
  for (const [method, suffix] of [["GET", ""], ["PATCH", ""], ["DELETE", ""], ["POST", "/rotate-secret"], ["POST", "/ping"], ["GET", "/deliveries"]]) {
    assert.equal((await admin(`${hooks(workspaceId)}/${created.id}${suffix}`, { method, body: method === "PATCH" ? { enabled: true } : undefined })).status, 404, `${method} ${suffix}`);
  }
  assert.deepEqual((await admin(hooks(workspaceId))).body, []);

  // The audit trail names what happened and the host, never the secret or the URL (which can carry a token).
  const audit = (await admin(`${ws(workspaceId)}/audit-events/export.ndjson`)).text;
  const actions = audit.trim().split("\n").map((line) => JSON.parse(line)).filter((event) => event.action.startsWith("webhook.")).map((event) => event.action);
  assert.deepEqual(actions, ["webhook.created", "webhook.updated", "webhook.secret_rotated", "webhook.deleted"]);
  for (const secret of [created.secret, rotated.body.secret, token, "/hook", "/new"]) { assert.ok(!audit.includes(secret), `audit trail does not contain ${secret}`); assert.ok(!api.logs().includes(secret), `log does not contain ${secret}`); }
  assert.ok(audit.includes('"host":"127.0.0.1:9"'));
  assert.equal((await admin(`${ws(workspaceId)}/audit/verify`)).body.valid, true);
});

test("input is validated: bad URLs, unknown events and fields, oversized values and empty updates are refused", { skip }, async () => {
  const workspaceId = await newWorkspace("validation");
  const post = (body) => admin(hooks(workspaceId), { method: "POST", body });
  const good = { name: "ok", url: "https://127.0.0.1:9/x" };
  for (const [label, body] of [
    ["not a URL", { ...good, url: "nope" }], ["relative URL", { ...good, url: "/hook" }], ["ftp", { ...good, url: "ftp://127.0.0.1/x" }], ["file", { ...good, url: "file:///etc/passwd" }],
    ["javascript", { ...good, url: "javascript:alert(1)" }], ["credentials", { ...good, url: "https://user:pw@127.0.0.1/x" }], ["no host", { ...good, url: "https://" }],
    ["empty url", { ...good, url: "" }], ["very long url", { ...good, url: `https://127.0.0.1/${"a".repeat(2100)}` }],
    ["unknown event", { ...good, events: ["job.exploded"] }], ["no events", { ...good, events: [] }], ["too many events", { ...good, events: Array.from({ length: 17 }, () => "job.finished") }],
    ["events not a list", { ...good, events: "job.finished" }], ["empty name", { ...good, name: "  " }], ["long name", { ...good, name: "n".repeat(121) }], ["missing name", { url: good.url }],
    ["extra field", { ...good, secret: "whsec_chosen" }], ["extra field enabled", { ...good, enabled: false }], ["empty body", {}]
  ]) {
    const response = await post(body);
    assert.equal(response.status, 400, `${label}: ${response.text}`);
  }
  assert.equal((await admin(hooks(workspaceId), { method: "POST", rawBody: "{not json" })).status, 400);
  assert.deepEqual((await admin(hooks(workspaceId))).body, [], "nothing was created by the refused requests");

  const created = await createHook(workspaceId, { ...good, events: ["job.finished", "job.finished"] });
  assert.deepEqual(created.events, ["job.finished"], "duplicate events collapse");
  const patch = (body) => admin(`${hooks(workspaceId)}/${created.id}`, { method: "PATCH", body });
  for (const body of [{}, { secretVersion: 9 }, { secret: "x" }, { id: created.id }, { url: "ftp://127.0.0.1/x" }, { events: [] }, { name: "" }, { enabled: "yes" }]) assert.equal((await patch(body)).status, 400, JSON.stringify(body));
  assert.deepEqual((await admin(`${hooks(workspaceId)}/${created.id}`)).body, (({ secret, ...view }) => view)(created), "refused updates changed nothing");
  assert.equal((await admin(`${hooks(workspaceId)}/not-a-uuid`)).body.error, "invalid_identifier");
  assert.equal((await admin(`${hooks(workspaceId)}/${created.id}/deliveries/not-a-uuid/redeliver`, { method: "POST" })).body.error, "invalid_identifier");
  assert.equal((await admin(`${hooks(workspaceId)}/${created.id}/deliveries?limit=0`)).status, 200, "limit is clamped, as elsewhere");
  assert.equal((await admin(`${hooks(workspaceId)}/${created.id}/deliveries?cursor=garbage`)).body.error, "invalid_cursor");
});

test("only administrators manage webhooks; other roles, API keys, outsiders and other workspaces are refused, and nothing leaks across workspaces", { skip }, async () => {
  const workspaceId = await newWorkspace("roles"); const otherId = await newWorkspace("roles-other");
  const hook = await createHook(workspaceId, { name: "mine", url: "https://127.0.0.1:9/mine" });
  const ping = (await admin(`${hooks(workspaceId)}/${hook.id}/ping`, { method: "POST" })).body.deliveryId;
  await pool.query("UPDATE outbox SET status = 'failed', attempts = 8, finished_at = now() WHERE id = $1", [ping]);

  const clients = { outsider: await as("outsider") };
  for (const role of ["viewer", "engineer", "maintainer"]) {
    await addMember(workspaceId, `member-${role}`, role);
    clients[`member ${role}`] = await as(`member-${role}`);
    const key = await admin(`${ws(workspaceId)}/api-keys`, { method: "POST", body: { name: `key-${role}`, role } });
    assert.equal(key.status, 201); clients[`api key ${role}`] = createClient(api.url, key.body.token);
  }
  const foreignKey = await admin(`${ws(otherId)}/api-keys`, { method: "POST", body: { name: "foreign", role: "maintainer" } });
  clients["api key of another workspace"] = createClient(api.url, foreignKey.body.token);

  const base = `${hooks(workspaceId)}/${hook.id}`;
  const calls = [
    ["GET", hooks(workspaceId)], ["POST", hooks(workspaceId), { name: "x", url: "https://127.0.0.1:9/x" }], ["GET", base], ["PATCH", base, { enabled: false }], ["DELETE", base],
    ["POST", `${base}/rotate-secret`], ["POST", `${base}/ping`], ["GET", `${base}/deliveries`], ["POST", `${base}/deliveries/${ping}/redeliver`]
  ];
  const before = { hook: (await admin(base)).body, outbox: await outboxCount(workspaceId) };
  for (const [who, client] of Object.entries(clients)) {
    for (const [method, path, body] of calls) {
      const response = await client(path, { method, body });
      assert.equal(response.status, 403, `${who}: ${method} ${path}`);
      assert.equal(response.body.error, "insufficient_workspace_role");
    }
  }
  assert.equal((await createClient(api.url)(hooks(workspaceId))).status, 401);
  assert.deepEqual({ hook: (await admin(base)).body, outbox: await outboxCount(workspaceId) }, before, "refused calls changed nothing");

  // The administrator of another workspace cannot reach this workspace's webhook through their own: ids are scoped.
  const foreign = `${hooks(otherId)}/${hook.id}`;
  for (const [method, suffix, body] of [["GET", "", undefined], ["PATCH", "", { enabled: false }], ["DELETE", "", undefined], ["POST", "/rotate-secret"], ["POST", "/ping"], ["GET", "/deliveries"], ["POST", `/deliveries/${ping}/redeliver`]]) {
    const response = await admin(`${foreign}${suffix}`, { method, body });
    assert.equal(response.status, 404, `${method} ${suffix}`);
  }
  assert.deepEqual({ hook: (await admin(base)).body, outbox: await outboxCount(workspaceId) }, before, "cross-workspace calls changed nothing");
  assert.equal((await pool.query("SELECT status FROM outbox WHERE id = $1", [ping])).rows[0].status, "failed", "and could not requeue another workspace's delivery");
  assert.deepEqual((await admin(hooks(otherId))).body, []);
  // Names are per workspace, so the same name in another workspace is fine.
  assert.equal((await admin(hooks(otherId), { method: "POST", body: { name: "mine", url: "https://127.0.0.1:9/mine" } })).status, 201);
});

test("plan quota: free allows one webhook, concurrent creates cannot exceed it, and deleting frees a slot", { skip }, async () => {
  assert.equal(PLANS.free.webhooks, 1);
  const workspaceId = await newWorkspace("quota", "free");
  const create = (index) => admin(hooks(workspaceId), { method: "POST", body: { name: `hook-${index}`, url: `https://127.0.0.1:9/${index}` } });
  const results = await Promise.all(Array.from({ length: 8 }, (_, index) => create(index)));
  assert.deepEqual(tally(results), { 201: 1, 403: 7 });
  const refused = results.find((response) => response.status === 403);
  assert.equal(refused.body.error, "plan_limit_reached"); assert.deepEqual(refused.body.details, { resource: "webhooks", plan: "free", limit: 1 });
  const usage = (await admin(`${ws(workspaceId)}/usage`)).body;
  assert.deepEqual([usage.limits.webhooks, usage.usage.webhooks], [1, 1]);
  const survivor = results.find((response) => response.status === 201).body;
  assert.equal((await admin(hooks(workspaceId))).body.length, 1);

  assert.equal((await admin(`${hooks(workspaceId)}/${survivor.id}`, { method: "DELETE" })).status, 204);
  assert.equal((await admin(`${ws(workspaceId)}/usage`)).body.usage.webhooks, 0);
  assert.equal((await create(100)).status, 201);

  // Bigger plans: the limit is the plan's, and enterprise has none.
  const team = await newWorkspace("quota-team", "team");
  const teamResults = []; for (let index = 0; index < PLANS.team.webhooks + 1; index += 1) teamResults.push((await admin(hooks(team), { method: "POST", body: { name: `t${index}`, url: `https://127.0.0.1:9/${index}` } })).status);
  assert.deepEqual(teamResults, [...Array(PLANS.team.webhooks).fill(201), 403]);
  const enterprise = await newWorkspace("quota-enterprise", "enterprise");
  for (let index = 0; index < PLANS.team.webhooks + 3; index += 1) assert.equal((await admin(hooks(enterprise), { method: "POST", body: { name: `e${index}`, url: `https://127.0.0.1:9/${index}` } })).status, 201);
});

test("destinations are screened when configured: private, loopback, link-local and metadata addresses are refused unless the operator allow-lists them", { skip }, async () => {
  const workspaceId = await newWorkspace("destinations");
  const attempt = (client, url) => client(hooks(workspaceId), { method: "POST", body: { name: `d-${Math.random().toString(36).slice(2)}`, url } });

  // This deployment has no allow-list: nothing private is reachable, and plain http is not offered at all for public hosts.
  for (const url of ["https://127.0.0.1/x", "https://[::1]/x", "https://10.0.0.5/x", "https://192.168.1.1/x", "https://172.16.0.1/x", "https://169.254.169.254/latest/meta-data", "https://100.64.0.1/x", "https://[fd00:ec2::254]/x", "https://[::ffff:7f00:1]/x", "https://[::ffff:169.254.169.254]/x", "https://0.0.0.0/x", "https://[fe80::1]/x", "http://127.0.0.1:8080/x"]) {
    const response = await attempt(strictAdmin, url);
    assert.equal(response.status, 400, url); assert.equal(response.body.error, "webhook_destination_not_allowed", url);
  }
  assert.equal((await attempt(strictAdmin, "http://93.184.216.34/hook")).body.error, "invalid_webhook_url", "plain http is for allow-listed networks only");
  assert.equal((await attempt(strictAdmin, "https://93.184.216.34/hook")).status, 201);
  // Host names cannot be judged now (they may resolve differently later); the delivery path judges them every time.
  assert.equal((await attempt(strictAdmin, "https://hooks.example.test/hook")).status, 201);

  // With an allow-list, allowed ranges work (and plain http to them); the never-allowed ranges still do not.
  assert.equal((await attempt(admin, "http://127.0.0.1:8080/x")).status, 201);
  assert.equal((await attempt(admin, "https://10.1.2.3/x")).status, 201);
  assert.equal((await attempt(admin, "https://192.168.1.1/x")).body.error, "webhook_destination_not_allowed", "outside the allow-list");
  assert.equal((await attempt(admin, "https://169.254.169.254/latest")).body.error, "webhook_destination_not_allowed", "metadata address even though 169.254.0.0/16 is allow-listed");

  // Editing cannot be used to slip a forbidden address in later.
  const hook = await createHook(workspaceId, { name: "edit-me", url: "https://93.184.216.34/ok" }, strictAdmin);
  const edit = (url) => strictAdmin(`${hooks(workspaceId)}/${hook.id}`, { method: "PATCH", body: { url } });
  for (const url of ["https://169.254.169.254/latest", "https://127.0.0.1/x", "http://93.184.216.34/hook"]) assert.equal((await edit(url)).status, 400, url);
  assert.equal((await strictAdmin(`${hooks(workspaceId)}/${hook.id}`)).body.url, "https://93.184.216.34/ok");
  assert.equal((await edit("https://93.184.216.35/ok")).status, 200);
});
