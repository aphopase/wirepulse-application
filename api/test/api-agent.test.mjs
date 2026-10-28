// The real gateway agent against the real control plane (simulated serial device, real HTTP, real PostgreSQL).
import test from "node:test";
import assert from "node:assert/strict";
import { FatalAgentError, createAgent, createAgentLog } from "../../gateway/src/agent.mjs";
import { AGENT_VERSION } from "../../gateway/src/engine.mjs";
import { createSimulatedTransport } from "../../gateway/src/transports.mjs";
import { DEV_TOKEN, createClient, createTestDatabase, sampleDefinition, skip, sleep, startApi, waitFor, ws } from "./helpers.mjs";

let database; let api; let admin;
const running = [];

test.before(async () => {
  if (skip) return;
  database = await createTestDatabase();
  api = await startApi({ databaseUrl: database.url });
  admin = createClient(api.url, DEV_TOKEN);
});
test.afterEach(async () => { for (const agent of running.splice(0)) { agent.agent.stop(); await agent.done; } });
test.after(async () => { await api?.stop(); await database?.drop(); });

const newWorkspace = async (name) => (await admin("/v1/workspaces", { method: "POST", body: { name } })).body.id;
async function newGateway(workspaceId, name) {
  const response = await admin(`${ws(workspaceId)}/gateways`, { method: "POST", body: { name } });
  assert.equal(response.status, 201);
  return response.body;
}
const queue = (workspaceId, key, definition = sampleDefinition()) => admin(`${ws(workspaceId)}/test-jobs`, { method: "POST", body: { definition, idempotencyKey: key } }).then((response) => { assert.equal(response.status, 201); return response.body; });
const getJob = async (workspaceId, id) => (await admin(`${ws(workspaceId)}/test-jobs/${id}`)).body;
const until = (workspaceId, id, status, timeoutMs = 10_000) => waitFor(async () => { const job = await getJob(workspaceId, id); return job.status === status ? job : null; }, { timeoutMs, message: `job ${id} to become ${status}` });
// A test that only ends when the device answers, so the job stays running until something intervenes.
const slowDefinition = () => sampleDefinition({ tests: [{ ...sampleDefinition().tests[0], timeoutMs: 30_000 }] });

// `device.answer` is what the simulated serial device replies to every command; change it between jobs.
function startAgent(gateway, { device = { answer: ["READY"] }, extra = {} } = {}) {
  const lines = [];
  const config = { apiUrl: api.url, token: gateway.token, serialPath: "/dev/ttyTEST", pollMs: 50, leaseRenewMs: 500, heartbeatMs: 300, requestTimeoutMs: 3000, maxBackoffMs: 200, shutdownGraceMs: 300, ...extra };
  const agent = createAgent({
    config, log: createAgentLog({ write: (line) => lines.push(JSON.parse(line)), secrets: [gateway.token] }),
    openTransport: async () => createSimulatedTransport({ responder: () => device.answer })
  });
  const handle = { agent, device, lines, done: agent.run().then(() => null, (error) => error) };
  running.push(handle);
  return handle;
}

test("the agent claims jobs, runs them on the device, and the server derives pass/fail from verified evidence", { skip }, async () => {
  const workspaceId = await newWorkspace("agent-pass");
  const gateway = await newGateway(workspaceId, "lab");
  const { device, lines } = startAgent(gateway);

  const good = await queue(workspaceId, "good");
  const passed = await until(workspaceId, good.id, "passed");
  assert.equal(passed.summary.passed, 1); assert.equal(passed.agentVersion, AGENT_VERSION); assert.equal(passed.attempts, 1); assert.equal(passed.leaseExpiresAt, null);
  assert.equal((await admin(`${ws(workspaceId)}/test-jobs/${good.id}/junit.xml`)).status, 200);

  device.answer = ["ERROR"];
  const bad = await queue(workspaceId, "bad");
  assert.equal((await until(workspaceId, bad.id, "failed")).summary.failed, 1);

  const listed = (await admin(`${ws(workspaceId)}/gateways`)).body.find((item) => item.id === gateway.id);
  assert.equal(listed.online, true); assert.equal(listed.agentVersion, AGENT_VERSION); assert.deepEqual(listed.capabilities, { serialPorts: ["/dev/ttyTEST"] });
  assert.equal((await admin(`${ws(workspaceId)}/test-reports`)).body.length, 2);
  assert.ok(!JSON.stringify(lines).includes(gateway.token));
  assert.ok(!api.logs().includes(gateway.token));
});

test("cancelling a running job stops the agent promptly, and it goes on to take the next job", { skip }, async () => {
  const workspaceId = await newWorkspace("agent-cancel");
  const gateway = await newGateway(workspaceId, "lab");
  const { device, lines } = startAgent(gateway, { device: { answer: [] } });
  const slow = await queue(workspaceId, "slow", slowDefinition());
  await until(workspaceId, slow.id, "running");
  assert.equal((await admin(`${ws(workspaceId)}/test-jobs/${slow.id}/cancel`, { method: "POST" })).body.status, "cancelled");
  await waitFor(() => lines.find((line) => line.message === "run abandoned without reporting a result"), { message: "the agent to notice the cancellation" });
  assert.equal(lines.find((line) => line.message === "run abandoned without reporting a result").reason, "cancelled");
  assert.equal((await getJob(workspaceId, slow.id)).status, "cancelled", "the cancelled job is never overwritten by a late result");

  device.answer = ["READY"];
  assert.equal((await until(workspaceId, (await queue(workspaceId, "after-cancel")).id, "passed")).summary.passed, 1);
});

test("an agent that is stopped mid-job leaves it to the lease: the job is requeued and another agent finishes it", { skip }, async () => {
  const workspaceId = await newWorkspace("agent-restart");
  const gateway = await newGateway(workspaceId, "lab");
  const first = startAgent(gateway, { device: { answer: [] } });
  const job = await queue(workspaceId, "interrupted", slowDefinition());
  await until(workspaceId, job.id, "running");

  first.agent.stop();
  assert.equal(await first.done, null, "a graceful stop is not an error");
  assert.equal(first.lines.find((line) => line.message === "run abandoned without reporting a result").reason, "shutdown");
  assert.equal((await getJob(workspaceId, job.id)).status, "running", "nothing was reported, so the server still thinks the job is running");

  // The 5 s lease runs out, the sweeper requeues the job, and a fresh agent (a restarted service) completes it.
  const requeued = await until(workspaceId, job.id, "queued", 20_000);
  assert.equal(requeued.attempts, 1);
  startAgent(gateway, { device: { answer: ["READY"] } });
  const done = await until(workspaceId, job.id, "passed");
  assert.equal(done.attempts, 2); assert.equal(done.summary.passed, 1);
});

test("a revoked or rotated token stops the old agent with a fatal error; the new token works", { skip }, async () => {
  const workspaceId = await newWorkspace("agent-credentials");
  const gateway = await newGateway(workspaceId, "lab");
  const old = startAgent(gateway);
  await waitFor(async () => (await admin(`${ws(workspaceId)}/gateways`)).body[0].online, { message: "the gateway to come online" });

  const rotated = (await admin(`${ws(workspaceId)}/gateways/${gateway.id}/rotate`, { method: "POST" })).body;
  const error = await Promise.race([old.done, sleep(5000).then(() => "still running")]);
  assert.ok(error instanceof FatalAgentError, `expected a fatal error, got ${error}`);
  assert.match(error.message, /rejected the gateway token/); assert.ok(!error.message.includes(gateway.token));

  startAgent({ ...gateway, token: rotated.token });
  assert.equal((await until(workspaceId, (await queue(workspaceId, "rotated")).id, "passed")).summary.passed, 1);

  assert.equal((await admin(`${ws(workspaceId)}/gateways/${gateway.id}`, { method: "DELETE" })).status, 204);
  const revoked = running[running.length - 1];
  assert.ok(await Promise.race([revoked.done, sleep(5000).then(() => null)]) instanceof FatalAgentError, "revocation stops the agent too");
});

test("the heartbeat keeps the gateway online while a job outlasts several heartbeat intervals", { skip }, async () => {
  const workspaceId = await newWorkspace("agent-heartbeat");
  const gateway = await newGateway(workspaceId, "lab");
  startAgent(gateway, { device: { answer: [] } });
  const job = await queue(workspaceId, "long", sampleDefinition({ tests: [{ ...sampleDefinition().tests[0], timeoutMs: 2500 }] }));
  await until(workspaceId, job.id, "running");
  const beat = async () => (await admin(`${ws(workspaceId)}/gateways`)).body[0].lastHeartbeatAt;
  const before = await beat();
  await sleep(1200);
  const during = await beat();
  assert.ok(new Date(during) > new Date(before), "heartbeats continued while the job was running");
  assert.equal((await getJob(workspaceId, job.id)).status, "running");
  const finished = await until(workspaceId, job.id, "failed");
  assert.equal(finished.summary.failed, 1, "a device that never answers yields a failed (not lost) result");
});
