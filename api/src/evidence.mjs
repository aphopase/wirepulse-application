import crypto from "node:crypto";

const HASH = /^[a-f0-9]{64}$/;
const TYPES = new Set(["run.started", "attempt.started", "command.transmitted", "response.window.opened", "assertion.completed", "attempt.timed_out", "run.finished", "run.stopped"]);

export function canonicalize(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalize(value[key])}`).join(",")}}`;
}

function hash(value) { return crypto.createHash("sha256").update(value).digest("hex"); }
function hasOnlyKeys(value, keys) { return value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).every((key) => keys.has(key)); }
function isInteger(value) { return Number.isInteger(value) && value >= 0; }
function isResult(result) { return hasOnlyKeys(result, new Set(["testId", "status", "attempts"])) && typeof result.testId === "string" && ["passed", "failed", "not-run"].includes(result.status) && isInteger(result.attempts); }
function sameResults(left, right) { return left.length === right.length && left.every((item, index) => item.testId === right[index]?.testId && item.status === right[index]?.status && item.attempts === right[index]?.attempts); }

function payloadIsPrivateAndValid(type, payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return false;
  switch (type) {
    case "run.started": return hasOnlyKeys(payload, new Set(["testCount"])) && isInteger(payload.testCount);
    case "attempt.started": return hasOnlyKeys(payload, new Set(["testId", "attempt", "timeoutMs", "retries", "responseStartRxSequence"])) && typeof payload.testId === "string" && isInteger(payload.attempt) && isInteger(payload.timeoutMs) && isInteger(payload.retries) && isInteger(payload.responseStartRxSequence);
    case "command.transmitted": return hasOnlyKeys(payload, new Set(["testId", "attempt", "commandSequence", "byteLength", "transmittedAt"])) && typeof payload.testId === "string" && isInteger(payload.attempt) && isInteger(payload.commandSequence) && isInteger(payload.byteLength) && isInteger(payload.transmittedAt);
    case "response.window.opened": return hasOnlyKeys(payload, new Set(["testId", "attempt", "startAt", "startRxSequence", "deadline"])) && typeof payload.testId === "string" && isInteger(payload.attempt) && isInteger(payload.startAt) && isInteger(payload.startRxSequence) && isInteger(payload.deadline);
    case "assertion.completed": {
      if (!hasOnlyKeys(payload, new Set(["testId", "attempt", "status", "assertionKind", "response", "staleLinesRejected"]))) return false;
      const response = payload.response;
      return typeof payload.testId === "string" && isInteger(payload.attempt) && ["passed", "failed"].includes(payload.status) && ["text", "telemetry", "any"].includes(payload.assertionKind) && isInteger(payload.staleLinesRejected) && (response === null || (hasOnlyKeys(response, new Set(["firstChunkSequence", "lastChunkSequence", "byteLength", "observedAt"])) && isInteger(response.firstChunkSequence) && isInteger(response.lastChunkSequence) && isInteger(response.byteLength) && isInteger(response.observedAt)));
    }
    case "attempt.timed_out": return hasOnlyKeys(payload, new Set(["testId", "attempt", "deadline", "staleLinesRejected"])) && typeof payload.testId === "string" && isInteger(payload.attempt) && isInteger(payload.deadline) && isInteger(payload.staleLinesRejected);
    case "run.finished":
    case "run.stopped": return hasOnlyKeys(payload, new Set(["results"])) && Array.isArray(payload.results) && payload.results.every(isResult);
    default: return false;
  }
}

export function verifyEvidence(evidence, expectedResults) {
  if (!evidence || typeof evidence !== "object" || Array.isArray(evidence)) return { valid: false, reason: "evidence_missing" };
  const { schema, evidenceId, createdAt, fingerprints, rootHash, events, finalHash } = evidence;
  if (schema !== "wirepulse.test-evidence.v1" || typeof evidenceId !== "string" || typeof createdAt !== "string" || !hasOnlyKeys(fingerprints, new Set(["suite", "profile", "engine"])) || ![fingerprints.suite, fingerprints.profile, fingerprints.engine, rootHash, finalHash].every((value) => typeof value === "string" && HASH.test(value)) || !Array.isArray(events) || events.length < 2) return { valid: false, reason: "evidence_shape_invalid" };
  const expectedRoot = hash(canonicalize({ schema, fingerprints }));
  if (rootHash !== expectedRoot) return { valid: false, reason: "root_hash_invalid" };
  let previousHash = rootHash;
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index];
    if (!event || typeof event !== "object" || !TYPES.has(event.type) || event.sequence !== index + 1 || !isInteger(event.at) || event.previousHash !== previousHash || typeof event.hash !== "string" || !HASH.test(event.hash) || !payloadIsPrivateAndValid(event.type, event.payload)) return { valid: false, reason: "event_shape_invalid" };
    const expectedHash = hash(canonicalize({ sequence: event.sequence, at: event.at, type: event.type, payload: event.payload, previousHash: event.previousHash }));
    if (event.hash !== expectedHash) return { valid: false, reason: "event_hash_invalid" };
    previousHash = event.hash;
  }
  const completedResults = events.at(-1)?.payload?.results;
  if (events[0].type !== "run.started" || !["run.finished", "run.stopped"].includes(events.at(-1).type) || finalHash !== previousHash || !Array.isArray(expectedResults) || !sameResults(completedResults, expectedResults)) return { valid: false, reason: "evidence_lifecycle_invalid" };
  return { valid: true, eventCount: events.length, finalHash };
}
