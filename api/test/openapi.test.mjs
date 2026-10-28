// Keeps docs/openapi.yaml honest. The file must be valid OpenAPI, describe exactly the routes the server registers,
// say the same thing about roles as the server enforces, and every response the live server produces must be one the
// document promises (status, content type and body shape). A route, status or field that drifts fails here.
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import SwaggerParser from "@apidevtools/swagger-parser";
import Ajv from "ajv";
import { runSuite } from "../../gateway/src/engine.mjs";
import { createSimulatedTransport } from "../../gateway/src/transports.mjs";
import { createApp } from "../src/app.mjs";
import { loadConfig } from "../src/config.mjs";
import { createDatabase } from "../src/db.mjs";
import { createLogger } from "../src/log.mjs";
import { DEV_TOKEN, createClient, createTestDatabase, sampleDefinition, skip, startApi, startIssuer, ws } from "./helpers.mjs";

const SPEC_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "docs", "openapi.yaml");
const METHODS = ["get", "put", "post", "patch", "delete"];
const spec = await SwaggerParser.dereference(SPEC_PATH);

const escapeRegex = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const operations = Object.entries(spec.paths).flatMap(([template, item]) => METHODS.filter((method) => item[method]).map((method) => ({
  method: method.toUpperCase(), template, operation: item[method], parameters: [...(item.parameters ?? []), ...(item[method].parameters ?? [])],
  pattern: new RegExp(`^${template.split(/\{[^}]+\}/).map(escapeRegex).join("[^/]+")}$`), wildcards: (template.match(/\{/g) ?? []).length
})));
// "/test-jobs/stream" also matches "/test-jobs/{id}"; the template with fewer wildcards is the more specific one.
const findOperation = (method, pathname) => operations.filter((item) => item.method === method && item.pattern.test(pathname)).sort((a, b) => a.wildcards - b.wildcards)[0];
const label = (item) => `${item.method} ${item.template}`;

// OpenAPI 3.0 schemas are close to JSON Schema; the one gap that matters here is `nullable`.
function jsonSchema(node) {
  if (Array.isArray(node)) return node.map(jsonSchema);
  if (!node || typeof node !== "object") return node;
  const copy = {};
  for (const [key, value] of Object.entries(node)) if (!(key === "nullable" && typeof value === "boolean")) copy[key] = jsonSchema(value);
  return node.nullable === true ? { anyOf: [copy, { type: "null" }] } : copy;
}
const ajv = new Ajv({ strict: false, validateFormats: false, allErrors: true });
const validators = new Map();
const validatorFor = (schema) => { if (!validators.has(schema)) validators.set(schema, ajv.compile(jsonSchema(schema))); return validators.get(schema); };
const covered = new Set();

// Checks one real response against the document and records the operation as exercised.
function verify(method, requestPath, response) {
  const pathname = requestPath.split("?")[0];
  const item = findOperation(method, pathname);
  assert.ok(item, `${method} ${pathname} is not in the document`);
  covered.add(label(item));
  const documented = item.operation.responses[String(response.status)] ?? item.operation.responses.default;
  assert.ok(documented, `${label(item)} answered ${response.status}, which the document does not list: ${response.text.slice(0, 300)}`);
  if (!response.text) return;
  const mediaTypes = Object.keys(documented.content ?? {});
  const actual = (response.headers.get("content-type") ?? "").split(";")[0].trim();
  assert.ok(mediaTypes.includes(actual), `${label(item)} ${response.status}: content type ${actual} is not one of ${mediaTypes.join(", ") || "(none documented)"}`);
  const schema = documented.content[actual]?.schema;
  if (actual === "application/json" && schema) {
    const validate = validatorFor(schema);
    assert.ok(validate(response.body), `${label(item)} ${response.status} does not match its schema: ${JSON.stringify(validate.errors?.slice(0, 3))} in ${response.text.slice(0, 300)}`);
  }
}

test("openapi.yaml is a valid OpenAPI 3 document", async () => {
  const document = await SwaggerParser.validate(SPEC_PATH);
  assert.match(document.openapi, /^3\.0\./);
  assert.ok(operations.length > 40, `only ${operations.length} operations are documented`);
});

test("the document describes exactly the routes the server registers", async () => {
  const config = loadConfig({ DATABASE_URL: "postgres://wp:wp@127.0.0.1:1/wp", DEV_BEARER_TOKEN: DEV_TOKEN });
  const log = createLogger({ level: "silent", destination: { write() {} } });
  // The pool connects lazily, so building the app (without listening) needs no database.
  const db = createDatabase({ url: config.databaseUrl, poolSize: 1, ssl: config.db.ssl, statementTimeoutMs: 1000, idleTxTimeoutMs: 1000, connectTimeoutMs: 1000, log });
  try {
    const { app } = createApp({ config, db, log });
    const registered = new Set(app._router.stack.filter((layer) => layer.route).flatMap((layer) => Object.keys(layer.route.methods)
      .map((method) => `${method.toUpperCase()} ${layer.route.path.replace(/:(\w+)(\([^)]*\))?/g, "{$1}")}`)));
    const documented = new Set(operations.map(label));
    assert.deepEqual([...registered].filter((route) => !documented.has(route)).sort(), [], "registered by the server but missing from the document");
    assert.deepEqual([...documented].filter((route) => !registered.has(route)).sort(), [], "documented but not registered by the server");
    assert.ok(registered.size > 40, "route enumeration found too few routes");
  } finally { await db.close(); }
});

test("every operation is described completely and consistently", () => {
  const PROBES = new Set(["/healthz", "/readyz", "/metrics"]);
  const ROLES = ["viewer", "engineer", "maintainer", "administrator"];
  for (const item of operations) {
    const { operation, template } = item;
    assert.ok(operation.summary && operation.tags?.length, `${label(item)} needs a summary and a tag`);
    assert.deepEqual(item.parameters.filter((parameter) => parameter.in === "path").map((parameter) => parameter.name).sort(), [...template.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort(), `${label(item)} path parameters`);
    const statuses = Object.keys(operation.responses);
    assert.ok(statuses.some((status) => status.startsWith("2")), `${label(item)} has no success response`);
    if (PROBES.has(template)) continue;
    assert.ok(statuses.includes("401") && statuses.includes("429"), `${label(item)} must document 401 and 429`);
    if (template.startsWith("/gateway/v1/")) assert.deepEqual(operation.security, [{ gatewayAuth: [] }], `${label(item)} is a gateway operation`);
    else assert.ok(ROLES.includes(operation["x-required-role"]) || ["any member", "authenticated human"].includes(operation["x-required-role"]), `${label(item)} needs x-required-role`);
    if (template.includes("{workspaceId}")) assert.ok(ROLES.includes(operation["x-required-role"]) && statuses.includes("403"), `${label(item)} is workspace-scoped: a role and the 403 for callers outside it`);
    if (/\{(workspaceId|id)\}/.test(template)) assert.ok(statuses.includes("400"), `${label(item)} must document 400 (invalid_identifier)`);
  }
});

let database; let issuer; let api; let admin; let anonymous;
test.before(async () => {
  if (skip) return;
  database = await createTestDatabase();
  issuer = await startIssuer();
  // Webhooks are on (the outbox worker is parked: this file checks the API's shape, not delivery).
  api = await startApi({ databaseUrl: database.url, issuer, env: { WEBHOOK_SIGNING_KEY: "openapi-contract-signing-key-0123456789", WEBHOOK_ALLOWED_CIDRS: "127.0.0.0/8", OUTBOX_INTERVAL_MS: "600000" } });
  admin = createClient(api.url, DEV_TOKEN);
  anonymous = createClient(api.url);
});
test.after(async () => { await api?.stop(); await issuer?.stop(); await database?.drop(); });

const call = async (client, method, requestPath, options = {}) => {
  const response = await client(requestPath, { method, ...options });
  verify(method, requestPath, response);
  return response;
};
const expectStatus = async (promise, status) => { const response = await promise; assert.equal(response.status, status, response.text.slice(0, 300)); return response; };
const runLocally = (definition, answer = ["READY"]) => runSuite({ tests: definition.tests, profile: definition.profile, transport: createSimulatedTransport({ responder: () => answer }) });
const MISSING = "00000000-0000-4000-8000-000000000000";

test("workspaces, shared profiles and suites answer as documented", { skip }, async () => {
  await expectStatus(call(anonymous, "GET", "/healthz"), 200);
  await expectStatus(call(anonymous, "GET", "/readyz"), 200);
  await expectStatus(call(anonymous, "GET", "/metrics"), 200);
  await expectStatus(call(anonymous, "GET", "/v1/workspaces"), 401);

  const workspaceId = (await expectStatus(call(admin, "POST", "/v1/workspaces", { body: { name: "contract" } }), 201)).body.id;
  await expectStatus(call(admin, "POST", "/v1/workspaces", { body: {} }), 400);
  await expectStatus(call(admin, "GET", "/v1/workspaces"), 200);
  const base = ws(workspaceId);

  const definitions = { profiles: { settings: { baud: "115200" } }, "test-suites": { tests: sampleDefinition().tests } };
  for (const [kind, definition] of Object.entries(definitions)) {
    const collection = `${base}/${kind}`;
    const made = (await expectStatus(call(admin, "POST", collection, { body: { name: `${kind} one`, definition } }), 201)).body;
    const doomed = (await expectStatus(call(admin, "POST", collection, { body: { name: `${kind} two`, definition } }), 201)).body;
    await expectStatus(call(admin, "POST", collection, { body: { name: "" } }), 400);
    await expectStatus(call(admin, "GET", collection), 200);
    await expectStatus(call(admin, "GET", `${collection}/${made.id}`), 200);
    await expectStatus(call(admin, "GET", `${collection}/not-a-uuid`), 400);
    await expectStatus(call(admin, "GET", `${collection}/${MISSING}`), 404);
    await expectStatus(call(admin, "PUT", `${collection}/${made.id}`, { body: { name: "renamed", definition } }), 428);
    await expectStatus(call(admin, "PUT", `${collection}/${made.id}`, { body: { name: "renamed", definition }, headers: { "If-Match-Version": "7" } }), 409);
    const updated = (await expectStatus(call(admin, "PUT", `${collection}/${made.id}`, { body: { name: `${kind} one`, definition: { ...definition, note: "v2" } }, headers: { "If-Match-Version": String(made.version) } }), 200)).body;
    assert.equal(updated.version, made.version + 1);
    assert.equal((await expectStatus(call(admin, "GET", `${collection}/${made.id}/versions`), 200)).body.length, 2);
    await expectStatus(call(admin, "GET", `${collection}/${made.id}/versions/1`), 200);
    await expectStatus(call(admin, "GET", `${collection}/${made.id}/versions/99`), 404);
    await expectStatus(call(admin, "DELETE", `${collection}/${doomed.id}`), 204);
    await expectStatus(call(admin, "DELETE", `${collection}/${doomed.id}`), 404);
  }
});

test("members, invitations and API keys answer as documented", { skip }, async () => {
  const workspaceId = (await admin("/v1/workspaces", { method: "POST", body: { name: "people" } })).body.id;
  const base = ws(workspaceId);
  await expectStatus(call(admin, "GET", `${base}/members`), 200);

  const invited = (await expectStatus(call(admin, "POST", `${base}/invitations`, { body: { email: "peer@example.com", role: "viewer" } }), 201)).body;
  const doomed = (await expectStatus(call(admin, "POST", `${base}/invitations`, { body: { email: "gone@example.com", role: "viewer" } }), 201)).body;
  await expectStatus(call(admin, "POST", `${base}/invitations`, { body: { email: "peer@example.com", role: "viewer" } }), 409);
  await expectStatus(call(admin, "POST", `${base}/invitations`, { body: { email: "not-an-email", role: "viewer" } }), 400);
  assert.equal((await expectStatus(call(admin, "GET", `${base}/invitations`), 200)).body.length, 2);
  await expectStatus(call(admin, "DELETE", `${base}/invitations/${doomed.id}`), 204);
  await expectStatus(call(admin, "DELETE", `${base}/invitations/${doomed.id}`), 404);

  const peer = createClient(api.url, await issuer.sign({ sub: "peer", email: "peer@example.com" }));
  const unverified = createClient(api.url, await issuer.sign({ sub: "unverified", email: "peer@example.com", emailVerified: false }));
  await expectStatus(call(unverified, "GET", "/v1/invitations"), 403);
  assert.equal((await expectStatus(call(peer, "GET", "/v1/invitations"), 200)).body[0].workspaceId, workspaceId);
  await expectStatus(call(unverified, "POST", `/v1/invitations/${invited.id}/accept`), 403);
  assert.equal((await expectStatus(call(peer, "POST", `/v1/invitations/${invited.id}/accept`), 200)).body.role, "viewer");
  await expectStatus(call(peer, "POST", `/v1/invitations/${invited.id}/accept`), 404);

  await expectStatus(call(admin, "PUT", `${base}/members/peer`, { body: { role: "engineer" } }), 200);
  await expectStatus(call(admin, "PUT", `${base}/members/peer`, { body: { role: "emperor" } }), 400);
  await expectStatus(call(admin, "PUT", `${base}/members/ghost`, { body: { role: "viewer" } }), 404);
  await expectStatus(call(admin, "PUT", `${base}/members/dev-admin`, { body: { role: "viewer" } }), 409);
  await expectStatus(call(admin, "DELETE", `${base}/members/dev-admin`), 409);
  await expectStatus(call(admin, "DELETE", `${base}/members/peer`), 204);
  await expectStatus(call(admin, "DELETE", `${base}/members/peer`), 404);

  const key = (await expectStatus(call(admin, "POST", `${base}/api-keys`, { body: { name: "ci", role: "engineer" } }), 201)).body;
  assert.match(key.token, /^wpk_/);
  await expectStatus(call(admin, "POST", `${base}/api-keys`, { body: { name: "too-powerful", role: "administrator" } }), 400);
  await expectStatus(call(createClient(api.url, key.token), "POST", `${base}/api-keys`, { body: { name: "x", role: "viewer" } }), 403);
  assert.equal((await expectStatus(call(admin, "GET", `${base}/api-keys`), 200)).body.length, 1);
  await expectStatus(call(admin, "DELETE", `${base}/api-keys/${key.id}`), 204);
  await expectStatus(call(admin, "DELETE", `${base}/api-keys/${key.id}`), 404);
});

test("gateways, test jobs, the gateway protocol and reports answer as documented", { skip }, async () => {
  const workspaceId = (await admin("/v1/workspaces", { method: "POST", body: { name: "execution" } })).body.id;
  const base = ws(workspaceId);
  const suite = (await admin(`${base}/test-suites`, { method: "POST", body: { name: "suite", definition: { tests: sampleDefinition().tests } } })).body;
  const profile = (await admin(`${base}/profiles`, { method: "POST", body: { name: "profile", definition: { settings: { baud: "115200" } } } })).body;

  const registered = (await expectStatus(call(admin, "POST", `${base}/gateways`, { body: { name: "lab", labels: { bench: "1" }, expiresInDays: 30 } }), 201)).body;
  await expectStatus(call(admin, "POST", `${base}/gateways`, { body: { name: "" } }), 400);
  await expectStatus(call(admin, "GET", `${base}/gateways`), 200);
  await expectStatus(call(admin, "PATCH", `${base}/gateways/${registered.id}`, { body: { labels: { bench: "1", rig: "a" } } }), 200);
  await expectStatus(call(admin, "PATCH", `${base}/gateways/${MISSING}`, { body: { labels: {} } }), 404);
  const rotated = (await expectStatus(call(admin, "POST", `${base}/gateways/${registered.id}/rotate`), 200)).body;
  assert.notEqual(rotated.token, registered.token);
  const agent = createClient(api.url, rotated.token);
  await expectStatus(call(createClient(api.url, registered.token), "POST", "/gateway/v1/heartbeat", { body: {} }), 401);
  await expectStatus(call(agent, "POST", "/gateway/v1/heartbeat", { body: { agentVersion: "1.0.0", capabilities: { serialPorts: ["/dev/ttyTEST"] } } }), 200);
  await expectStatus(call(agent, "POST", "/gateway/v1/heartbeat", { body: { unexpected: true } }), 400);
  await expectStatus(call(agent, "POST", "/gateway/v1/jobs/claim"), 204);

  const request = { definition: sampleDefinition(), idempotencyKey: "contract-1", suiteId: suite.id, profileId: profile.id, priority: 1, requirements: { bench: "1" }, maxAttempts: 2 };
  const queued = (await expectStatus(call(admin, "POST", `${base}/test-jobs`, { body: request }), 201)).body;
  assert.equal((await expectStatus(call(admin, "POST", `${base}/test-jobs`, { body: request }), 200)).body.id, queued.id);
  await expectStatus(call(admin, "POST", `${base}/test-jobs`, { body: { ...request, definition: sampleDefinition({ profile: { settings: { baud: "9600" } } }) } }), 409);
  await expectStatus(call(admin, "POST", `${base}/test-jobs`, { body: {} }), 400);
  await expectStatus(call(admin, "POST", `${base}/test-jobs`, { body: { ...request, idempotencyKey: "contract-x", suiteId: MISSING } }), 404);
  assert.equal((await expectStatus(call(admin, "GET", `${base}/test-jobs?status=queued&limit=1`), 200)).body.length, 1);
  await expectStatus(call(admin, "GET", `${base}/test-jobs?status=sideways`), 400);
  await expectStatus(call(admin, "GET", `${base}/test-jobs/${queued.id}`), 200);

  const controller = new AbortController();
  const stream = await fetch(`${api.url}${base}/test-jobs/stream`, { headers: { authorization: `Bearer ${DEV_TOKEN}` }, signal: controller.signal });
  const opening = new TextDecoder().decode((await stream.body.getReader().read()).value);
  controller.abort();
  verify("GET", `${base}/test-jobs/stream`, { status: stream.status, body: null, headers: stream.headers, text: opening });
  assert.match(opening, /^event: ready/m);

  const claimed = (await expectStatus(call(agent, "POST", "/gateway/v1/jobs/claim"), 200)).body;
  assert.equal(claimed.id, queued.id);
  await expectStatus(call(agent, "POST", `/gateway/v1/jobs/${claimed.id}/start`), 200);
  await expectStatus(call(agent, "POST", `/gateway/v1/jobs/${claimed.id}/progress`, { body: { completed: 0, total: 1 } }), 200);
  await expectStatus(call(agent, "POST", `/gateway/v1/jobs/${claimed.id}/progress`, { body: { completed: 3, total: 1 } }), 400);
  await expectStatus(call(agent, "POST", "/gateway/v1/jobs/not-a-uuid/start"), 400);
  const run = await runLocally(claimed.definition);
  const tampered = structuredClone(run); tampered.evidence.events[0].payload.testCount = 99;
  await expectStatus(call(agent, "POST", `/gateway/v1/jobs/${claimed.id}/complete`, { body: tampered }), 422);
  await expectStatus(call(agent, "POST", `/gateway/v1/jobs/${claimed.id}/complete`, { body: {} }), 400);
  assert.equal((await expectStatus(call(agent, "POST", `/gateway/v1/jobs/${claimed.id}/complete`, { body: run }), 200)).body.status, "passed");
  await expectStatus(call(agent, "POST", `/gateway/v1/jobs/${claimed.id}/complete`, { body: run }), 409);
  const finished = (await expectStatus(call(admin, "GET", `${base}/test-jobs/${claimed.id}`), 200)).body;
  assert.ok(finished.result?.evidence && finished.definition);
  await expectStatus(call(admin, "GET", `${base}/test-jobs/${claimed.id}/junit.xml`), 200);
  await expectStatus(call(admin, "POST", `${base}/test-jobs/${claimed.id}/cancel`), 409);

  const second = (await expectStatus(call(admin, "POST", `${base}/test-jobs`, { body: { ...request, idempotencyKey: "contract-2" } }), 201)).body;
  assert.equal((await expectStatus(call(admin, "POST", `${base}/test-jobs/${second.id}/cancel`), 200)).body.status, "cancelled");
  await expectStatus(call(admin, "GET", `${base}/test-jobs/${second.id}/junit.xml`), 409);
  await expectStatus(call(agent, "POST", `/gateway/v1/jobs/${second.id}/start`), 409);
  await expectStatus(call(admin, "GET", `${base}/test-jobs/${MISSING}`), 404);

  const summary = { passed: 1, failed: 0, total: 1, evidenceSchema: run.evidence.schema, evidenceFinalHash: run.evidence.finalHash };
  const report = (await expectStatus(call(admin, "POST", `${base}/test-reports`, { body: { suiteId: suite.id, summary, result: run } }), 201)).body;
  assert.equal(report.evidenceVerification, "verified");
  await expectStatus(call(admin, "POST", `${base}/test-reports`, { body: { summary, result: tampered } }), 422);
  await expectStatus(call(admin, "POST", `${base}/test-reports`, { body: {} }), 400);
  assert.ok((await expectStatus(call(admin, "GET", `${base}/test-reports`), 200)).body.length >= 1);
  await expectStatus(call(admin, "GET", `${base}/test-reports/${report.id}`), 200);
  await expectStatus(call(admin, "GET", `${base}/test-reports/${report.id}/junit.xml`), 200);
  await expectStatus(call(admin, "GET", `${base}/test-reports/${MISSING}`), 404);

  await expectStatus(call(admin, "DELETE", `${base}/gateways/${registered.id}`), 204);
  await expectStatus(call(agent, "POST", "/gateway/v1/jobs/claim"), 401);
  await expectStatus(call(admin, "DELETE", `${base}/gateways/${registered.id}`), 404);
});

test("webhooks answer as documented", { skip }, async () => {
  const workspaceId = (await admin("/v1/workspaces", { method: "POST", body: { name: "hooks" } })).body.id;
  // The free plan allows one webhook; the plan decides how many, so move this workspace to a plan with room.
  await api.db.query("UPDATE workspaces SET plan = 'team' WHERE id = $1", [workspaceId]);
  const base = `${ws(workspaceId)}/webhooks`;
  const viewer = createClient(api.url, (await expectStatus(admin(`${ws(workspaceId)}/api-keys`, { method: "POST", body: { name: "reader", role: "viewer" } }), 201)).body.token);
  await expectStatus(call(viewer, "GET", base), 403);

  assert.deepEqual((await expectStatus(call(admin, "GET", base), 200)).body, []);
  const created = (await expectStatus(call(admin, "POST", base, { body: { name: "primary", url: "https://127.0.0.1:9/hook" } }), 201)).body;
  assert.match(created.secret, /^whsec_/); assert.deepEqual(created.events, ["job.finished"]);
  await expectStatus(call(admin, "POST", base, { body: { name: "primary", url: "https://127.0.0.1:9/other" } }), 409);
  await expectStatus(call(admin, "POST", base, { body: { name: "bad", url: "ftp://example.com/x" } }), 400);
  await expectStatus(call(admin, "POST", base, { body: { name: "bad", url: "https://169.254.169.254/latest" } }), 400);
  await expectStatus(call(admin, "POST", base, { body: { name: "bad", url: "https://u:p@127.0.0.1/x" } }), 400);
  await expectStatus(call(admin, "POST", base, { body: { name: "bad", url: "https://127.0.0.1/x", events: ["nope"] } }), 400);
  await expectStatus(call(admin, "POST", base, { body: {} }), 400);

  const one = (await expectStatus(call(admin, "GET", `${base}/${created.id}`), 200)).body;
  assert.equal(one.secret, undefined, "the secret is not part of the stored view");
  assert.equal((await expectStatus(call(admin, "GET", base), 200)).body.length, 1);
  await expectStatus(call(admin, "GET", `${base}/${MISSING}`), 404);
  await expectStatus(call(admin, "GET", `${base}/not-a-uuid`), 400);

  const patched = (await expectStatus(call(admin, "PATCH", `${base}/${created.id}`, { body: { enabled: false } }), 200)).body;
  assert.equal(patched.enabled, false);
  await expectStatus(call(admin, "PATCH", `${base}/${created.id}`, { body: {} }), 400);
  await expectStatus(call(admin, "PATCH", `${base}/${MISSING}`, { body: { enabled: true } }), 404);
  await expectStatus(call(admin, "PATCH", `${base}/${created.id}`, { body: { enabled: true } }), 200);
  const second = (await expectStatus(call(admin, "POST", base, { body: { name: "second", url: "https://127.0.0.1:9/two" } }), 201)).body;
  await expectStatus(call(admin, "PATCH", `${base}/${second.id}`, { body: { name: "primary" } }), 409);

  const rotated = (await expectStatus(call(admin, "POST", `${base}/${created.id}/rotate-secret`), 200)).body;
  assert.equal(rotated.secretVersion, 2); assert.notEqual(rotated.secret, created.secret);
  await expectStatus(call(admin, "POST", `${base}/${MISSING}/rotate-secret`), 404);

  const ping = (await expectStatus(call(admin, "POST", `${base}/${created.id}/ping`), 202)).body;
  await expectStatus(call(admin, "POST", `${base}/${created.id}/ping`), 202);
  await expectStatus(call(admin, "POST", `${base}/${MISSING}/ping`), 404);
  const page = await expectStatus(call(admin, "GET", `${base}/${created.id}/deliveries?limit=1`), 200);
  assert.equal(page.body.length, 1); assert.ok(page.headers.get("x-next-cursor"));
  const next = await expectStatus(call(admin, "GET", `${base}/${created.id}/deliveries?limit=1&cursor=${encodeURIComponent(page.headers.get("x-next-cursor"))}`), 200);
  assert.notEqual(next.body[0].id, page.body[0].id);
  assert.equal((await expectStatus(call(admin, "GET", `${base}/${created.id}/deliveries?status=pending`), 200)).body.length, 2);
  assert.deepEqual((await expectStatus(call(admin, "GET", `${base}/${created.id}/deliveries?status=failed`), 200)).body, []);
  await expectStatus(call(admin, "GET", `${base}/${created.id}/deliveries?status=bogus`), 400);
  await expectStatus(call(admin, "GET", `${base}/${MISSING}/deliveries`), 404);

  await expectStatus(call(admin, "POST", `${base}/${created.id}/deliveries/${ping.deliveryId}/redeliver`), 409);
  await expectStatus(call(admin, "POST", `${base}/${created.id}/deliveries/${MISSING}/redeliver`), 404);
  await api.db.query("UPDATE outbox SET status = 'failed', attempts = 3, last_error = 'timeout', finished_at = now() WHERE id = $1", [ping.deliveryId]);
  const failed = (await expectStatus(call(admin, "GET", `${base}/${created.id}/deliveries?status=failed`), 200)).body;
  assert.deepEqual([failed.length, failed[0].lastError, failed[0].attempts], [1, "timeout", 3]);
  assert.equal((await expectStatus(call(admin, "POST", `${base}/${created.id}/deliveries/${ping.deliveryId}/redeliver`), 202)).body.deliveryId, ping.deliveryId);

  await expectStatus(call(admin, "DELETE", `${base}/${second.id}`), 204);
  await expectStatus(call(admin, "DELETE", `${base}/${second.id}`), 404);
  await expectStatus(call(admin, "DELETE", `${base}/${created.id}`), 204);
});

test("webhooks say so when the deployment has no signing key", { skip }, async () => {
  const bare = await startApi({ databaseUrl: database.url, issuer });
  try {
    const client = createClient(bare.url, DEV_TOKEN);
    const workspaceId = (await client("/v1/workspaces", { method: "POST", body: { name: "bare" } })).body.id;
    const response = await client(`${ws(workspaceId)}/webhooks`);
    verify("GET", `${ws(workspaceId)}/webhooks`, response);
    assert.equal(response.status, 501); assert.equal(response.body.error, "webhooks_not_configured");
    // Callers who may not use the feature learn nothing about the deployment's configuration.
    const viewer = createClient(bare.url, (await client(`${ws(workspaceId)}/api-keys`, { method: "POST", body: { name: "reader", role: "viewer" } })).body.token);
    assert.equal((await viewer(`${ws(workspaceId)}/webhooks`)).status, 403);
  } finally { await bare.stop(); }
});

test("the audit trail answers as documented, and its export lines match the schema", { skip }, async () => {
  const workspaceId = (await admin("/v1/workspaces", { method: "POST", body: { name: "audit" } })).body.id;
  const base = ws(workspaceId);
  for (const name of ["one", "two", "three"]) await admin(`${base}/profiles`, { method: "POST", body: { name, definition: {} } });

  const first = await expectStatus(call(admin, "GET", `${base}/audit-events?limit=2`), 200);
  assert.equal(first.body.length, 2);
  const cursor = first.headers.get("x-next-cursor");
  assert.ok(cursor, "a full page advertises the next one");
  const next = await expectStatus(call(admin, "GET", `${base}/audit-events?limit=2&cursor=${cursor}`), 200);
  assert.ok(next.body.length >= 1 && Number(next.body[0].chain_seq) < Number(first.body[1].chain_seq));
  await expectStatus(call(admin, "GET", `${base}/audit-events?action=profile.created&from=2020-01-01T00:00:00Z`), 200);
  await expectStatus(call(admin, "GET", `${base}/audit-events?from=yesterday`), 400);
  await expectStatus(call(admin, "GET", `${base}/audit-events?cursor=garbage`), 400);

  const exported = await expectStatus(call(admin, "GET", `${base}/audit-events/export.ndjson`), 200);
  const lines = exported.text.trim().split("\n").map((line) => JSON.parse(line));
  assert.ok(lines.length >= 4);
  const validate = validatorFor(spec.components.schemas.AuditEvent);
  for (const line of lines) assert.ok(validate(line), `export line ${line.chain_seq}: ${JSON.stringify(validate.errors?.slice(0, 3))}`);
  assert.deepEqual(lines.map((line) => line.chain_seq), lines.map((_, index) => String(index + 1)), "the export is gap-free and in chain order (chain_seq is a decimal string on the wire)");
  await expectStatus(call(admin, "GET", `${base}/audit-events/export.ndjson?afterSeq=-1`), 400);

  const verification = (await expectStatus(call(admin, "GET", `${base}/audit/verify`), 200)).body;
  assert.equal(verification.valid, true); assert.equal(verification.complete, true); assert.equal(verification.lastSeq, lines.length);
  await expectStatus(call(admin, "GET", `${base}/audit/verify?fromSeq=abc`), 400);
});

test("the document's roles and workspace isolation match what the server enforces", { skip }, async () => {
  const workspaceId = (await admin("/v1/workspaces", { method: "POST", body: { name: "roles" } })).body.id;
  const clients = { administrator: admin };
  for (const role of ["viewer", "engineer", "maintainer"]) {
    const key = await expectStatus(admin(`${ws(workspaceId)}/api-keys`, { method: "POST", body: { name: role, role } }), 201);
    clients[role] = createClient(api.url, key.body.token);
  }
  const outsider = createClient(api.url, await issuer.sign({ sub: "outsider" }));
  const below = { engineer: "viewer", maintainer: "engineer", administrator: "maintainer" };

  let checked = 0;
  for (const item of operations.filter((candidate) => candidate.template.includes("{workspaceId}"))) {
    const role = item.operation["x-required-role"];
    const concrete = item.template.replace("{workspaceId}", workspaceId).replace("{id}", MISSING).replace("{deliveryId}", MISSING).replace("{version}", "1").replace("{subject}", "nobody");
    const send = (client) => call(client, item.method, concrete, { body: ["POST", "PUT", "PATCH"].includes(item.method) ? {} : undefined });
    const refused = await send(outsider);
    assert.equal(refused.status, 403, `${label(item)}: a non-member is refused`);
    assert.equal(refused.body.error, "insufficient_workspace_role");
    // The refusal is identical for a workspace that does not exist, so ids cannot be probed.
    const unknown = await call(outsider, item.method, concrete.replace(workspaceId, MISSING), { body: ["POST", "PUT", "PATCH"].includes(item.method) ? {} : undefined });
    assert.deepEqual([unknown.status, unknown.body.error], [refused.status, refused.body.error], `${label(item)}: unknown and foreign workspaces must be indistinguishable`);
    if (below[role]) assert.equal((await send(clients[below[role]])).status, 403, `${label(item)} requires ${role}, so ${below[role]} must be refused`);
    if (!concrete.endsWith("/stream")) {
      const allowed = await send(clients[role]);
      assert.ok(![401, 403].includes(allowed.status), `${label(item)} must admit ${role}, got ${allowed.status}`);
    }
    checked += 1;
  }
  assert.ok(checked >= 40, `only ${checked} workspace operations were checked`);
});

test("offboarding a workspace answers as documented", { skip }, async () => {
  const workspaceId = (await expectStatus(call(admin, "POST", "/v1/workspaces", { body: { name: "contract offboard" } }), 201)).body.id;
  await expectStatus(call(anonymous, "DELETE", `${ws(workspaceId)}?confirm=contract%20offboard`), 401);
  await expectStatus(call(admin, "DELETE", ws(workspaceId)), 400);
  assert.equal((await expectStatus(call(admin, "DELETE", `${ws(workspaceId)}?confirm=wrong`), 400)).body.error, "confirmation_mismatch");
  const done = await expectStatus(call(admin, "DELETE", `${ws(workspaceId)}?confirm=contract%20offboard`), 200);
  assert.equal(done.body.id, workspaceId);
  await expectStatus(call(admin, "DELETE", `${ws(workspaceId)}?confirm=contract%20offboard`), 403);
});

test("every documented operation was exercised against the live server", { skip }, () => {
  assert.deepEqual(operations.map(label).filter((key) => !covered.has(key)), []);
});
