-- SaaS foundations: plans, usage metering, and workspace offboarding.

-- plan names map to limits in api/src/plans.mjs; the column is free text so adding a plan needs no migration.
-- A deleted workspace is hidden and unusable immediately; its content is purged after a grace period, and the row (plus its audit
-- trail, which is append-only and references it with ON DELETE RESTRICT) stays as a tombstone.
ALTER TABLE workspaces
  ADD COLUMN plan text NOT NULL DEFAULT 'enterprise',
  ADD COLUMN deleted_at timestamptz,
  ADD COLUMN deleted_by text,
  ADD COLUMN purge_after timestamptz,
  ADD COLUMN purged_at timestamptz,
  ADD CONSTRAINT workspaces_deletion_state CHECK (purge_after IS NULL OR deleted_at IS NOT NULL),
  ADD CONSTRAINT workspaces_purge_state CHECK (purged_at IS NULL OR deleted_at IS NOT NULL);
CREATE INDEX workspaces_created_by_idx ON workspaces(created_by) WHERE deleted_at IS NULL;
CREATE INDEX workspaces_purge_idx ON workspaces(purge_after) WHERE deleted_at IS NOT NULL AND purged_at IS NULL;

-- Monthly counters per workspace (period is the first day of the month, UTC). Written in the same transaction as the event it counts.
CREATE TABLE workspace_usage (
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  period date NOT NULL,
  jobs_created integer NOT NULL DEFAULT 0 CHECK (jobs_created >= 0),
  reports_created integer NOT NULL DEFAULT 0 CHECK (reports_created >= 0),
  PRIMARY KEY (workspace_id, period)
);
