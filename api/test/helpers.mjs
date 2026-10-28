// Shared harness for the integration tests. Needs WP_TEST_DATABASE_URL pointing at a disposable PostgreSQL
// server (a role allowed to CREATE DATABASE). Every test file gets its own database, so files can run in parallel.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import http from "node:http";
import { SignJWT, exportJWK, generateKeyPair } from "jose";
import pg from "pg";
import { createApp } from "../src/app.mjs";
import { loadConfig } from "../src/config.mjs";
import { createDatabase } from "../src/db.mjs";
import { createLogger } from "../src/log.mjs";
import { migrate } from "../src/migrate.mjs";

export const ADMIN_URL = process.env.WP_TEST_DATABASE_URL;
export const skip = ADMIN_URL ? false : "WP_TEST_DATABASE_URL not set";
export const DEV_TOKEN = "dev-token-for-tests";
export const AUDIENCE = "wirepulse-test";
export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function waitFor(check, { timeoutMs = 10_000, intervalMs = 50, message = "condition" } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${message}`);
    await sleep(intervalMs);
  }
}

export async function createTestDatabase() {
  const name = `wp_test_${crypto.randomBytes(6).toString("hex")}`;
  const admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${name}`);
  await admin.end();
  const url = new URL(ADMIN_URL); url.pathname = `/${name}`;
  return {
    url: url.toString(),
    async drop() {
      const dropper = new pg.Client({ connectionString: ADMIN_URL });
      await dropper.connect();
      await dropper.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await dropper.end();
    }
  };
}

// A minimal OIDC provider: publishes a discovery document, serves a JWKS and signs tokens, so the real jose verification path is
// exercised. Like Keycloak, Okta or Entra it keeps its keys at a provider-specific path that is only discoverable from the
// discovery document. A test can set `state.discovery` to another document (or null for a 500) and read `hits` to see what was fetched.
export const JWKS_PATH = "/protocol/openid-connect/certs";
export async function startIssuer() {
  const { publicKey, privateKey } = await generateKeyPair("RS256");
  const other = await generateKeyPair("RS256");
  const jwk = { ...(await exportJWK(publicKey)), kid: "test-key", alg: "RS256", use: "sig" };
  const hits = { discovery: 0, jwks: 0 };
  const state = { discovery: undefined };
  const server = http.createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.url === JWKS_PATH) { hits.jwks += 1; res.end(JSON.stringify({ keys: [jwk] })); }
    else if (req.url === "/.well-known/openid-configuration") {
      hits.discovery += 1;
      if (state.discovery === null) { res.statusCode = 500; res.end(); } else res.end(JSON.stringify(state.discovery ?? { issuer, jwks_uri: `${issuer}${JWKS_PATH}` }));
    } else { res.statusCode = 404; res.end(); }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const issuer = `http://127.0.0.1:${server.address().port}`;
  async function sign({ sub = "user-1", email, emailVerified = true, aud = AUDIENCE, iss = issuer, exp = "5m", signWith = privateKey, alg = "RS256" } = {}) {
    const claims = {};
    if (email !== undefined) { claims.email = email; claims.email_verified = emailVerified; }
    return new SignJWT(claims).setProtectedHeader({ alg, kid: "test-key" }).setSubject(sub).setIssuer(iss).setAudience(aud).setIssuedAt().setExpirationTime(exp).sign(signWith);
  }
  return { issuer, sign, hits, state, foreignKey: other.privateKey, stop: () => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }) };
}

// Runs the real app in-process on an ephemeral port. `logs()` returns every structured log line written so far.
export async function startApi({ databaseUrl, env = {}, issuer } = {}) {
  const lines = [];
  const destination = { write(chunk) { lines.push(chunk.toString()); } };
  const config = loadConfig({
    DATABASE_URL: databaseUrl, PORT: "0", DEV_BEARER_TOKEN: DEV_TOKEN, DEV_SUBJECT: "dev-admin", DEV_EMAIL: "admin@wirepulse.local",
    ...(issuer ? { OIDC_ISSUER: issuer.issuer, OIDC_AUDIENCE: AUDIENCE } : {}),
    DB_POOL_SIZE: "5", // the test files run in parallel against one server, each with several instances: ten per instance exhausts max_connections
    RATE_LIMIT_PER_MINUTE: "1000000", RATE_LIMIT_IP_PER_MINUTE: "1000000", GATEWAY_RATE_LIMIT_PER_MINUTE: "1000000", AUTH_FAILURE_LIMIT_PER_MINUTE: "100000",
    SWEEP_INTERVAL_MS: "200", JOB_LEASE_SECONDS: "5", QUEUE_TTL_SECONDS: "3600", SSE_HEARTBEAT_MS: "1000", LOG_LEVEL: "info",
    ...env
  });
  const log = createLogger({ level: config.logLevel, destination });
  const db = createDatabase({ url: config.databaseUrl, poolSize: config.db.poolSize, ssl: config.db.ssl, statementTimeoutMs: config.db.statementTimeoutMs, idleTxTimeoutMs: config.db.idleTxTimeoutMs, connectTimeoutMs: config.db.connectTimeoutMs, log });
  await migrate(db, { log });
  const instance = createApp({ config, db, log });
  const { port } = await instance.start();
  return {
    url: `http://127.0.0.1:${port}`, config, db, instance, log,
    logs: () => lines.join(""),
    logEntries: () => lines.join("").split("\n").filter(Boolean).map((line) => JSON.parse(line)),
    stop: () => instance.shutdown({ graceMs: 1000 })
  };
}

// A small JSON client. `token` is the default credential; pass `token: null` for an anonymous call.
export function createClient(baseUrl, defaultToken) {
  return async function request(path, { method = "GET", body, token = defaultToken, headers = {}, rawBody } = {}) {
    const response = await fetch(`${baseUrl}${path}`, {
      method,
      headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body !== undefined || rawBody !== undefined ? { "content-type": "application/json" } : {}), ...headers },
      body: rawBody ?? (body === undefined ? undefined : JSON.stringify(body))
    });
    const text = await response.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
    return { status: response.status, body: json, text, headers: response.headers };
  };
}

export const ws = (id) => `/v1/workspaces/${id}`;

// A one-test suite the simulated transport can pass ("READY" answers "status").
export const sampleDefinition = (overrides = {}) => ({
  tests: [{ id: "t1", name: "ready", commands: "status", expectedText: "READY", telemetryToken: "", telemetryOperator: ">=", telemetryValue: "", timeoutMs: 500, retries: 0 }],
  profile: { settings: { baud: "115200" } },
  ...overrides
});

// Every migration file on disk, in order: tests assert against this instead of a hard-coded list that each new migration would break.
export const MIGRATION_NAMES = fs.readdirSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "migrations")).filter((name) => /^\d+_.+\.sql$/.test(name)).sort();

// A local HTTP receiver that records every request (raw body included). `handler(req, res, record, count)` decides the answer; the
// default is 200. `setHandler` swaps it mid-test.
export async function startReceiver(handler = (_req, res) => { res.statusCode = 200; res.end("ok"); }) {
  const requests = [];
  let current = handler;
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const record = { method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(chunks).toString(), at: Date.now() };
      requests.push(record);
      current(req, res, record, requests.length);
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  return {
    requests, port, url: `http://127.0.0.1:${port}`,
    setHandler(next) { current = next; },
    close: () => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); })
  };
}
