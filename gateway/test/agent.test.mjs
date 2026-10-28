import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { AgentConfigError, FatalAgentError, createAgent, createAgentLog, loadAgentConfig } from "../src/agent.mjs";
import { AGENT_VERSION } from "../src/engine.mjs";
import { createSimulatedTransport } from "../src/transports.mjs";
import { verifyEvidence } from "../../api/src/evidence.mjs";

const TOKEN = "wpg_0123456789abcdefghijklmnopqrstuvwxyzABCDEF";
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(check, { timeoutMs = 8000, message = "condition" } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) { const value = await check(); if (value) return value; if (Date.now() > deadline) throw new Error(`timed out waiting for ${message}`); await sleep(15); }
}

// A stand-in control plane: `handler(call, calls)` decides each reply; the default is an idle, healthy server.
async function fakeApi(handler = () => undefined) {
  const calls = [];
  const server = http.createServer(async (req, res) => {
    let raw = ""; for await (const chunk of req) raw += chunk;
    const call = { path: req.url.replace("/gateway/v1", ""), method: req.method, headers: req.headers, body: raw ? JSON.parse(raw) : {} };
    calls.push(call);
    const reply = (await handler(call, calls)) ?? (call.path === "/heartbeat" ? { status: 200, body: { status: "ok", leaseSeconds: 3 } } : call.path === "/jobs/claim" ? { status: 204 } : { status: 200, body: { status: "running" } });
    if (reply.destroy) return req.socket.destroy();
    if (reply.hang) return undefined;
    res.writeHead(reply.status, { "content-type": "application/json", ...(reply.headers ?? {}) });
    return res.end(reply.status === 204 ? undefined : JSON.stringify(reply.body ?? {}));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const stop = () => new Promise((resolve) => { server.close(() => resolve()); server.closeAllConnections(); });
  servers.push(stop);
  return { url: `http://127.0.0.1:${server.address().port}`, calls, paths: () => calls.map((call) => call.path), stop };
}

const config = (apiUrl, extra = {}) => ({ apiUrl, token: TOKEN, serialPath: "/dev/ttyTEST", pollMs: 20, leaseRenewMs: 50, heartbeatMs: 60_000, requestTimeoutMs: 1000, maxBackoffMs: 200, shutdownGraceMs: 500, ...extra });
const job = (overrides = {}) => ({ id: "11111111-1111-4111-8111-111111111111", attempts: 1, definition: { tests: [{ id: "t1", name: "ready", commands: "status", expectedText: "READY", telemetryToken: "", telemetryOperator: ">=", telemetryValue: "", timeoutMs: 30_000, retries: 0 }], profile: { settings: { baud: "115200" } } }, ...overrides });
const claimOnce = (payload = job()) => { let served = false; return (call) => (call.path === "/jobs/claim" && !served ? ((served = true), { status: 200, body: payload }) : undefined); };
const answering = (ms = 0) => async () => createSimulatedTransport({ responder: () => ["READY"], delayMs: Math.max(5, ms) });
const silent = async () => createSimulatedTransport({ responder: () => [] });
const agents = [];
const servers = [];
// A failed assertion (or a timeout) must not leave an agent polling or a server listening, which would keep the runner alive.
test.afterEach(async () => { for (const agent of agents.splice(0)) agent.stop(); await Promise.all(servers.splice(0).map((stop) => stop())); });
function build(api, { extra, openTransport = answering(), sleepImpl, random } = {}) {
  const lines = [];
  const log = createAgentLog({ write: (line) => lines.push(JSON.parse(line)), secrets: [TOKEN] });
  const agent = createAgent({ config: config(api.url, extra), openTransport, log, ...(sleepImpl ? { sleep: sleepImpl } : {}), ...(random ? { random } : {}) });
  agents.push(agent);
  return { agent, lines, messages: () => lines.map((line) => line.message) };
}

test("config: https is required except for localhost or an explicit opt-in", () => {
  const base = { WIREPULSE_API_URL: "https://wirepulse.example.com/", WIREPULSE_GATEWAY_TOKEN: TOKEN, WIREPULSE_SERIAL_PATH: "/dev/ttyUSB0" };
  const loaded = loadAgentConfig(base);
  assert.equal(loaded.apiUrl, "https://wirepulse.example.com"); assert.equal(loaded.pollMs, 3000); assert.ok(Object.isFrozen(loaded));
  assert.equal(loadAgentConfig({ ...base, WIREPULSE_API_URL: "https://proxy.example.com/wirepulse/" }).apiUrl, "https://proxy.example.com/wirepulse");
  assert.equal(loadAgentConfig({ ...base, WIREPULSE_API_URL: "http://localhost:8080" }).apiUrl, "http://localhost:8080");
  assert.equal(loadAgentConfig({ ...base, WIREPULSE_API_URL: "http://127.0.0.1:8080" }).apiUrl, "http://127.0.0.1:8080");
  assert.throws(() => loadAgentConfig({ ...base, WIREPULSE_API_URL: "http://wirepulse.example.com" }), /must use https/);
  assert.equal(loadAgentConfig({ ...base, WIREPULSE_API_URL: "http://10.1.2.3:8080", WIREPULSE_ALLOW_INSECURE_HTTP: "true" }).apiUrl, "http://10.1.2.3:8080");
  assert.throws(() => loadAgentConfig({ ...base, WIREPULSE_API_URL: "https://user:pass@wirepulse.example.com" }), /must not contain credentials/);
  assert.throws(() => loadAgentConfig({ ...base, WIREPULSE_API_URL: "ftp://wirepulse.example.com" }), /must use https/);
  assert.throws(() => loadAgentConfig({ ...base, WIREPULSE_API_URL: "not a url" }), /not a valid URL/);
});

test("config: the token comes from a file when asked, and is never echoed in errors", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wp-agent-"));
  try {
    const base = { WIREPULSE_API_URL: "https://wirepulse.example.com", WIREPULSE_SERIAL_PATH: "/dev/ttyUSB0" };
    fs.writeFileSync(path.join(dir, "token"), `${TOKEN}\n`);
    assert.equal(loadAgentConfig({ ...base, WIREPULSE_GATEWAY_TOKEN: "wpg_ignored-because-the-file-wins-1234", WIREPULSE_GATEWAY_TOKEN_FILE: path.join(dir, "token") }).token, TOKEN);
    assert.throws(() => loadAgentConfig({ ...base, WIREPULSE_GATEWAY_TOKEN_FILE: path.join(dir, "missing") }), /cannot be read: ENOENT/);
    assert.throws(() => loadAgentConfig(base), /WIREPULSE_GATEWAY_TOKEN or WIREPULSE_GATEWAY_TOKEN_FILE is required/);
    const bad = "wpk_this-is-an-api-key-not-a-gateway-token";
    try { loadAgentConfig({ ...base, WIREPULSE_GATEWAY_TOKEN: bad }); assert.fail("accepted"); } catch (error) {
      assert.ok(error instanceof AgentConfigError); assert.match(error.message, /malformed/); assert.ok(!error.message.includes(bad));
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("config: numeric settings are bounded and every problem is reported together", () => {
  try { loadAgentConfig({ WIREPULSE_POLL_MS: "5", WIREPULSE_REQUEST_TIMEOUT_MS: "soon", WIREPULSE_SHUTDOWN_GRACE_MS: "-1" }); assert.fail("accepted"); } catch (error) {
    for (const name of ["WIREPULSE_API_URL", "WIREPULSE_GATEWAY_TOKEN", "WIREPULSE_SERIAL_PATH", "WIREPULSE_POLL_MS", "WIREPULSE_REQUEST_TIMEOUT_MS", "WIREPULSE_SHUTDOWN_GRACE_MS"]) assert.match(error.message, new RegExp(name));
  }
  assert.equal(loadAgentConfig({ WIREPULSE_API_URL: "https://x.example.com", WIREPULSE_GATEWAY_TOKEN: TOKEN }, { requireSerialPath: false }).serialPath, "");
});

test("log: the token and anything shaped like one never reaches the output", () => {
  const out = [];
  const log = createAgentLog({ write: (line) => out.push(line), secrets: ["custom-secret-value"] });
  log.error(`failed with ${TOKEN}`, { detail: "custom-secret-value and wpg_anotherTokenValue123456" });
  const text = out.join("");
  assert.ok(!text.includes(TOKEN) && !text.includes("custom-secret-value") && !text.includes("anotherTokenValue"));
  assert.equal(JSON.parse(text).level, "error");
});

test("a claimed job runs end to end and the result carries verifiable evidence", async () => {
  const api = await fakeApi(claimOnce());
  const { agent, messages } = build(api);
  try {
    const running = agent.run();
    await waitFor(() => api.paths().includes("/jobs/11111111-1111-4111-8111-111111111111/complete"), { message: "the result to be posted" });
    agent.stop(); await running;
    assert.deepEqual(api.paths().filter((item) => item !== "/jobs/claim"), ["/heartbeat", "/jobs/11111111-1111-4111-8111-111111111111/start", "/jobs/11111111-1111-4111-8111-111111111111/complete"]);
    const heartbeat = api.calls[0];
    assert.equal(heartbeat.headers.authorization, `Bearer ${TOKEN}`); assert.equal(heartbeat.body.agentVersion, AGENT_VERSION); assert.deepEqual(heartbeat.body.capabilities, { serialPorts: ["/dev/ttyTEST"] });
    const complete = api.calls.find((call) => call.path.endsWith("/complete"));
    assert.deepEqual(complete.body.results, [{ testId: "t1", status: "passed", attempts: 1 }]);
    assert.equal(verifyEvidence(complete.body.evidence, complete.body.results).valid, true);
    assert.ok(messages().includes("job completed"));
  } finally { await api.stop(); }
});

test("the heartbeat keeps running while a long job holds the agent", async () => {
  const api = await fakeApi(claimOnce());
  const { agent } = build(api, { extra: { heartbeatMs: 50 }, openTransport: answering(400) });
  try {
    const running = agent.run();
    await waitFor(() => api.paths().some((item) => item.endsWith("/complete")), { message: "completion" });
    agent.stop(); await running;
    const startedAt = api.paths().indexOf("/jobs/11111111-1111-4111-8111-111111111111/start");
    const heartbeatsDuringJob = api.paths().slice(startedAt).filter((item) => item === "/heartbeat").length;
    assert.ok(heartbeatsDuringJob >= 3, `only ${heartbeatsDuringJob} heartbeats while the job ran`);
  } finally { await api.stop(); }
});

test("a cancelled job (409 on progress) stops the run and nothing is reported", async () => {
  const claim = claimOnce();
  const api = await fakeApi((call) => claim(call) ?? (call.path.endsWith("/progress") ? { status: 409, body: { error: "job_not_active", status: "cancelled" } } : undefined));
  const { agent, lines } = build(api, { openTransport: silent });
  try {
    const running = agent.run();
    await waitFor(() => lines.some((line) => line.message === "run abandoned without reporting a result"), { message: "the run to be abandoned" });
    agent.stop(); await running;
    assert.equal(lines.find((line) => line.message === "run abandoned without reporting a result").reason, "cancelled");
    assert.ok(!api.paths().some((item) => item.endsWith("/complete")));
  } finally { await api.stop(); }
});

test("when the lease can no longer be renewed the agent stops driving the device", async () => {
  const claim = claimOnce();
  const api = await fakeApi((call) => (call.path === "/heartbeat" ? { status: 200, body: { leaseSeconds: 1 } } : claim(call) ?? (call.path.endsWith("/progress") ? { destroy: true } : undefined)));
  const { agent, lines } = build(api, { openTransport: silent });
  try {
    const running = agent.run();
    const abandoned = await waitFor(() => lines.find((line) => line.message === "run abandoned without reporting a result"), { message: "the lease to be given up" });
    assert.equal(abandoned.reason, "lease_lost");
    assert.ok(lines.some((line) => line.message === "lease renewal failed" || line.reason === "lease_lost"));
    agent.stop(); await running;
    assert.ok(!api.paths().some((item) => item.endsWith("/complete")));
  } finally { await api.stop(); }
});

test("a rejected token is fatal: the agent stops, says why, and never leaks the token", async () => {
  const api = await fakeApi((call) => (call.path === "/jobs/claim" ? { status: 401, body: { error: "unauthorized" } } : undefined));
  const { agent, lines } = build(api);
  try {
    await assert.rejects(agent.run(), (error) => error instanceof FatalAgentError && /rejected the gateway token/.test(error.message) && !error.message.includes(TOKEN));
    const claims = api.paths().filter((item) => item === "/jobs/claim").length;
    await sleep(150);
    assert.equal(api.paths().filter((item) => item === "/jobs/claim").length, claims, "no further attempts after a rejection");
    assert.ok(lines.some((line) => line.fatal === true));
    assert.ok(!JSON.stringify(lines).includes(TOKEN));
  } finally { await api.stop(); }
});

test("a revoked token found by the heartbeat during a job aborts the job", async () => {
  const claim = claimOnce();
  const api = await fakeApi((call, calls) => (call.path === "/heartbeat" && calls.filter((item) => item.path === "/heartbeat").length > 1 ? { status: 401, body: {} } : claim(call)));
  const { agent } = build(api, { extra: { heartbeatMs: 50 }, openTransport: silent });
  try {
    await assert.rejects(agent.run(), FatalAgentError);
    assert.ok(!api.paths().some((item) => item.endsWith("/complete")));
  } finally { await api.stop(); }
});

test("failures back off exponentially up to a cap, honour Retry-After, and reset on success", async () => {
  let mode = "limited";
  const api = await fakeApi((call) => (call.path === "/jobs/claim" ? (mode === "down" ? { status: 503, body: {} } : mode === "limited" ? { status: 429, body: {}, headers: { "retry-after": "2" } } : { status: 204 }) : undefined));
  const delays = [];
  const harness = build(api, {
    // random() = 0 yields the lower bound of each window: half of min(max, poll * 2^failures).
    extra: { pollMs: 1000, maxBackoffMs: 5000 }, random: () => 0,
    sleepImpl: async (ms) => { delays.push(ms); await sleep(1); if (delays.length === 1) mode = "down"; if (delays.length === 4) mode = "ok"; if (delays.length === 6) harness.agent.stop(); }
  });
  try {
    await harness.agent.run();
    assert.deepEqual(delays, [2000, 2000, 2500, 2500, 1000, 1000], "Retry-After (2 s) beats the 1 s backoff; then 2 s, capped at 2.5 s; success returns to the base poll interval");
  } finally { await api.stop(); }
});

test("requests have a timeout, so a hung server cannot stall the agent", async () => {
  const api = await fakeApi((call) => (call.path === "/jobs/claim" ? { hang: true } : undefined));
  const { agent, lines } = build(api, { extra: { requestTimeoutMs: 100, pollMs: 20, maxBackoffMs: 50 } });
  try {
    const running = agent.run();
    await waitFor(() => api.paths().filter((item) => item === "/jobs/claim").length >= 2, { message: "a second claim after the first timed out" });
    assert.ok(lines.some((line) => line.message === "claim failed" && line.status === 0));
    agent.stop(); await running;
  } finally { await api.stop(); }
});

test("stopping while idle returns promptly, even in the middle of a long poll sleep", async () => {
  const api = await fakeApi();
  const { agent } = build(api, { extra: { pollMs: 60_000 } });
  try {
    const running = agent.run();
    await waitFor(() => api.paths().includes("/jobs/claim"), { message: "the first claim" });
    const started = Date.now(); agent.stop(); await running;
    assert.ok(Date.now() - started < 500);
  } finally { await api.stop(); }
});

test("graceful stop: a job that finishes inside the grace period is still reported", async () => {
  const api = await fakeApi(claimOnce());
  const { agent } = build(api, { extra: { shutdownGraceMs: 5000 }, openTransport: answering(400) });
  try {
    const running = agent.run();
    await waitFor(() => api.paths().some((item) => item.endsWith("/start")), { message: "the job to start" });
    agent.stop();
    await running;
    assert.ok(api.paths().some((item) => item.endsWith("/complete")));
    assert.equal(api.paths().filter((item) => item === "/jobs/claim").length, 1, "no new work after the stop");
  } finally { await api.stop(); }
});

test("graceful stop: a job that outlives the grace period is abandoned, not reported half done", async () => {
  const api = await fakeApi(claimOnce());
  const { agent, lines } = build(api, { extra: { shutdownGraceMs: 100 }, openTransport: silent });
  try {
    const running = agent.run();
    await waitFor(() => api.paths().some((item) => item.endsWith("/start")), { message: "the job to start" });
    const started = Date.now(); agent.stop(); await running;
    assert.ok(Date.now() - started < 1500);
    assert.equal(lines.find((line) => line.message === "run abandoned without reporting a result").reason, "shutdown");
    assert.ok(!api.paths().some((item) => item.endsWith("/complete")));
  } finally { await api.stop(); }
});

test("delivery retries transient failures but treats 409, 422 and other 4xx as final", async () => {
  const outcomes = {
    transient: [{ status: 503, body: {} }, { status: 429, body: {}, headers: { "retry-after": "0" } }, { status: 200, body: { status: "passed" } }],
    cancelled: [{ status: 409, body: { error: "job_not_active" } }],
    rejected: [{ status: 422, body: { error: "evidence_verification_failed", reason: "bad hash" } }],
    forbidden: [{ status: 403, body: { error: "forbidden" } }],
    unknown: [{ status: 404, body: { error: "not_found" } }]
  };
  for (const [name, replies] of Object.entries(outcomes)) {
    let index = 0;
    const claim = claimOnce();
    const api = await fakeApi((call) => claim(call) ?? (call.path.endsWith("/complete") ? replies[Math.min(index++, replies.length - 1)] : undefined));
    const { agent } = build(api);
    try {
      const running = agent.run();
      await waitFor(() => api.paths().filter((item) => item.endsWith("/complete")).length >= replies.length, { message: `${name} deliveries` });
      await sleep(150); agent.stop(); await running;
      assert.equal(api.paths().filter((item) => item.endsWith("/complete")).length, replies.length, name);
    } finally { await api.stop(); }
  }
});

test("a local failure (device unavailable) is not reported as a result and slows the agent down", async () => {
  const api = await fakeApi(claimOnce());
  const delays = [];
  // The injected sleep is shared with the lease-renewal loop, so only waits that follow the failure are of interest.
  const harness = build(api, {
    openTransport: async () => { throw new Error(`cannot open /dev/ttyTEST (${TOKEN})`); }, extra: { pollMs: 500, maxBackoffMs: 5000 },
    sleepImpl: async (ms) => {
      if (harness.lines.some((line) => line.message.startsWith("job failed locally"))) { delays.push(ms); harness.agent.stop(); }
      await sleep(5);
    }
  });
  try {
    await harness.agent.run();
    assert.ok(!api.paths().some((item) => item.endsWith("/complete")));
    assert.ok(delays[0] >= 500, `backs off after a local failure instead of polling at full speed (waited ${delays[0]} ms)`);
    assert.ok(!JSON.stringify(harness.lines).includes(TOKEN));
  } finally { await api.stop(); }
});
