import test from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { DEV_TOKEN, MIGRATION_NAMES, createClient, createTestDatabase, skip, startApi, startIssuer, ws } from "./helpers.mjs";

let database; let issuer; let api; let pool; let admin; let workspaceId; let otherWorkspaceId;
const as = async (sub, options = {}) => createClient(api.url, await issuer.sign({ sub, ...options }));
const member = (workspace, subject, role) => pool.query("INSERT INTO workspace_members (workspace_id, subject, email, role) VALUES ($1, $2, $3, $4)", [workspace, subject, `${subject}@example.com`, role]);

test.before(async () => {
  if (skip) return;
  database = await createTestDatabase();
  issuer = await startIssuer();
  api = await startApi({ databaseUrl: database.url, issuer });
  pool = new pg.Pool({ connectionString: database.url, max: 3 });
  admin = createClient(api.url, DEV_TOKEN);
  workspaceId = (await admin("/v1/workspaces", { method: "POST", body: { name: "core" } })).body.id;
  otherWorkspaceId = (await admin("/v1/workspaces", { method: "POST", body: { name: "other" } })).body.id;
  await member(workspaceId, "viewer-1", "viewer");
  await member(workspaceId, "engineer-1", "engineer");
  await member(workspaceId, "maintainer-1", "maintainer");
});
test.after(async () => { await api?.stop(); await pool?.end(); await issuer?.stop(); await database?.drop(); });

test("schema is migrated and every migration is recorded with a checksum", { skip }, async () => {
  const applied = await pool.query("SELECT name, checksum FROM schema_migrations ORDER BY name");
  assert.deepEqual(applied.rows.map((row) => row.name), MIGRATION_NAMES);
  for (const row of applied.rows) assert.match(row.checksum, /^[a-f0-9]{64}$/);
});

test("liveness needs no database; readiness reports the database", { skip }, async () => {
  const anonymous = createClient(api.url);
  assert.deepEqual((await anonymous("/healthz")).body, { status: "ok" });
  const ready = await anonymous("/readyz");
  assert.equal(ready.status, 200);
  assert.deepEqual(ready.body, { status: "ready", checks: { database: "ok" } });
});

test("responses carry hardening headers; request ids are echoed only when well formed", { skip }, async () => {
  const good = await admin("/v1/workspaces", { headers: { "x-request-id": "trace-abc-12345" } });
  assert.equal(good.headers.get("x-request-id"), "trace-abc-12345");
  assert.match(good.headers.get("content-security-policy"), /default-src 'none'/);
  assert.match(good.headers.get("content-security-policy"), /frame-ancestors 'none'/);
  assert.equal(good.headers.get("cache-control"), "no-store");
  assert.equal(good.headers.get("x-powered-by"), null);
  assert.equal(good.headers.get("x-content-type-options"), "nosniff");
  const bad = await admin("/v1/workspaces", { headers: { "x-request-id": "bad id with spaces\tand tabs" } });
  assert.match(bad.headers.get("x-request-id"), /^[0-9a-f-]{36}$/);
});

test("errors are structured JSON with a request id and no internals", { skip }, async () => {
  const notFound = await admin("/v1/nothing-here");
  assert.equal(notFound.status, 404);
  assert.equal(notFound.body.error, "not_found");
  assert.ok(notFound.body.requestId);
  const badId = await admin(`${ws("not-a-uuid")}/test-suites`);
  assert.equal(badId.status, 400); assert.equal(badId.body.error, "invalid_identifier");
  const badJson = await admin(`${ws(workspaceId)}/test-suites`, { method: "POST", rawBody: "{not json" });
  assert.equal(badJson.status, 400); assert.equal(badJson.body.error, "invalid_json");
  const invalid = await admin(`${ws(workspaceId)}/test-suites`, { method: "POST", body: { name: "", definition: "nope", extra: 1 } });
  assert.equal(invalid.status, 400); assert.equal(invalid.body.error, "invalid_request"); assert.ok(invalid.body.details);
  const huge = await admin(`${ws(workspaceId)}/test-suites`, { method: "POST", body: { name: "big", definition: { blob: "x".repeat(400_000) } } });
  assert.equal(huge.status, 413); assert.equal(huge.body.error, "payload_too_large");
  for (const response of [notFound, badId, badJson, invalid, huge]) assert.doesNotMatch(response.text, /node_modules|\.mjs|\n\s+at \S+ \(/);
});

test("requests without a usable credential are rejected", { skip }, async () => {
  const anonymous = createClient(api.url);
  assert.equal((await anonymous("/v1/workspaces")).status, 401);
  assert.equal((await anonymous("/v1/workspaces", { headers: { authorization: "Basic abc" } })).status, 401);
  assert.equal((await admin("/v1/workspaces", { token: "wrong-token-value" })).status, 401);
  assert.equal((await admin("/v1/workspaces", { token: "wpk_doesnotexist" })).status, 401);
  assert.equal((await admin("/v1/workspaces", { token: "wpg_gateway-token-on-human-api" })).status, 401);
});

test("OIDC tokens are verified: signature, issuer, audience, expiry and algorithm", { skip }, async () => {
  const ok = await createClient(api.url, await issuer.sign({ sub: "viewer-1" }))("/v1/workspaces");
  assert.equal(ok.status, 200); assert.deepEqual(ok.body.map((item) => item.id), [workspaceId]);
  const rejected = {
    expired: await issuer.sign({ sub: "viewer-1", exp: Math.floor(Date.now() / 1000) - 3600 }),
    wrongAudience: await issuer.sign({ sub: "viewer-1", aud: "someone-else" }),
    wrongIssuer: await issuer.sign({ sub: "viewer-1", iss: "http://127.0.0.1:1" }),
    foreignKey: await issuer.sign({ sub: "viewer-1", signWith: issuer.foreignKey }),
    // Symmetric algorithms must never be accepted for an asymmetric issuer (algorithm confusion).
    hs256: await issuer.sign({ sub: "viewer-1", alg: "HS256", signWith: new TextEncoder().encode("a-shared-secret-of-sufficient-length-1234") }),
    none: `${Buffer.from('{"alg":"none"}').toString("base64url")}.${Buffer.from(JSON.stringify({ sub: "viewer-1", iss: issuer.issuer, aud: "wirepulse-test", exp: 4102444800 })).toString("base64url")}.`
  };
  for (const [name, token] of Object.entries(rejected)) assert.equal((await admin("/v1/workspaces", { token })).status, 401, name);
});

test("an unverified email is never used as an identity", { skip }, async () => {
  const unverified = await as("someone", { email: "admin@wirepulse.local", emailVerified: false });
  const response = await unverified("/v1/invitations");
  assert.equal(response.status, 403); assert.equal(response.body.error, "verified_email_required");
});

test("roles are enforced per workspace", { skip }, async () => {
  const viewer = await as("viewer-1"); const engineer = await as("engineer-1"); const maintainer = await as("maintainer-1"); const stranger = await as("stranger-1");
  const suites = `${ws(workspaceId)}/test-suites`;
  assert.equal((await viewer(suites)).status, 200);
  assert.equal((await viewer(suites, { method: "POST", body: { name: "nope", definition: {} } })).status, 403);
  const created = await engineer(suites, { method: "POST", body: { name: "rbac", definition: { tests: [] } } });
  assert.equal(created.status, 201);
  assert.equal((await engineer(`${suites}/${created.body.id}`, { method: "DELETE" })).status, 403);
  assert.equal((await maintainer(`${suites}/${created.body.id}`, { method: "DELETE" })).status, 204);
  assert.equal((await maintainer(`${ws(workspaceId)}/members`)).status, 200);
  assert.equal((await maintainer(`${ws(workspaceId)}/audit-events`)).status, 403);
  assert.equal((await stranger(suites)).status, 403);
  // Membership in one workspace grants nothing in another.
  assert.equal((await viewer(`${ws(otherWorkspaceId)}/test-suites`)).status, 403);
});

test("profiles and suites use optimistic concurrency and keep an immutable version history", { skip }, async () => {
  const base = `${ws(workspaceId)}/test-suites`;
  const created = (await admin(base, { method: "POST", body: { name: "versioned", definition: { tests: [{ id: "a" }] } } })).body;
  assert.equal(created.version, 1);
  const v2 = await admin(`${base}/${created.id}`, { method: "PUT", body: { name: "versioned", definition: { tests: [{ id: "b" }] } }, headers: { "if-match-version": "1" } });
  assert.equal(v2.status, 200); assert.equal(v2.body.version, 2);
  const stale = await admin(`${base}/${created.id}`, { method: "PUT", body: { name: "versioned", definition: { tests: [] } }, headers: { "if-match-version": "1" } });
  assert.equal(stale.status, 409);
  assert.equal((await admin(`${base}/${created.id}`, { method: "PUT", body: { name: "versioned", definition: {} } })).status, 428);
  const history = (await admin(`${base}/${created.id}/versions`)).body;
  assert.deepEqual(history.map((item) => item.version), [2, 1]);
  assert.deepEqual((await admin(`${base}/${created.id}/versions/1`)).body.definition, { tests: [{ id: "a" }] });
  // History survives deletion, and rows cannot be rewritten even by the application's own database role.
  assert.equal((await admin(`${base}/${created.id}`, { method: "DELETE" })).status, 204);
  assert.equal((await admin(`${base}/${created.id}/versions/2`)).status, 200);
  await assert.rejects(pool.query("UPDATE resource_versions SET definition = '{}'::jsonb WHERE resource_id = $1", [created.id]));
});

test("CORS only allows configured origins", { skip }, async () => {
  const allowed = await fetch(`${api.url}/v1/workspaces`, { method: "OPTIONS", headers: { origin: "http://localhost:5173", "access-control-request-method": "GET", "access-control-request-headers": "authorization" } });
  assert.equal(allowed.headers.get("access-control-allow-origin"), "http://localhost:5173");
  const denied = await fetch(`${api.url}/v1/workspaces`, { method: "OPTIONS", headers: { origin: "https://evil.example", "access-control-request-method": "GET" } });
  assert.equal(denied.headers.get("access-control-allow-origin"), null);
});

test("authentication failures are logged as security events without the credential", { skip }, async () => {
  const secret = "wpk_THIS-SECRET-MUST-NEVER-BE-LOGGED-0123456789";
  await admin("/v1/workspaces", { token: secret });
  await admin("/v1/workspaces", { token: "Bearer-looking-but-wrong-abcdef123456" });
  const logs = api.logs();
  assert.ok(!logs.includes(secret));
  assert.ok(!logs.includes("THIS-SECRET-MUST-NEVER"));
  assert.ok(api.logEntries().some((entry) => entry.security === true && entry.event === "auth.failed" && entry.kind === "api_key"));
  assert.ok(!logs.includes(DEV_TOKEN));
});
