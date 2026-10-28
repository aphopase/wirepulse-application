// Pure unit tests: no database or network needed.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ConfigError, loadConfig } from "../src/config.mjs";
import { HttpError, decodeCursor, encodeCursor, parseLimit } from "../src/http.mjs";
import { toJunit } from "../src/junit.mjs";
import { createLogger, maskSecrets } from "../src/log.mjs";

const DB = "postgres://wp:secret@db.internal:5432/wirepulse";
const dev = { DATABASE_URL: DB, DEV_BEARER_TOKEN: "dev-token-123" };
const production = { DATABASE_URL: DB, NODE_ENV: "production", OIDC_ISSUER: "https://idp.example.com/", OIDC_AUDIENCE: "wirepulse", CORS_ORIGINS: "https://app.example.com", TRUST_PROXY: "1", DB_SSL: "verify" };
const problemsOf = (env) => { try { loadConfig(env); } catch (error) { assert.ok(error instanceof ConfigError, `unexpected ${error}`); return error.problems.join("\n"); } assert.fail("expected the configuration to be rejected"); };
const tempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), "wp-unit-"));

test("config: defaults are safe and the result is immutable", () => {
  const config = loadConfig(dev);
  assert.equal(config.production, false); assert.equal(config.port, 8080); assert.equal(config.migrateOnStart, true);
  assert.deepEqual(config.corsOrigins, ["http://localhost:5173"]);
  assert.equal(config.limits.subjectPerMinute, 240); assert.equal(config.jobs.leaseSeconds, 60); assert.equal(config.jobs.maxAttempts, 3);
  assert.deepEqual(config.retention, { jobsDays: 0, reportsDays: 0, auditDays: 0, intervalHours: 24 }, "retention is opt-in");
  assert.equal(config.trustProxy, false); assert.equal(config.oidc, null);
  assert.deepEqual(config.dev, { token: "dev-token-123", subject: "dev-admin", email: "admin@wirepulse.local" });
  assert.ok(Object.isFrozen(config));
});

test("config: every invalid value is reported at once", () => {
  const problems = problemsOf({ DATABASE_URL: "not-a-url", PORT: "99999", RATE_LIMIT_PER_MINUTE: "0", LOG_LEVEL: "loud", MIGRATE_ON_START: "yes", JOB_LEASE_SECONDS: "1" });
  for (const name of ["DATABASE_URL", "PORT", "RATE_LIMIT_PER_MINUTE", "LOG_LEVEL", "MIGRATE_ON_START", "JOB_LEASE_SECONDS"]) assert.match(problems, new RegExp(name));
  assert.doesNotMatch(problems, /secret/);
  assert.match(problemsOf({}), /DATABASE_URL/);
});

test("config: a valid production configuration", () => {
  const config = loadConfig(production);
  assert.equal(config.production, true); assert.equal(config.dev, null);
  assert.equal(config.oidc.issuer, "https://idp.example.com", "trailing slash removed so the issuer claim matches exactly");
  assert.deepEqual(config.corsOrigins, ["https://app.example.com"]); assert.equal(config.trustProxy, 1);
  assert.deepEqual(config.warnings, []);
});

test("config: production refuses unsafe settings", () => {
  const rejected = {
    "dev token": [{ ...production, DEV_BEARER_TOKEN: "dev-token-123" }, /DEV_BEARER_TOKEN must not be set in production/],
    "no OIDC": [{ DATABASE_URL: DB, NODE_ENV: "production", CORS_ORIGINS: "https://app.example.com" }, /OIDC_ISSUER and OIDC_AUDIENCE are required/],
    "http issuer": [{ ...production, OIDC_ISSUER: "http://idp.example.com" }, /OIDC_ISSUER must use https/],
    "http jwks": [{ ...production, OIDC_JWKS_URI: "http://idp.example.com/jwks" }, /OIDC_JWKS_URI must use https/],
    "no CORS origin": [{ ...production, CORS_ORIGINS: "" }, /CORS_ORIGINS must list/],
    "http origin": [{ ...production, CORS_ORIGINS: "http://app.example.com" }, /must use https in production/],
    "origin with path": [{ ...production, CORS_ORIGINS: "https://app.example.com/" }, /without path or trailing slash/],
    "issuer without audience": [{ ...production, OIDC_AUDIENCE: undefined }, /must be set together/],
    "short metrics token": [{ ...production, METRICS_TOKEN: "too-short" }, /METRICS_TOKEN must be at least 24/]
  };
  for (const [name, [env, expected]] of Object.entries(rejected)) assert.match(problemsOf(env), expected, name);
});

test("config: warnings point at risky but legal choices", () => {
  const warnings = loadConfig({ ...production, DB_SSL: "off", TRUST_PROXY: undefined }).warnings.join("\n");
  assert.match(warnings, /DB_SSL=off/); assert.match(warnings, /TRUST_PROXY is unset/);
  assert.match(loadConfig({ ...production, DB_SSL: "require" }).warnings.join("\n"), /does not verify the server certificate/);
  assert.match(loadConfig({ DATABASE_URL: DB }).warnings.join("\n"), /every \/v1 request will be rejected/);
  assert.equal(loadConfig({ ...production, DB_SSL: "verify" }).db.ssl.rejectUnauthorized, true);
});

test("config: secrets can come from *_FILE and the file wins over the environment", () => {
  const dir = tempDir();
  try {
    fs.writeFileSync(path.join(dir, "db"), `${DB}\n`); fs.writeFileSync(path.join(dir, "metrics"), "m".repeat(32));
    const config = loadConfig({ DATABASE_URL: "postgres://ignored:ignored@elsewhere/db", DATABASE_URL_FILE: path.join(dir, "db"), METRICS_TOKEN_FILE: path.join(dir, "metrics"), DEV_BEARER_TOKEN: "dev-token-123" });
    assert.equal(config.databaseUrl, DB, "trailing newline trimmed, file preferred");
    assert.equal(config.metrics.token, "m".repeat(32));
    const missing = problemsOf({ DATABASE_URL_FILE: path.join(dir, "absent") });
    assert.match(missing, /DATABASE_URL_FILE .*cannot be read: ENOENT/);
    assert.match(problemsOf({ ...dev, DB_SSL: "verify", DB_SSL_CA_FILE: path.join(dir, "absent-ca") }), /DB_SSL_CA_FILE .*cannot be read/);
    fs.writeFileSync(path.join(dir, "ca"), "-----BEGIN CERTIFICATE-----\nabc\n-----END CERTIFICATE-----\n");
    assert.match(loadConfig({ ...dev, DB_SSL: "verify", DB_SSL_CA_FILE: path.join(dir, "ca") }).db.ssl.ca, /BEGIN CERTIFICATE/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("config: TRUST_PROXY accepts a boolean, a hop count, or a subnet name", () => {
  assert.equal(loadConfig({ ...dev, TRUST_PROXY: "true" }).trustProxy, true);
  assert.equal(loadConfig({ ...dev, TRUST_PROXY: "false" }).trustProxy, false);
  assert.equal(loadConfig({ ...dev, TRUST_PROXY: "2" }).trustProxy, 2);
  assert.equal(loadConfig({ ...dev, TRUST_PROXY: "loopback" }).trustProxy, "loopback");
});

test("log: credentials are masked in free text and redacted in structured fields", () => {
  assert.equal(maskSecrets("failed for wpg_abcdefgh12345678 and wpk_ZZZZZZZZ-yyyyyy"), "failed for wp?_[redacted] and wp?_[redacted]");
  assert.equal(maskSecrets("Authorization: Bearer abc.def.ghi-123456"), "Authorization: Bearer [redacted]");
  assert.equal(maskSecrets("nothing to hide"), "nothing to hide");
  const lines = [];
  const log = createLogger({ level: "info", destination: { write: (chunk) => lines.push(chunk.toString()) } });
  log.info({ authorization: "Bearer topsecret-value-1", token: "wpg_topsecret12345", nested: { token: "wpk_nested-secret-1", tokenHash: "abc" }, headers: { authorization: "Bearer other-secret-22" } }, "context");
  log.error({ err: new Error("connect failed using wpg_leakedinmessage1234") }, "boom");
  const output = lines.join("");
  for (const secret of ["topsecret", "nested-secret", "other-secret", "leakedinmessage"]) assert.ok(!output.includes(secret), `${secret} leaked`);
  const entries = lines.map((line) => JSON.parse(line));
  assert.equal(entries[0].service, "wirepulse-api"); assert.equal(entries[0].level, "info"); assert.match(entries[0].time, /^\d{4}-\d\d-\d\dT/);
  assert.match(entries[1].err.message, /wp\?_\[redacted\]/);
});

test("junit: escapes markup, drops control characters, and counts outcomes", () => {
  const xml = toJunit({
    name: `Suite <"A"> & 'B'`, timestamp: "2026-01-02T03:04:05.000Z", evidenceFinalHash: "ab12",
    results: [{ testId: "ok", status: "passed", attempts: 1 }, { testId: "bad\u0000<id>", status: "failed", attempts: 3 }, { testId: "later", status: "not-run", attempts: 0 }]
  });
  assert.match(xml, /^<\?xml version="1.0" encoding="UTF-8"\?>/);
  assert.match(xml, /<testsuite name="Suite &lt;&quot;A&quot;&gt; &amp; &apos;B&apos;" tests="3" failures="1" errors="0" skipped="1" timestamp="2026-01-02T03:04:05.000Z">/);
  assert.match(xml, /name="bad&lt;id&gt;"/); assert.ok(!xml.includes("\u0000"));
  assert.match(xml, /<failure message="assertion failed after 3 attempt\(s\)"\/>/); assert.match(xml, /<skipped\/>/);
  assert.match(xml, /<property name="evidenceFinalHash" value="ab12"\/>/);
  assert.ok(!toJunit({ name: "n", timestamp: 0, results: [] }).includes("<properties>"));
});

test("cursors round-trip, keep microseconds, and reject garbage", () => {
  const at = "2026-03-04T05:06:07.123456Z";
  assert.deepEqual(decodeCursor(encodeCursor(at, "id-1")), { at, id: "id-1" });
  assert.deepEqual(decodeCursor(encodeCursor(new Date("2026-03-04T05:06:07.123Z"), "id-2")), { at: "2026-03-04T05:06:07.123Z", id: "id-2" });
  assert.equal(decodeCursor(undefined), null); assert.equal(decodeCursor(""), null);
  for (const bad of ["!!!", Buffer.from("[1,2").toString("base64url"), Buffer.from(JSON.stringify(["not a date", "x"])).toString("base64url"), Buffer.from(JSON.stringify([at, 5])).toString("base64url")]) {
    assert.throws(() => decodeCursor(bad), (error) => error instanceof HttpError && error.status === 400 && error.code === "invalid_cursor", bad);
  }
});

test("page size is clamped", () => {
  assert.equal(parseLimit(undefined), 50); assert.equal(parseLimit("abc"), 50);
  assert.equal(parseLimit("0"), 1); assert.equal(parseLimit("-5"), 1);
  assert.equal(parseLimit("25"), 25); assert.equal(parseLimit("100000"), 200);
  assert.equal(parseLimit("500", { max: 1000 }), 500);
});
