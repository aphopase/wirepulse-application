import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { canonicalize, verifyEvidence } from "../src/evidence.mjs";

function digest(value) { return crypto.createHash("sha256").update(value).digest("hex"); }
function validEvidence() {
  const fingerprints = { suite: "1".repeat(64), profile: "2".repeat(64), engine: "3".repeat(64) };
  const rootHash = digest(canonicalize({ schema: "wirepulse.test-evidence.v1", fingerprints }));
  const events = [];
  let previousHash = rootHash;
  for (const [type, payload] of [
    ["run.started", { testCount: 1 }],
    ["run.finished", { results: [{ testId: "test-1", status: "passed", attempts: 1 }] }]
  ]) {
    const event = { sequence: events.length + 1, at: 1_700_000_000_000 + events.length, type, payload, previousHash };
    const hash = digest(canonicalize(event));
    events.push({ ...event, hash });
    previousHash = hash;
  }
  return { schema: "wirepulse.test-evidence.v1", evidenceId: "a83b53b2-6cd9-45f0-a01e-9d1937d7dcc2", createdAt: "2026-10-23T00:00:00.000Z", fingerprints, rootHash, events, finalHash: previousHash };
}

test("accepts a valid privacy-preserving evidence chain", () => {
  const result = verifyEvidence(validEvidence(), [{ testId: "test-1", status: "passed", attempts: 1 }]);
  assert.deepEqual(result, { valid: true, eventCount: 2, finalHash: validEvidence().finalHash });
});

test("rejects an altered evidence payload", () => {
  const evidence = validEvidence();
  evidence.events[0].payload.testCount = 2;
  assert.equal(verifyEvidence(evidence, [{ testId: "test-1", status: "passed", attempts: 1 }]).valid, false);
  assert.equal(verifyEvidence(evidence, [{ testId: "test-1", status: "passed", attempts: 1 }]).reason, "event_hash_invalid");
});

test("rejects a raw serial payload", () => {
  const evidence = validEvidence();
  evidence.events[0].payload.rawBytes = "52 45 41 44 59";
  assert.equal(verifyEvidence(evidence, [{ testId: "test-1", status: "passed", attempts: 1 }]).valid, false);
  assert.equal(verifyEvidence(evidence, [{ testId: "test-1", status: "passed", attempts: 1 }]).reason, "event_shape_invalid");
});

test("rejects a report result that differs from the completed evidence", () => {
  assert.equal(verifyEvidence(validEvidence(), [{ testId: "test-1", status: "failed", attempts: 1 }]).valid, false);
  assert.equal(verifyEvidence(validEvidence(), [{ testId: "test-1", status: "failed", attempts: 1 }]).reason, "evidence_lifecycle_invalid");
});
