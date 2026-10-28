import test from "node:test";
import assert from "node:assert/strict";
import { runSuite, lineMatches } from "../src/engine.mjs";
import { createSimulatedTransport } from "../src/transports.mjs";
import { verifyEvidence } from "../../api/src/evidence.mjs";

const suite = (overrides = {}) => [{ id: "t1", name: "ready", commands: "status", expectedText: "READY", telemetryToken: "", telemetryOperator: ">=", telemetryValue: "", timeoutMs: 300, retries: 0, ...overrides }];

test("passing run produces evidence the control plane verifies", async () => {
  const transport = createSimulatedTransport({ responder: () => ["ACK-7731"] });
  const { results, evidence } = await runSuite({ tests: suite({ commands: "probe-4412", expectedText: "ACK-7731" }), transport });
  assert.deepEqual(results, [{ testId: "t1", status: "passed", attempts: 1 }]);
  assert.equal(verifyEvidence(evidence, results).valid, true);
  const serialized = JSON.stringify(evidence);
  assert.ok(!serialized.includes("ACK-7731") && !serialized.includes("probe-4412"));
});

test("a response that arrived before the command is rejected as stale", async () => {
  const transport = createSimulatedTransport({ responder: () => [] });
  transport.injectStale("READY");
  const { results, evidence } = await runSuite({ tests: suite(), transport });
  assert.equal(results[0].status, "failed");
  assert.equal(verifyEvidence(evidence, results).valid, true);
  assert.ok(evidence.events.some((event) => event.type === "attempt.timed_out"));
});

test("retries open a fresh response window and can pass on a later attempt", async () => {
  let calls = 0;
  const transport = createSimulatedTransport({ responder: () => (++calls === 2 ? ["READY"] : []) });
  const { results, evidence } = await runSuite({ tests: suite({ retries: 1 }), transport });
  assert.deepEqual(results[0], { testId: "t1", status: "passed", attempts: 2 });
  assert.equal(verifyEvidence(evidence, results).valid, true);
});

test("aborting yields a verifiable run.stopped ledger", async () => {
  const controller = new AbortController();
  const transport = createSimulatedTransport({ responder: () => [] });
  setTimeout(() => controller.abort(), 50);
  const { results, evidence } = await runSuite({ tests: suite({ timeoutMs: 5000 }), transport, signal: controller.signal });
  assert.equal(evidence.events.at(-1).type, "run.stopped");
  assert.equal(results[0].status, "not-run");
  assert.equal(verifyEvidence(evidence, results).valid, true);
});

test("telemetry operators compare numbers sent by the device", () => {
  const t = { expectedText: "", telemetryToken: "VOLTAGE", telemetryOperator: ">=", telemetryValue: "3.3" };
  assert.equal(lineMatches(t, "VOLTAGE: 3.5"), true);
  assert.equal(lineMatches(t, "VOLTAGE: 3.0"), false);
  assert.equal(lineMatches(t, "nothing"), false);
});
