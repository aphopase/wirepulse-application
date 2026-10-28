import test from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { startAnchoring } from "../src/anchor.mjs";
import { DEV_TOKEN, createClient, createTestDatabase, skip, startApi, ws } from "./helpers.mjs";

let database; let api; let pool; let admin; let anchoring;
const config = (auditDays = 0) => ({ anchorIntervalMinutes: 5, retention: { auditDays } });

test.before(async () => {
  if (skip) return;
  database = await createTestDatabase();
  api = await startApi({ databaseUrl: database.url });
  pool = new pg.Pool({ connectionString: database.url, max: 3 });
  admin = createClient(api.url, DEV_TOKEN);
  anchoring = startAnchoring({ db: api.db, config: config(), log: api.log, metrics: api.instance.metrics });
});
test.after(async () => { anchoring?.stop(); await api?.stop(); await pool?.end(); await database?.drop(); });

const newWorkspace = async (name) => (await admin("/v1/workspaces", { method: "POST", body: { name } })).body.id;
// Each API-key creation appends one audit event.
let keyCounter = 0;
const addEvents = async (workspaceId, count) => { for (let i = 0; i < count; i++) assert.equal((await admin(`${ws(workspaceId)}/api-keys`, { method: "POST", body: { name: `k${keyCounter++}`, role: "viewer" } })).status, 201); };
const outcome = (outcomes, workspaceId) => outcomes.find((item) => item.workspaceId === workspaceId);
const anchorsOf = async (workspaceId) => (await pool.query("SELECT seq::int AS seq, head_hash FROM audit_anchors WHERE workspace_id = $1 ORDER BY seq", [workspaceId])).rows;
const head = async (workspaceId) => (await admin(`${ws(workspaceId)}/audit/verify`)).body;
const logged = (event, workspaceId) => api.logEntries().filter((entry) => entry.event === event && entry.workspaceId === workspaceId);

// Rewrites history the way someone with direct database access would: the append-only guard is switched off for the edit.
async function tamper(statement, params = []) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("ALTER TABLE audit_events DISABLE TRIGGER audit_events_append_only");
    await client.query(statement, params);
    await client.query("ALTER TABLE audit_events ENABLE TRIGGER audit_events_append_only");
    await client.query("COMMIT");
  } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
}

test("anchors the head of each audit chain, logs it, and only moves when the chain does", { skip }, async () => {
  const first = await newWorkspace("anchor-one"); const second = await newWorkspace("anchor-two");
  await addEvents(first, 2);
  const run = await anchoring.runOnce();
  const verified = await head(first);
  assert.equal(outcome(run, first).result, "anchored"); assert.equal(outcome(run, first).seq, verified.lastSeq);
  assert.equal(outcome(run, second).result, "anchored");
  assert.deepEqual(await anchorsOf(first), [{ seq: verified.lastSeq, head_hash: verified.headHash }], "the anchor is the verified head of the chain");
  const line = logged("audit.anchor", first)[0];
  assert.equal(line.seq, verified.lastSeq); assert.equal(line.headHash, verified.headHash, "a copy of the anchor is in the log, outside the database");

  const quiet = await anchoring.runOnce();
  assert.ok(quiet.every((item) => item.result === "verified"), "an unchanged chain is re-checked, not re-anchored");
  assert.equal((await anchorsOf(first)).length, 1); assert.equal(logged("audit.anchor", first).length, 1);

  await addEvents(first, 1);
  const moved = await anchoring.runOnce();
  assert.equal(outcome(moved, first).result, "anchored"); assert.equal(outcome(moved, first).seq, verified.lastSeq + 1); assert.equal(outcome(moved, second).result, "verified");
  assert.equal((await anchorsOf(first)).length, 2);
  assert.match(await api.instance.metrics.registry.metrics(), /wirepulse_audit_anchors_total\{result="anchored"\} [1-9]/);

  // Only the newest anchors are kept.
  for (let i = 0; i < 24; i++) { await addEvents(first, 1); await anchoring.runOnce(); }
  const kept = await anchorsOf(first);
  assert.equal(kept.length, 20); assert.equal(kept.at(-1).seq, (await head(first)).lastSeq);
});

test("only one instance anchors at a time", { skip }, async () => {
  const workspaceId = await newWorkspace("anchor-leader");
  const other = new pg.Client({ connectionString: database.url });
  await other.connect();
  try {
    // Another instance is part-way through a cycle: it holds the lock for the length of its transaction.
    await other.query("BEGIN"); await other.query("SELECT pg_advisory_xact_lock(727277)");
    assert.equal(await anchoring.runOnce(), null, "skips the cycle instead of waiting or doing the work twice");
    assert.deepEqual(await anchorsOf(workspaceId), []);
    await other.query("COMMIT");
  } finally { await other.end(); }
  assert.equal(outcome(await anchoring.runOnce(), workspaceId).result, "anchored");
});

test("a failure on one workspace does not stop the others from being anchored", { skip }, async () => {
  const poisoned = await newWorkspace("anchor-poisoned"); const healthy = await newWorkspace("anchor-healthy");
  await pool.query(`ALTER TABLE audit_anchors ADD CONSTRAINT poison CHECK (workspace_id <> '${poisoned}')`);
  try {
    const run = await anchoring.runOnce();
    assert.equal(outcome(run, poisoned).result, "error"); assert.equal(outcome(run, healthy).result, "anchored");
    assert.deepEqual(await anchorsOf(poisoned), []); assert.equal((await anchorsOf(healthy)).length, 1);
  } finally { await pool.query("ALTER TABLE audit_anchors DROP CONSTRAINT poison"); }
  assert.equal(outcome(await anchoring.runOnce(), poisoned).result, "anchored", "recovers once the cause is gone");
});

test("rewriting an anchored row is caught even when the chain is recomputed to look consistent", { skip }, async () => {
  const workspaceId = await newWorkspace("anchor-rewrite");
  await addEvents(workspaceId, 2);
  await anchoring.runOnce();
  const [anchor] = await anchorsOf(workspaceId);
  await tamper(
    `UPDATE audit_events SET details = '{"forged":true}'::jsonb,
       row_hash = wirepulse_audit_hash(prev_hash, chain_seq, workspace_id, actor_subject, action, resource_type, resource_id, request_id, ip_address, '{"forged":true}'::jsonb, created_at)
     WHERE workspace_id = $1 AND chain_seq = $2`, [workspaceId, anchor.seq]);
  assert.equal((await head(workspaceId)).valid, true, "the chain verifies on its own: this is exactly what only an anchor can catch");
  const run = await anchoring.runOnce();
  const result = outcome(run, workspaceId);
  assert.equal(result.result, "mismatch"); assert.equal(result.reason, "hash_changed"); assert.equal(result.anchoredHash, anchor.head_hash);
  const alert = logged("audit.anchor_mismatch", workspaceId)[0];
  assert.equal(alert.security, true); assert.equal(alert.reason, "hash_changed"); assert.equal(alert.level, "error");
  assert.match(await api.instance.metrics.registry.metrics(), /wirepulse_audit_anchors_total\{result="mismatch"\} [1-9]/);

  // It is reported every cycle, and new events do not move the anchor past it.
  await addEvents(workspaceId, 1);
  assert.equal(outcome(await anchoring.runOnce(), workspaceId).result, "mismatch");
  assert.deepEqual(await anchorsOf(workspaceId), [anchor]);
  assert.equal(logged("audit.anchor_mismatch", workspaceId).length, 2);
});

test("an edited row that keeps its stored hash is caught when it is at or after the anchor", { skip }, async () => {
  const workspaceId = await newWorkspace("anchor-edit");
  await addEvents(workspaceId, 3);
  await anchoring.runOnce();
  const [anchor] = await anchorsOf(workspaceId);
  const earlier = anchor.seq - 2;
  await tamper("UPDATE audit_events SET details = '{\"edited\":true}'::jsonb WHERE workspace_id = $1 AND chain_seq = $2", [workspaceId, earlier]);
  assert.equal(outcome(await anchoring.runOnce(), workspaceId).result, "verified", "rows before the anchor were verified when they were anchored; anchoring does not re-read them");
  assert.equal((await head(workspaceId)).valid, false, "/audit/verify, which recomputes the whole chain, is what finds that");
  await tamper("UPDATE audit_events SET details = '{\"edited\":true}'::jsonb WHERE workspace_id = $1 AND chain_seq = $2", [workspaceId, anchor.seq]);
  const result = outcome(await anchoring.runOnce(), workspaceId);
  assert.equal(result.result, "mismatch"); assert.equal(result.reason, "chain_broken"); assert.equal(result.firstBadSeq, anchor.seq);
});

test("deleted events and wiped chains are caught", { skip }, async () => {
  const truncated = await newWorkspace("anchor-truncated"); const wiped = await newWorkspace("anchor-wiped");
  await addEvents(truncated, 3); await addEvents(wiped, 2);
  await anchoring.runOnce();
  const [anchor] = await anchorsOf(truncated);
  await tamper("DELETE FROM audit_events WHERE workspace_id = $1 AND chain_seq >= $2", [truncated, anchor.seq - 1]);
  await tamper("DELETE FROM audit_events WHERE workspace_id = $1", [wiped]);
  const run = await anchoring.runOnce();
  assert.deepEqual([outcome(run, truncated).result, outcome(run, truncated).reason], ["mismatch", "row_missing"], "the newest events were cut off");
  assert.deepEqual([outcome(run, wiped).result, outcome(run, wiped).reason], ["mismatch", "row_missing"], "a workspace with no events at all still has its anchor");
});

test("rows removed by audit retention are not reported as tampering", { skip }, async () => {
  const retention = async (workspaceId, sql, params) => {
    const client = await pool.connect();
    try { await client.query("BEGIN"); await client.query("SET LOCAL wirepulse.retention = 'on'"); await client.query(sql, params); await client.query("COMMIT"); } finally { client.release(); }
  };
  const withRetention = startAnchoring({ db: api.db, config: config(30), log: api.log, metrics: api.instance.metrics });
  try {
    // Part of the history is removed: the events after the anchor remain and the chain carries on.
    const partial = await newWorkspace("anchor-retention-partial");
    await addEvents(partial, 2);
    await anchoring.runOnce();
    const [anchor] = await anchorsOf(partial);
    await addEvents(partial, 2);
    await pool.query("UPDATE audit_anchors SET event_at = now() - interval '40 days' WHERE workspace_id = $1", [partial]);
    await retention(partial, "DELETE FROM audit_events WHERE workspace_id = $1 AND chain_seq <= $2", [partial, anchor.seq]);
    const result = outcome(await withRetention.runOnce(), partial);
    assert.equal(result.result, "anchored"); assert.equal(result.seq, (await head(partial)).lastSeq);
    assert.equal(outcome(await anchoring.runOnce(), partial).result, "verified");

    // All of it is removed (an idle workspace): the next event starts a new chain at 1, below the old anchor's number.
    const idle = await newWorkspace("anchor-retention-all");
    await addEvents(idle, 3);
    await anchoring.runOnce();
    await pool.query("UPDATE audit_anchors SET event_at = now() - interval '40 days' WHERE workspace_id = $1", [idle]);
    await retention(idle, "DELETE FROM audit_events WHERE workspace_id = $1", [idle]);
    await addEvents(idle, 1);
    assert.equal(outcome(await withRetention.runOnce(), idle).result, "anchored");
    assert.deepEqual((await anchorsOf(idle)).map((item) => item.seq), [1], "the old anchor is replaced by one on the new chain");
    assert.equal(outcome(await anchoring.runOnce(), idle).result, "verified");

    // The same gap is tampering when the anchored event is too recent to have been purged by a 30-day retention, or none is configured.
    const recent = await newWorkspace("anchor-not-retention");
    await addEvents(recent, 2);
    await anchoring.runOnce();
    const [recentAnchor] = await anchorsOf(recent);
    await tamper("DELETE FROM audit_events WHERE workspace_id = $1 AND chain_seq <= $2", [recent, recentAnchor.seq]);
    assert.equal(outcome(await withRetention.runOnce(), recent).reason, "row_missing");
    assert.equal(outcome(await anchoring.runOnce(), recent).reason, "row_missing");
  } finally { withRetention.stop(); }
});
