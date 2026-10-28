#!/usr/bin/env node
// Load and integrity check for a running WirePulse control plane (one instance or many behind a load balancer).
//   node scripts/loadtest.mjs --url http://127.0.0.1:8080 --token <bearer> [--seconds 20] [--workspaces 2] [--gateways 6] [--submitters 8] [--readers 8]
// The token is an administrator's (the OIDC access token, or DEV_BEARER_TOKEN on a development deployment) and may also come from
// WP_TOKEN. It creates its own workspaces ("loadtest-<id>"), and leaves them behind: offboard them afterwards if the target matters.
//
// Each workspace gets simulated gateways that claim, start and complete jobs with real, verifiable evidence (the gateway's engine
// runs a one-test suite against a simulated device), while submitters queue jobs and readers poll lists and usage. Afterwards the
// script checks what matters more than speed: every submitted job was handed out once and ended `passed`, no response was a 5xx,
// and each workspace's audit hash chain still verifies. The exit code is 1 if any of that failed. Latencies are measured by this
// process on the machine it runs on; treat them as a baseline for one setup, not as a capacity promise.
import crypto from "node:crypto";
import { runSuite } from "../gateway/src/engine.mjs";
import { createSimulatedTransport } from "../gateway/src/transports.mjs";

const options = {};
for (let i = 2; i < process.argv.length; i += 1) {
  const arg = process.argv[i];
  if (!arg.startsWith("--")) { console.error(`unexpected argument ${arg}`); process.exit(2); }
  options[arg.slice(2)] = process.argv[i + 1]?.startsWith("--") || process.argv[i + 1] === undefined ? "true" : process.argv[++i];
}
const number = (name, fallback) => { const value = Number(options[name] ?? fallback); if (!Number.isInteger(value) || value < 1) { console.error(`--${name} must be a positive integer`); process.exit(2); } return value; };
const base = (options.url ?? "").replace(/\/+$/, "");
const adminToken = options.token ?? process.env.WP_TOKEN;
if (!/^https?:\/\//.test(base) || !adminToken) { console.error("usage: loadtest.mjs --url http://host:port --token <bearer> [--seconds 20] [--workspaces 2] [--gateways 6] [--submitters 8] [--readers 8]"); process.exit(2); }
const SECONDS = number("seconds", 20); const WORKSPACES = number("workspaces", 2); const GATEWAYS = number("gateways", 6);
const SUBMITTERS = number("submitters", 8); const READERS = number("readers", 8);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const samples = new Map(); const statuses = new Map();
function record(label, ms, status) {
  if (ms !== null) (samples.get(label) ?? samples.set(label, []).get(label)).push(ms);
  const tally = statuses.get(label) ?? statuses.set(label, {}).get(label);
  tally[status] = (tally[status] ?? 0) + 1;
}
async function call(label, path, { method = "GET", body, token = adminToken } = {}) {
  const started = performance.now();
  try {
    const response = await fetch(base + path, { method, headers: { authorization: `Bearer ${token}`, ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const text = await response.text();
    record(label, performance.now() - started, response.status);
    let parsed = null; try { parsed = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
    return { status: response.status, body: parsed, headers: response.headers };
  } catch (error) {
    record(label, null, "network"); return { status: 0, body: null, headers: new Headers(), error };
  }
}

const definition = { tests: [{ id: "t1", name: "ready", commands: "status", expectedText: "READY", telemetryToken: "", telemetryOperator: ">=", telemetryValue: "", timeoutMs: 500, retries: 0 }], profile: { settings: { baud: "115200" } } };
const { results, evidence } = await runSuite({ tests: definition.tests, profile: definition.profile, transport: createSimulatedTransport({ responder: () => ["READY"] }) });

const runId = crypto.randomBytes(3).toString("hex");
const workspaces = [];
for (let w = 0; w < WORKSPACES; w += 1) {
  const created = await call("setup", "/v1/workspaces", { method: "POST", body: { name: `loadtest-${runId}-${w}` } });
  if (created.status !== 201) { console.error(`cannot create a workspace: HTTP ${created.status} ${JSON.stringify(created.body)}`); process.exit(1); }
  const gateways = [];
  for (let g = 0; g < GATEWAYS; g += 1) {
    const gateway = await call("setup", `/v1/workspaces/${created.body.id}/gateways`, { method: "POST", body: { name: `gw-${g}` } });
    if (gateway.status !== 201) { console.error(`cannot create a gateway: HTTP ${gateway.status} ${JSON.stringify(gateway.body)}`); process.exit(1); }
    gateways.push(gateway.body.token);
  }
  workspaces.push({ id: created.body.id, gateways, submitted: new Set() });
}

const startedAt = Date.now(); const deadline = startedAt + SECONDS * 1000; const hardStop = deadline + 90_000;
const claimed = new Set(); let duplicateClaims = 0; let completed = 0; let submittedOk = 0; let submitting = SUBMITTERS; let sequence = 0;

async function submitter(index) {
  while (Date.now() < deadline) {
    const workspace = workspaces[(index + sequence) % workspaces.length];
    const key = `${runId}-${sequence++}`;
    const response = await call("job.submit", `/v1/workspaces/${workspace.id}/test-jobs`, { method: "POST", body: { definition, idempotencyKey: key } });
    if (response.status === 201) { workspace.submitted.add(response.body.id); submittedOk += 1; } else await sleep(response.status === 429 ? 250 : 50);
  }
  submitting -= 1;
}
async function reader(index) {
  while (Date.now() < deadline) {
    const workspace = workspaces[(index + sequence) % workspaces.length];
    await call("read.jobs", `/v1/workspaces/${workspace.id}/test-jobs?limit=20`);
    await call("read.usage", `/v1/workspaces/${workspace.id}/usage`);
    await sleep(20);
  }
}
async function gateway(token) {
  while (Date.now() < hardStop) {
    if (submitting === 0 && claimed.size >= submittedOk) return;
    const claim = await call("gateway.claim", "/gateway/v1/jobs/claim", { method: "POST", token });
    if (claim.status !== 200) { await sleep(claim.status === 204 ? 25 : 100); continue; }
    const id = claim.body.id;
    if (claimed.has(id)) duplicateClaims += 1;
    claimed.add(id);
    await call("gateway.start", `/gateway/v1/jobs/${id}/start`, { method: "POST", token });
    const done = await call("gateway.complete", `/gateway/v1/jobs/${id}/complete`, { method: "POST", body: { results, evidence }, token });
    if (done.status === 200) completed += 1;
  }
}

await Promise.all([
  ...Array.from({ length: SUBMITTERS }, (_, i) => submitter(i)),
  ...Array.from({ length: READERS }, (_, i) => reader(i)),
  ...workspaces.flatMap((workspace) => workspace.gateways.map((token) => gateway(token)))
]);
const elapsed = (Date.now() - startedAt) / 1000;

// What the server says happened, not what this process remembers.
const problems = [];
const serverView = [];
for (const workspace of workspaces) {
  const tally = {}; let seen = 0; let cursor = null;
  do {
    const page = await call("verify.jobs", `/v1/workspaces/${workspace.id}/test-jobs?limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);
    if (page.status !== 200) { problems.push(`listing jobs of ${workspace.id} failed with HTTP ${page.status}`); break; }
    for (const job of page.body) { tally[job.status] = (tally[job.status] ?? 0) + 1; seen += 1; if (!workspace.submitted.has(job.id)) problems.push(`job ${job.id} is not one this run submitted`); }
    cursor = page.headers.get("x-next-cursor");
  } while (cursor);
  const audit = await call("verify.audit", `/v1/workspaces/${workspace.id}/audit/verify`);
  serverView.push({ workspaceId: workspace.id, submitted: workspace.submitted.size, listed: seen, statuses: tally, auditValid: audit.body?.valid ?? false, auditEventsChecked: audit.body?.checked ?? 0 });
  if (seen !== workspace.submitted.size) problems.push(`workspace ${workspace.id}: submitted ${workspace.submitted.size}, the server lists ${seen}`);
  if ((tally.passed ?? 0) !== workspace.submitted.size) problems.push(`workspace ${workspace.id}: ${tally.passed ?? 0} of ${workspace.submitted.size} jobs passed (${JSON.stringify(tally)})`);
  if (audit.body?.valid !== true) problems.push(`workspace ${workspace.id}: the audit chain does not verify (${JSON.stringify(audit.body)})`);
}
if (duplicateClaims) problems.push(`${duplicateClaims} jobs were handed out twice`);
if (completed !== submittedOk) problems.push(`${submittedOk} jobs submitted, ${completed} completed`);
for (const [label, tally] of statuses) {
  if (label === "setup") continue;
  for (const [status, count] of Object.entries(tally)) if (status === "network" || Number(status) >= 500) problems.push(`${label}: ${count} responses were ${status}`);
}

const percentile = (sorted, p) => sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];
const rows = [...samples].filter(([label]) => label !== "setup" && label !== "verify.jobs" && label !== "verify.audit").map(([label, values]) => {
  const sorted = [...values].sort((a, b) => a - b);
  return { operation: label, requests: sorted.length, perSecond: Number((sorted.length / elapsed).toFixed(1)), p50ms: Math.round(percentile(sorted, 50)), p95ms: Math.round(percentile(sorted, 95)), p99ms: Math.round(percentile(sorted, 99)), maxMs: Math.round(sorted.at(-1)), statuses: statuses.get(label) };
}).sort((a, b) => a.operation.localeCompare(b.operation));
console.log(`target ${base}: ${SECONDS}s of load (${elapsed.toFixed(1)}s including the drain), ${WORKSPACES} workspaces x ${GATEWAYS} gateways, ${SUBMITTERS} submitters, ${READERS} readers`);
console.table(rows.map(({ statuses: tally, ...row }) => ({ ...row, statuses: JSON.stringify(tally) })));
console.log(`jobs submitted ${submittedOk}, completed ${completed}, handed out twice ${duplicateClaims}, completed per second ${(completed / elapsed).toFixed(1)}`);
for (const view of serverView) console.log(`workspace ${view.workspaceId}: ${view.listed}/${view.submitted} listed, ${JSON.stringify(view.statuses)}, audit chain ${view.auditValid ? "valid" : "BROKEN"} (${view.auditEventsChecked} events)`);
console.log(`RESULT ${JSON.stringify({ ok: problems.length === 0, seconds: SECONDS, submitted: submittedOk, completed, duplicateClaims, jobsPerSecond: Number((completed / elapsed).toFixed(1)), operations: rows })}`);
if (problems.length) { console.error(`FAILED:\n- ${problems.join("\n- ")}`); process.exit(1); }
