import crypto from "node:crypto";

export const AGENT_VERSION = "0.1.0";
const SCHEMA = "wirepulse.test-evidence.v1";

export function canonicalize(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalize(value[key])}`).join(",")}}`;
}
const sha256 = (value) => crypto.createHash("sha256").update(value).digest("hex");

function assertionKind(test) { return test.telemetryToken?.trim() ? "telemetry" : test.expectedText?.trim() ? "text" : "any"; }

export function lineMatches(test, text) {
  const textOk = !test.expectedText?.trim() || text.toLowerCase().includes(test.expectedText.trim().toLowerCase());
  if (!test.telemetryToken?.trim() || !test.telemetryValue?.trim()) return textOk;
  const token = test.telemetryToken.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`${token}\\s*[:=]\\s*(-?\\d+(?:\\.\\d+)?)`, "i").exec(text);
  if (!match) return false;
  const actual = Number(match[1]); const expected = Number(test.telemetryValue);
  const telemetryOk = test.telemetryOperator === "<=" ? actual <= expected : test.telemetryOperator === "=" ? actual === expected : actual >= expected;
  return textOk && telemetryOk;
}

class Ledger {
  constructor(fingerprints) {
    this.fingerprints = fingerprints;
    this.rootHash = sha256(canonicalize({ schema: SCHEMA, fingerprints }));
    this.latest = this.rootHash;
    this.events = [];
  }
  append(type, payload) {
    const event = { sequence: this.events.length + 1, at: Date.now(), type, payload, previousHash: this.latest };
    const hash = sha256(canonicalize(event));
    this.events.push({ ...event, hash });
    this.latest = hash;
  }
  bundle() { return { schema: SCHEMA, evidenceId: crypto.randomUUID(), createdAt: new Date().toISOString(), fingerprints: this.fingerprints, rootHash: this.rootHash, events: this.events, finalHash: this.latest }; }
}

function waitForResponse(transport, test, window, timeoutMs, signal) {
  return new Promise((resolve) => {
    const state = { stale: 0, response: null };
    const finish = (matched) => { clearTimeout(timer); unsubscribe(); signal?.removeEventListener("abort", onAbort); resolve({ matched, ...state }); };
    const onAbort = () => finish(false);
    const unsubscribe = transport.subscribe((line) => {
      if (line.rxSequence <= window.startRxSequence || line.at < window.startAt) { state.stale += 1; return; }
      if (lineMatches(test, line.text)) { state.response = { firstChunkSequence: line.rxSequence, lastChunkSequence: line.rxSequence, byteLength: line.byteLength, observedAt: line.at }; finish(true); }
    });
    const timer = setTimeout(() => finish(false), timeoutMs);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

// Runs a suite against a transport and returns results plus a hash-linked evidence bundle
// that the control plane verifies. Raw serial text never enters the evidence.
export async function runSuite({ tests, profile = {}, transport, signal, onProgress = () => {} }) {
  const ledger = new Ledger({ suite: sha256(canonicalize(tests)), profile: sha256(canonicalize(profile)), engine: sha256(canonicalize({ engine: "wirepulse-gateway-engine", schema: SCHEMA, version: 1 })) });
  const results = tests.map((test) => ({ testId: String(test.id), status: "not-run", attempts: 0 }));
  ledger.append("run.started", { testCount: tests.length });
  let stopped = false;
  for (let index = 0; index < tests.length && !stopped; index += 1) {
    const test = tests[index];
    const timeoutMs = Math.max(100, Number(test.timeoutMs) || 2000);
    const retries = Math.max(0, Math.min(10, Number(test.retries) || 0));
    for (let attempt = 1; attempt <= retries + 1; attempt += 1) {
      if (signal?.aborted) { stopped = true; break; }
      results[index].attempts = attempt;
      const startRxSequence = transport.rxSequence();
      ledger.append("attempt.started", { testId: results[index].testId, attempt, timeoutMs, retries, responseStartRxSequence: startRxSequence });
      for (const command of String(test.commands ?? "").split(/\r?\n/).map((item) => item.trim()).filter(Boolean)) {
        const receipt = await transport.send(command);
        ledger.append("command.transmitted", { testId: results[index].testId, attempt, commandSequence: receipt.sequence, byteLength: receipt.byteLength, transmittedAt: receipt.at });
      }
      const startAt = Date.now();
      const window = { startAt, startRxSequence: transport.rxSequence() };
      ledger.append("response.window.opened", { testId: results[index].testId, attempt, startAt, startRxSequence: window.startRxSequence, deadline: startAt + timeoutMs });
      const outcome = await waitForResponse(transport, test, window, timeoutMs, signal);
      if (signal?.aborted) { stopped = true; break; }
      if (!outcome.matched) ledger.append("attempt.timed_out", { testId: results[index].testId, attempt, deadline: startAt + timeoutMs, staleLinesRejected: outcome.stale });
      if (outcome.matched || attempt > retries) {
        results[index].status = outcome.matched ? "passed" : "failed";
        ledger.append("assertion.completed", { testId: results[index].testId, attempt, status: results[index].status, assertionKind: assertionKind(test), response: outcome.response, staleLinesRejected: outcome.stale });
        break;
      }
    }
    onProgress({ completed: index + 1, total: tests.length });
  }
  ledger.append(stopped ? "run.stopped" : "run.finished", { results });
  return { results, evidence: ledger.bundle() };
}
