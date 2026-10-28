const LOCK = 727277;
const VERIFY_ROWS = 5000;
const KEEP = 20;

// One row per workspace that has audit events or an anchor: its latest anchor, the audit row that anchor points at, and the current head.
// A workspace whose events have all vanished still shows up (through its anchor), so wiping a chain cannot hide it.
const STATE_SQL = `
  SELECT w.id AS workspace_id, la.seq AS anchor_seq, la.head_hash AS anchor_hash, at.row_hash AS anchored_row_hash,
         h.chain_seq AS head_seq,
         ($1::int > 0 AND la.event_at < now() - make_interval(days => $1::int)) AS anchor_expired
  FROM workspaces w
  LEFT JOIN LATERAL (SELECT seq, head_hash, event_at FROM audit_anchors WHERE workspace_id = w.id ORDER BY seq DESC LIMIT 1) la ON true
  LEFT JOIN LATERAL (SELECT row_hash FROM audit_events WHERE workspace_id = w.id AND chain_seq = la.seq) at ON true
  LEFT JOIN LATERAL (SELECT chain_seq FROM audit_events WHERE workspace_id = w.id ORDER BY chain_seq DESC LIMIT 1) h ON true
  WHERE la.seq IS NOT NULL OR h.chain_seq IS NOT NULL
  ORDER BY w.id`;

// Every AUDIT_ANCHOR_INTERVAL_MINUTES, for each workspace: (1) the audit row the previous anchor points at must still be there with the
// same hash, (2) the chain from that anchor on must recompute correctly, and (3) the new head becomes the next anchor and is logged.
// A mismatch is reported every cycle and the anchor is not advanced, so it cannot be silenced by the next run.
// Only one instance runs at a time (advisory lock). Events removed by audit retention are not a mismatch.
export function startAnchoring({ db, config, log, metrics }) {
  const minutes = config.anchorIntervalMinutes;
  const auditDays = config.retention?.auditDays ?? 0;
  let running = false;

  async function inspect(client, row) {
    let anchorSeq = row.anchor_seq === null ? null : Number(row.anchor_seq);
    if (anchorSeq !== null) {
      if (row.anchored_row_hash === null) {
        if (!row.anchor_expired) return { result: "mismatch", reason: "row_missing", anchorSeq };
        // Retention removes events older than its window, up to a workspace's whole history (the chain then restarts at 1), so an
        // anchor that old may legitimately be gone. Anchoring starts over from the first remaining row.
        await client.query("DELETE FROM audit_anchors WHERE workspace_id = $1 AND event_at < now() - make_interval(days => $2::int)", [row.workspace_id, auditDays]);
        anchorSeq = null;
      } else if (row.anchored_row_hash !== row.anchor_hash) {
        return { result: "mismatch", reason: "hash_changed", anchorSeq, anchoredHash: row.anchor_hash, currentHash: row.anchored_row_hash };
      }
    }
    if (row.head_seq === null) return { result: "verified" };
    const check = (await client.query("SELECT first_bad_seq, last_seq FROM wirepulse_audit_verify($1, $2, $3)", [row.workspace_id, anchorSeq ?? 0, VERIFY_ROWS])).rows[0];
    if (check.first_bad_seq !== null) return { result: "mismatch", reason: "chain_broken", anchorSeq, firstBadSeq: Number(check.first_bad_seq) };
    if (check.last_seq === null || Number(check.last_seq) === anchorSeq) return { result: "verified" };
    const inserted = (await client.query(
      "INSERT INTO audit_anchors (workspace_id, seq, head_hash, event_at) SELECT workspace_id, chain_seq, row_hash, created_at FROM audit_events WHERE workspace_id = $1 AND chain_seq = $2 RETURNING seq, head_hash",
      [row.workspace_id, check.last_seq]
    )).rows[0];
    await client.query("DELETE FROM audit_anchors WHERE workspace_id = $1 AND seq < (SELECT seq FROM audit_anchors WHERE workspace_id = $1 ORDER BY seq DESC OFFSET $2 LIMIT 1)", [row.workspace_id, KEEP - 1]);
    return { result: "anchored", seq: Number(inserted.seq), headHash: inserted.head_hash };
  }

  async function runOnce() {
    if (running) return null;
    running = true;
    try {
      const outcomes = await db.transaction(async (client) => {
        if (!(await client.query("SELECT pg_try_advisory_xact_lock($1) AS ok", [LOCK])).rows[0].ok) return null;
        const results = [];
        for (const row of (await client.query(STATE_SQL, [auditDays])).rows) {
          await client.query("SAVEPOINT anchor_one");
          try {
            results.push({ workspaceId: row.workspace_id, ...(await inspect(client, row)) });
            await client.query("RELEASE SAVEPOINT anchor_one");
          } catch (error) {
            // One workspace failing (say, a statement timeout on a huge chain) must not stop the rest from being anchored.
            await client.query("ROLLBACK TO SAVEPOINT anchor_one");
            results.push({ workspaceId: row.workspace_id, result: "error", message: error.message });
          }
        }
        return results;
      });
      if (!outcomes) return null;
      // Reported after the commit, so every logged anchor exists in the table.
      for (const { result, workspaceId, ...detail } of outcomes) {
        metrics.auditAnchors.inc({ result });
        if (result === "anchored") log.info({ event: "audit.anchor", workspaceId, seq: detail.seq, headHash: detail.headHash }, "audit chain anchored");
        else if (result === "mismatch") { metrics.auditFailures.inc(); log.error({ security: true, event: "audit.anchor_mismatch", workspaceId, ...detail }, "audit chain does not match its anchor"); }
        else if (result === "error") log.error({ workspaceId, err: { message: detail.message } }, "audit anchoring failed for a workspace");
      }
      return outcomes;
    } catch (error) { log.error({ err: error }, "audit anchoring run failed"); return null; } finally { running = false; }
  }

  if (minutes <= 0) return { stop() {}, runOnce };
  const timer = setInterval(runOnce, minutes * 60_000);
  timer.unref();
  const first = setTimeout(runOnce, 30_000);
  first.unref();
  return { stop() { clearInterval(timer); clearTimeout(first); }, runOnce };
}
