-- Periodic snapshots of each workspace's audit chain head, written by the anchoring job (api/src/anchor.mjs).
-- Each snapshot is also logged, so a copy exists outside the database: rewriting history, even with a recomputed and
-- self-consistent chain, no longer matches the last anchor. Only the newest few anchors per workspace are kept.
CREATE TABLE audit_anchors (
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  seq bigint NOT NULL,
  head_hash text NOT NULL,
  event_at timestamptz NOT NULL,
  anchored_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, seq)
);
