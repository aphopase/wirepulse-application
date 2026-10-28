import fs from "node:fs";
import { pathToFileURL } from "node:url";
import { AGENT_VERSION, runSuite } from "./engine.mjs";
import { openSerialTransport } from "./transports.mjs";

export class AgentConfigError extends Error {
  constructor(problems) { super(`Invalid gateway configuration:\n - ${problems.join("\n - ")}`); this.problems = problems; }
}
export class FatalAgentError extends Error {}

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);
const TOKEN_SHAPE = /^wpg_[A-Za-z0-9_-]{20,}$/;
const TOKEN_ANYWHERE = /\bwpg_[A-Za-z0-9_-]{8,}/g;

// Reads the environment into a validated configuration. The token never appears in an error message.
export function loadAgentConfig(env = process.env, { requireSerialPath = true } = {}) {
  const problems = [];
  const integer = (name, fallback, min, max) => {
    const raw = env[name];
    if (raw === undefined || raw === "") return fallback;
    const value = Number(raw);
    if (!Number.isInteger(value) || value < min || value > max) { problems.push(`${name} must be an integer between ${min} and ${max}`); return fallback; }
    return value;
  };

  let apiUrl = "";
  const rawUrl = env.WIREPULSE_API_URL ?? "";
  if (!rawUrl) problems.push("WIREPULSE_API_URL is required");
  else {
    try {
      const url = new URL(rawUrl);
      if (url.username || url.password) problems.push("WIREPULSE_API_URL must not contain credentials");
      if (url.protocol !== "https:" && !(url.protocol === "http:" && (LOCAL_HOSTS.has(url.hostname) || env.WIREPULSE_ALLOW_INSECURE_HTTP === "true"))) {
        problems.push("WIREPULSE_API_URL must use https (plain http is allowed only for localhost, or when WIREPULSE_ALLOW_INSECURE_HTTP=true on a trusted private network)");
      }
      apiUrl = `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
    } catch { problems.push("WIREPULSE_API_URL is not a valid URL"); }
  }

  let token = env.WIREPULSE_GATEWAY_TOKEN ?? "";
  if (env.WIREPULSE_GATEWAY_TOKEN_FILE) {
    try { token = fs.readFileSync(env.WIREPULSE_GATEWAY_TOKEN_FILE, "utf8").trim(); } catch (error) { problems.push(`WIREPULSE_GATEWAY_TOKEN_FILE (${env.WIREPULSE_GATEWAY_TOKEN_FILE}) cannot be read: ${error.code ?? "error"}`); }
  }
  if (!token) { if (!env.WIREPULSE_GATEWAY_TOKEN_FILE) problems.push("WIREPULSE_GATEWAY_TOKEN or WIREPULSE_GATEWAY_TOKEN_FILE is required"); }
  else if (!TOKEN_SHAPE.test(token)) problems.push("the gateway token is malformed (expected the wpg_… value shown once when the gateway was registered)");

  const serialPath = env.WIREPULSE_SERIAL_PATH ?? "";
  if (requireSerialPath && !serialPath) problems.push("WIREPULSE_SERIAL_PATH is required");

  const config = {
    apiUrl, token, serialPath,
    pollMs: integer("WIREPULSE_POLL_MS", 3000, 500, 60_000),
    leaseRenewMs: integer("WIREPULSE_LEASE_RENEW_MS", 15_000, 1000, 120_000),
    heartbeatMs: integer("WIREPULSE_HEARTBEAT_MS", 20_000, 5000, 60_000),
    requestTimeoutMs: integer("WIREPULSE_REQUEST_TIMEOUT_MS", 15_000, 1000, 120_000),
    maxBackoffMs: integer("WIREPULSE_MAX_BACKOFF_MS", 60_000, 1000, 600_000),
    shutdownGraceMs: integer("WIREPULSE_SHUTDOWN_GRACE_MS", 30_000, 0, 600_000)
  };
  if (problems.length) throw new AgentConfigError(problems);
  return Object.freeze(config);
}

// One JSON object per line on stdout; the token and anything shaped like one is masked.
export function createAgentLog({ write = (line) => process.stdout.write(line), secrets = [] } = {}) {
  const mask = (text) => secrets.filter(Boolean).reduce((acc, secret) => acc.split(secret).join("[redacted]"), String(text)).replace(TOKEN_ANYWHERE, "wpg_[redacted]");
  const emit = (level) => (message, fields = {}) => write(`${mask(JSON.stringify({ time: new Date().toISOString(), level, service: "wirepulse-gateway", message, ...fields }))}\n`);
  return { info: emit("info"), warn: emit("warn"), error: emit("error") };
}

const defaultSleep = (ms, signal) => new Promise((resolve) => {
  if (signal?.aborted) return resolve();
  const timer = setTimeout(done, ms);
  function done() { clearTimeout(timer); signal?.removeEventListener("abort", done); resolve(); }
  signal?.addEventListener("abort", done, { once: true });
});

export function createAgent({ config, openTransport, fetchImpl = fetch, log = createAgentLog({ secrets: [config.token] }), sleep = defaultSleep, random = Math.random }) {
  const stopping = new AbortController();
  const state = { fatal: null, leaseSeconds: 60, job: null };
  const backoff = (attempt) => { const ceiling = Math.min(config.maxBackoffMs, config.pollMs * 2 ** Math.min(attempt, 12)); return Math.floor(ceiling / 2 + random() * (ceiling / 2)); };

  // Never throws: status 0 means the server could not be reached (network error or timeout).
  async function request(path, body, { timeoutMs = config.requestTimeoutMs, signal } = {}) {
    const signals = [AbortSignal.timeout(timeoutMs), ...(signal ? [signal] : [])];
    try {
      const response = await fetchImpl(`${config.apiUrl}/gateway/v1${path}`, { method: "POST", headers: { authorization: `Bearer ${config.token}`, "content-type": "application/json" }, body: JSON.stringify(body ?? {}), signal: AbortSignal.any(signals) });
      const retryAfter = Number(response.headers.get("retry-after"));
      const retryAfterMs = Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter * 1000, config.maxBackoffMs) : 0;
      if (response.status === 204) return { status: 204, body: null, retryAfterMs };
      return { status: response.status, body: await response.json().catch(() => ({})), retryAfterMs };
    } catch (error) { return { status: 0, body: null, retryAfterMs: 0, error: error.cause?.code ?? error.name ?? "error" }; }
  }

  function fail(message) {
    if (!state.fatal) { state.fatal = new FatalAgentError(message); log.error(message, { fatal: true }); }
    stop("fatal");
    state.job?.abort("token_rejected"); // without a valid token no result can be delivered, so stop driving the device
  }
  const rejected = (response) => { if (response.status === 401) { fail("the control plane rejected the gateway token (revoked, expired, or rotated); install the new token and restart"); return true; } return false; };

  async function heartbeat() {
    const response = await request("/heartbeat", { agentVersion: AGENT_VERSION, capabilities: { serialPorts: config.serialPath ? [config.serialPath] : [] } }, { signal: stopping.signal });
    if (rejected(response)) return;
    if (response.status === 200) { if (Number.isInteger(response.body?.leaseSeconds)) state.leaseSeconds = response.body.leaseSeconds; return; }
    if (!stopping.signal.aborted) log.warn("heartbeat failed", { status: response.status, error: response.error });
  }

  // Delivers the result, retrying only failures that might be transient. 409 and 422 are final answers.
  async function deliver(job, payload) {
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      const response = await request(`/jobs/${job.id}/complete`, payload, { timeoutMs: config.requestTimeoutMs * 4 });
      if (response.status === 200) { log.info("job completed", { jobId: job.id, status: response.body?.status }); return "completed"; }
      if (rejected(response)) return "rejected";
      if (response.status === 409) { log.warn("result not accepted: the job is no longer active (cancelled or requeued)", { jobId: job.id }); return "not_active"; }
      if (response.status === 422) { log.error("result rejected by the control plane", { jobId: job.id, error: response.body?.error, reason: response.body?.reason }); return "rejected"; }
      if (response.status > 0 && response.status < 500 && response.status !== 429) { log.error("result rejected", { jobId: job.id, status: response.status }); return "rejected"; }
      if (attempt === 5) break;
      const wait = Math.max(backoff(attempt), response.retryAfterMs);
      log.warn("could not deliver the result; retrying", { jobId: job.id, status: response.status, error: response.error, retryInMs: wait });
      await sleep(wait);
    }
    log.error("result could not be delivered; the job will be requeued when its lease expires", { jobId: job.id });
    return "delivery_failed";
  }

  async function executeJob(job) {
    const tests = job.definition?.tests;
    if (!Array.isArray(tests)) { log.error("job definition has no tests; leaving it to expire", { jobId: job.id }); return "local_failure"; }
    const started = await request(`/jobs/${job.id}/start`);
    if (rejected(started)) return "rejected";
    if (started.status !== 200) { log.warn("job could not be started", { jobId: job.id, status: started.status, error: started.error }); return "not_started"; }

    const controller = new AbortController();
    let abortReason = null;
    const abortJob = (reason) => { abortReason ??= reason; controller.abort(); };
    state.job = { id: job.id, abort: abortJob };
    armGrace(); // a stop requested while the job was starting still gets only the grace period
    let latest = { completed: 0, total: tests.length };
    let leaseOkAt = Date.now();
    const renewMs = Math.min(config.leaseRenewMs, Math.max(1000, Math.floor((state.leaseSeconds * 1000) / 3)));
    let renewing = true;
    const renewLoop = (async () => {
      while (renewing) {
        await sleep(renewMs, controller.signal);
        if (!renewing || controller.signal.aborted) return;
        const response = await request(`/jobs/${job.id}/progress`, latest);
        if (response.status === 200) { leaseOkAt = Date.now(); continue; }
        if (rejected(response)) { abortJob("token_rejected"); return; }
        if (response.status === 409) { abortJob("cancelled"); return; }
        // The server requeues the job once the lease lapses; carrying on would double-drive the serial port.
        if (Date.now() - leaseOkAt > state.leaseSeconds * 1000) { abortJob("lease_lost"); return; }
        log.warn("lease renewal failed", { jobId: job.id, status: response.status, error: response.error });
      }
    })();

    let transport; let outcome;
    try {
      const profile = job.definition.profile ?? {};
      transport = await openTransport(profile.settings ?? {});
      const { results, evidence } = await runSuite({ tests, profile, transport, signal: controller.signal, onProgress: (progress) => { latest = progress; } });
      if (controller.signal.aborted) { log.warn("run abandoned without reporting a result", { jobId: job.id, reason: abortReason }); outcome = abortReason; }
      else outcome = await deliver(job, { results, evidence });
    } catch (error) {
      log.error("job failed locally; it will be requeued when its lease expires", { jobId: job.id, error: error.message });
      outcome = "local_failure";
    } finally {
      renewing = false; controller.abort(); state.job = null;
      await renewLoop;
      await Promise.resolve(transport?.close?.()).catch(() => {});
    }
    return outcome;
  }

  // Stops claiming work. A running job gets shutdownGraceMs to finish; after that it is abandoned (the lease requeues it).
  let graceTimer = null;
  function armGrace() {
    if (graceTimer || !state.job || !stopping.signal.aborted) return;
    graceTimer = setTimeout(() => state.job?.abort("shutdown"), config.shutdownGraceMs);
    graceTimer.unref?.();
  }
  function stop(reason = "requested") {
    if (stopping.signal.aborted) return;
    log.info("stopping", { reason, runningJob: state.job?.id ?? null });
    stopping.abort();
    armGrace();
  }

  async function run() {
    log.info("gateway agent starting", { agentVersion: AGENT_VERSION, apiUrl: config.apiUrl });
    await heartbeat();
    const beat = setInterval(() => { heartbeat(); }, config.heartbeatMs);
    let failures = 0;
    try {
      while (!stopping.signal.aborted) {
        const claim = await request("/jobs/claim", {}, { signal: stopping.signal });
        if (rejected(claim)) break;
        if (claim.status === 200) {
          if (stopping.signal.aborted) { log.warn("claimed a job while stopping; it will be requeued when its lease expires", { jobId: claim.body.id }); break; }
          log.info("job claimed", { jobId: claim.body.id, attempt: claim.body.attempts });
          const outcome = await executeJob(claim.body);
          failures = ["local_failure", "delivery_failed", "not_started"].includes(outcome) ? failures + 1 : 0;
          if (!failures) continue;
        } else if (claim.status === 204) failures = 0;
        else if (!stopping.signal.aborted) { failures += 1; log.warn("claim failed", { status: claim.status, error: claim.error }); }
        await sleep(failures ? Math.max(backoff(failures), claim.retryAfterMs ?? 0) : config.pollMs, stopping.signal);
      }
    } finally { clearInterval(beat); clearTimeout(graceTimer); }
    log.info("gateway agent stopped");
    if (state.fatal) throw state.fatal;
  }

  return { run, stop, executeJob, heartbeat, request, state };
}

export async function main(env = process.env) {
  let config;
  try { config = loadAgentConfig(env); } catch (error) {
    if (error instanceof AgentConfigError) { console.error(error.message); return 1; }
    throw error;
  }
  const log = createAgentLog({ secrets: [config.token] });
  if (config.apiUrl.startsWith("http:") && !LOCAL_HOSTS.has(new URL(config.apiUrl).hostname)) log.warn("traffic to the control plane is not encrypted (WIREPULSE_ALLOW_INSECURE_HTTP=true)");
  const agent = createAgent({
    config, log,
    openTransport: (settings) => openSerialTransport({ path: config.serialPath, baudRate: Number(settings.baud) || 115200, dataBits: settings.dataBits ?? 8, stopBits: settings.stopBits ?? 1, parity: settings.parity ?? "none", ending: settings.ending ?? "\n", rtscts: settings.flow === "hardware" })
  });
  let signals = 0;
  const onSignal = (name) => () => {
    signals += 1;
    if (signals > 1) { log.warn("second signal received; exiting immediately"); process.exit(1); }
    agent.stop(name);
    setTimeout(() => { log.error("shutdown timed out"); process.exit(1); }, config.shutdownGraceMs + 15_000).unref();
  };
  process.on("SIGTERM", onSignal("SIGTERM")); process.on("SIGINT", onSignal("SIGINT"));
  try { await agent.run(); return 0; } catch (error) { if (!(error instanceof FatalAgentError)) log.error("gateway agent crashed", { error: error.message }); return 1; }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().then((code) => process.exit(code));
