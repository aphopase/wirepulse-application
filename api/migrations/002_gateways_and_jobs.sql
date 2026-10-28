CREATE TABLE gateways (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name varchar(120) NOT NULL,
  token_hash text NOT NULL UNIQUE,
  capabilities jsonb NOT NULL DEFAULT '{}'::jsonb,
  agent_version text,
  last_heartbeat_at timestamptz,
  revoked_at timestamptz,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(workspace_id, name)
);
CREATE TABLE test_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  suite_id uuid REFERENCES test_suites(id) ON DELETE SET NULL,
  requested_by text NOT NULL,
  idempotency_key text NOT NULL,
  definition jsonb NOT NULL,
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'assigned', 'running', 'passed', 'failed', 'stopped', 'cancelled', 'timed_out')),
  gateway_id uuid REFERENCES gateways(id) ON DELETE SET NULL,
  lease_expires_at timestamptz,
  attempts integer NOT NULL DEFAULT 0,
  max_attempts integer NOT NULL DEFAULT 3,
  progress jsonb,
  summary jsonb,
  result jsonb,
  error text,
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  finished_at timestamptz,
  UNIQUE(workspace_id, idempotency_key)
);
CREATE INDEX test_jobs_workspace_created_idx ON test_jobs(workspace_id, created_at DESC);
CREATE INDEX test_jobs_queue_idx ON test_jobs(status, created_at);
