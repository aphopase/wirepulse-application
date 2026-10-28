import assert from "node:assert/strict";
import test from "node:test";
import { createAuth } from "../src/auth.mjs";
import { AUDIENCE, JWKS_PATH, startIssuer } from "./helpers.mjs";

// These drive the real authentication middleware with a fake provider that, like Keycloak/Okta/Entra, keeps its keys at a
// provider-specific path. They need no database.
const silent = { warn() {}, info() {}, error() {}, debug() {} };

// `reasons` collects the failure reason the middleware reports to the wirepulse_auth_failures_total metric.
function authFor(issuer, { jwksUri = null, production = false } = {}) {
  const reasons = [];
  const metrics = { authFailures: { inc: ({ reason }) => reasons.push(reason) } };
  const auth = createAuth({ config: { production, oidc: { issuer: issuer.issuer, audience: AUDIENCE, jwksUri, trustUnverifiedEmail: false }, dev: null }, db: null, log: silent, metrics });
  return Object.assign(auth, { reasons });
}

async function call(auth, token) {
  const req = { get: (name) => (name.toLowerCase() === "authorization" ? `Bearer ${token}` : undefined), ip: "127.0.0.1", path: "/v1/workspaces", requestId: "test-request" };
  const res = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
  let proceeded = false;
  await auth.identity(req, res, (error) => { if (error) throw error; proceeded = true; });
  return { proceeded, status: res.statusCode, body: res.body, identity: req.identity };
}

test("the signing keys are found through the issuer's discovery document, once", async () => {
  const issuer = await startIssuer();
  try {
    const auth = authFor(issuer);
    const first = await call(auth, await issuer.sign({ sub: "alice", email: "alice@example.com" }));
    assert.equal(first.proceeded, true);
    assert.deepEqual([first.identity.subject, first.identity.email], ["alice", "alice@example.com"]);
    assert.equal((await call(auth, await issuer.sign({ sub: "bob" }))).proceeded, true);
    assert.deepEqual(issuer.hits, { discovery: 1, jwks: 1 }, "discovered once, keys fetched once, then cached");
    assert.notEqual(JWKS_PATH, "/.well-known/jwks.json");
  } finally { await issuer.stop(); }
});

test("an explicit OIDC_JWKS_URI wins and discovery is never consulted", async () => {
  const issuer = await startIssuer();
  try {
    issuer.state.discovery = null; // would fail if it were used
    const auth = authFor(issuer, { jwksUri: `${issuer.issuer}${JWKS_PATH}` });
    assert.equal((await call(auth, await issuer.sign())).proceeded, true);
    assert.equal(issuer.hits.discovery, 0);
  } finally { await issuer.stop(); }
});

test("a discovery document that names another issuer is refused before any key is fetched", async () => {
  const issuer = await startIssuer();
  try {
    issuer.state.discovery = { issuer: "https://evil.example.com", jwks_uri: `${issuer.issuer}${JWKS_PATH}` };
    const auth = authFor(issuer);
    assert.equal((await call(auth, await issuer.sign())).status, 401);
    assert.deepEqual(auth.reasons, ["oidc_discovery_invalid"]);
    assert.equal(issuer.hits.jwks, 0);
  } finally { await issuer.stop(); }
});

test("a trailing slash on the published issuer is tolerated", async () => {
  const issuer = await startIssuer();
  try {
    issuer.state.discovery = { issuer: `${issuer.issuer}/`, jwks_uri: `${issuer.issuer}${JWKS_PATH}` };
    assert.equal((await call(authFor(issuer), await issuer.sign())).proceeded, true);
  } finally { await issuer.stop(); }
});

test("a discovery document without a jwks_uri is refused", async () => {
  const issuer = await startIssuer();
  try {
    issuer.state.discovery = { issuer: issuer.issuer };
    const auth = authFor(issuer);
    assert.equal((await call(auth, await issuer.sign())).status, 401);
    assert.deepEqual(auth.reasons, ["oidc_discovery_invalid"]);
  } finally { await issuer.stop(); }
});

test("in production a discovered jwks_uri must be https", async () => {
  const issuer = await startIssuer();
  try {
    const auth = authFor(issuer, { production: true });
    assert.equal((await call(auth, await issuer.sign())).status, 401, "the fake provider is plain http");
    assert.deepEqual(auth.reasons, ["oidc_discovery_insecure"]);
    assert.equal(issuer.hits.jwks, 0);
  } finally { await issuer.stop(); }
});

test("while the provider is unreachable, a burst of requests triggers one discovery attempt", async () => {
  const issuer = await startIssuer();
  try {
    issuer.state.discovery = null; // the provider answers 500
    const auth = authFor(issuer);
    const token = await issuer.sign();
    const results = [];
    for (let i = 0; i < 6; i += 1) results.push(await call(auth, token));
    assert.ok(results.every((r) => r.status === 401 && !r.proceeded));
    assert.equal(issuer.hits.discovery, 1, "failures are not retried on every request");
  } finally { await issuer.stop(); }
});

test("concurrent first requests share one discovery", async () => {
  const issuer = await startIssuer();
  try {
    const auth = authFor(issuer);
    const tokens = await Promise.all([1, 2, 3, 4, 5].map((n) => issuer.sign({ sub: `user-${n}` })));
    const results = await Promise.all(tokens.map((token) => call(auth, token)));
    assert.ok(results.every((r) => r.proceeded));
    assert.equal(issuer.hits.discovery, 1);
  } finally { await issuer.stop(); }
});
