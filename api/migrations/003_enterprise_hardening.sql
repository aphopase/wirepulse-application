-- Gateways: routing labels, optional token expiry, and name reuse after revocation.
ALTER TABLE gateways
  ADD COLUMN labels jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(labels) = 'object'),
  ADD COLUMN token_expires_at timestamptz,
  ADD COLUMN token_rotated_at timestamptz;
ALTER TABLE gateways DROP CONSTRAINT gateways_workspace_id_name_key;
CREATE UNIQUE INDEX gateways_active_name_idx ON gateways(workspace_id, name) WHERE revoked_at IS NULL;

-- Jobs: provenance (what exactly ran), routing, priority, and state invariants.
ALTER TABLE test_jobs
  ADD COLUMN suite_version integer,
  ADD COLUMN profile_id uuid REFERENCES shared_profiles(id) ON DELETE SET NULL,
  ADD COLUMN profile_version integer,
  ADD COLUMN definition_hash text,
  ADD COLUMN requirements jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(requirements) = 'object'),
  ADD COLUMN priority smallint NOT NULL DEFAULT 0 CHECK (priority BETWEEN -10 AND 10),
  ADD COLUMN agent_version text,
  ADD COLUMN engine_fingerprint text,
  ADD CONSTRAINT test_jobs_max_attempts_range CHECK (max_attempts BETWEEN 1 AND 10),
  ADD CONSTRAINT test_jobs_state_invariants CHECK (
    (status IN ('assigned', 'running') AND gateway_id IS NOT NULL AND lease_expires_at IS NOT NULL)
    OR (status = 'queued' AND gateway_id IS NULL AND lease_expires_at IS NULL)
    OR status NOT IN ('queued', 'assigned', 'running')
  );
DROP INDEX test_jobs_queue_idx;
CREATE INDEX test_jobs_claim_idx ON test_jobs(workspace_id, priority DESC, created_at) WHERE status = 'queued';
CREATE INDEX test_jobs_queue_age_idx ON test_jobs(created_at) WHERE status = 'queued';
CREATE INDEX test_jobs_lease_idx ON test_jobs(lease_expires_at) WHERE status IN ('assigned', 'running');
CREATE INDEX test_jobs_finished_idx ON test_jobs(finished_at) WHERE finished_at IS NOT NULL;
CREATE INDEX test_jobs_suite_idx ON test_jobs(suite_id) WHERE suite_id IS NOT NULL;
CREATE INDEX test_jobs_profile_idx ON test_jobs(profile_id) WHERE profile_id IS NOT NULL;
CREATE INDEX test_jobs_gateway_idx ON test_jobs(gateway_id) WHERE gateway_id IS NOT NULL;
CREATE INDEX test_reports_suite_idx ON test_reports(suite_id) WHERE suite_id IS NOT NULL;
CREATE INDEX test_reports_created_idx ON test_reports(created_at);
CREATE INDEX workspace_members_subject_idx ON workspace_members(subject);

-- Live job updates: every job change notifies API instances, which fan out to SSE clients.
CREATE FUNCTION wirepulse_notify_job() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_notify('wirepulse_jobs', json_build_object('w', NEW.workspace_id, 'id', NEW.id)::text);
  RETURN NULL;
END $$;
CREATE TRIGGER test_jobs_notify AFTER INSERT OR UPDATE ON test_jobs FOR EACH ROW EXECUTE FUNCTION wirepulse_notify_job();

-- API keys for CI and automation: scoped to one workspace and role, always expiring, stored only as a hash.
CREATE TABLE api_keys (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name varchar(120) NOT NULL,
  role text NOT NULL CHECK (role IN ('viewer', 'engineer', 'maintainer')),
  token_hash text NOT NULL UNIQUE,
  token_prefix text NOT NULL,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  last_used_at timestamptz,
  revoked_at timestamptz
);
CREATE UNIQUE INDEX api_keys_active_name_idx ON api_keys(workspace_id, name) WHERE revoked_at IS NULL;

-- Invitations are matched to a verified OIDC email on acceptance; no email is sent by the API.
CREATE TABLE workspace_invitations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  email text NOT NULL CHECK (email = lower(email)),
  role text NOT NULL CHECK (role IN ('viewer', 'engineer', 'maintainer', 'administrator')),
  invited_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  accepted_by text,
  accepted_at timestamptz,
  revoked_at timestamptz
);
CREATE UNIQUE INDEX workspace_invitations_pending_idx ON workspace_invitations(workspace_id, email) WHERE accepted_at IS NULL AND revoked_at IS NULL;
CREATE INDEX workspace_invitations_email_idx ON workspace_invitations(email) WHERE accepted_at IS NULL AND revoked_at IS NULL;

-- Immutable version history for shared profiles and test suites.
CREATE TABLE resource_versions (
  resource_type text NOT NULL CHECK (resource_type IN ('profile', 'test_suite')),
  resource_id uuid NOT NULL,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  version integer NOT NULL,
  name varchar(120) NOT NULL,
  definition jsonb NOT NULL,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (resource_type, resource_id, version)
);
CREATE INDEX resource_versions_workspace_idx ON resource_versions(workspace_id);
CREATE FUNCTION wirepulse_record_version() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO resource_versions (resource_type, resource_id, workspace_id, version, name, definition, created_by)
  VALUES (TG_ARGV[0], NEW.id, NEW.workspace_id, NEW.version, NEW.name, NEW.definition, NEW.updated_by)
  ON CONFLICT (resource_type, resource_id, version) DO NOTHING;
  RETURN NULL;
END $$;
CREATE FUNCTION wirepulse_block_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% rows are immutable', TG_TABLE_NAME USING ERRCODE = 'restrict_violation';
END $$;
INSERT INTO resource_versions (resource_type, resource_id, workspace_id, version, name, definition, created_by)
  SELECT 'profile', id, workspace_id, version, name, definition, updated_by FROM shared_profiles;
INSERT INTO resource_versions (resource_type, resource_id, workspace_id, version, name, definition, created_by)
  SELECT 'test_suite', id, workspace_id, version, name, definition, updated_by FROM test_suites;
CREATE TRIGGER shared_profiles_versions AFTER INSERT OR UPDATE ON shared_profiles FOR EACH ROW EXECUTE FUNCTION wirepulse_record_version('profile');
CREATE TRIGGER test_suites_versions AFTER INSERT OR UPDATE ON test_suites FOR EACH ROW EXECUTE FUNCTION wirepulse_record_version('test_suite');
CREATE TRIGGER resource_versions_immutable BEFORE UPDATE ON resource_versions FOR EACH ROW EXECUTE FUNCTION wirepulse_block_update();

-- Audit log: per-workspace hash chain, append-only. Rows may only be deleted by the retention job (wirepulse.retention = 'on').
ALTER TABLE audit_events ADD COLUMN chain_seq bigint, ADD COLUMN prev_hash text, ADD COLUMN row_hash text;
CREATE FUNCTION wirepulse_audit_hash(prev text, seq bigint, ws uuid, actor text, act text, rtype text, rid uuid, req text, ip inet, details jsonb, at timestamptz)
RETURNS text LANGUAGE sql STABLE AS $$
  SELECT encode(digest(jsonb_build_array(prev, seq, ws, actor, act, rtype, rid, req, host(ip), details, to_char(at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US'))::text, 'sha256'), 'hex')
$$;
DO $$
DECLARE r record; prev text; seq bigint; current_ws uuid;
BEGIN
  FOR r IN SELECT * FROM audit_events ORDER BY workspace_id, id LOOP
    IF current_ws IS DISTINCT FROM r.workspace_id THEN current_ws := r.workspace_id; prev := repeat('0', 64); seq := 0; END IF;
    seq := seq + 1;
    prev := wirepulse_audit_hash(prev, seq, r.workspace_id, r.actor_subject, r.action, r.resource_type, r.resource_id, r.request_id, r.ip_address, r.details, r.created_at);
    UPDATE audit_events SET chain_seq = seq, prev_hash = CASE WHEN seq = 1 THEN repeat('0', 64) ELSE r.prev_hash END, row_hash = prev WHERE id = r.id;
  END LOOP;
END $$;
-- The backfill above cannot read the previous row's hash from r (stale); recompute links in one ordered pass.
DO $$
DECLARE r record; prev text; current_ws uuid;
BEGIN
  FOR r IN SELECT id, workspace_id, chain_seq, actor_subject, action, resource_type, resource_id, request_id, ip_address, details, created_at FROM audit_events ORDER BY workspace_id, chain_seq LOOP
    IF current_ws IS DISTINCT FROM r.workspace_id THEN current_ws := r.workspace_id; prev := repeat('0', 64); END IF;
    UPDATE audit_events SET prev_hash = prev, row_hash = wirepulse_audit_hash(prev, r.chain_seq, r.workspace_id, r.actor_subject, r.action, r.resource_type, r.resource_id, r.request_id, r.ip_address, r.details, r.created_at) WHERE id = r.id RETURNING row_hash INTO prev;
  END LOOP;
END $$;
ALTER TABLE audit_events ALTER COLUMN chain_seq SET NOT NULL, ALTER COLUMN prev_hash SET NOT NULL, ALTER COLUMN row_hash SET NOT NULL;
CREATE UNIQUE INDEX audit_events_chain_idx ON audit_events(workspace_id, chain_seq);
CREATE INDEX audit_events_workspace_id_idx ON audit_events(workspace_id, id DESC);
CREATE INDEX audit_events_created_idx ON audit_events(created_at);

CREATE FUNCTION wirepulse_audit_chain() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE last_row record;
BEGIN
  -- Serializes writers per workspace until commit, so the chain has no forks. Audit inserts must be the last statement of a transaction.
  PERFORM pg_advisory_xact_lock(hashtextextended('wirepulse-audit:' || NEW.workspace_id::text, 0));
  SELECT chain_seq, row_hash INTO last_row FROM audit_events WHERE workspace_id = NEW.workspace_id ORDER BY chain_seq DESC LIMIT 1;
  NEW.chain_seq := COALESCE(last_row.chain_seq, 0) + 1;
  NEW.prev_hash := COALESCE(last_row.row_hash, repeat('0', 64));
  NEW.row_hash := wirepulse_audit_hash(NEW.prev_hash, NEW.chain_seq, NEW.workspace_id, NEW.actor_subject, NEW.action, NEW.resource_type, NEW.resource_id, NEW.request_id, NEW.ip_address, NEW.details, NEW.created_at);
  RETURN NEW;
END $$;
CREATE TRIGGER audit_events_chain BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION wirepulse_audit_chain();

CREATE FUNCTION wirepulse_audit_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' AND current_setting('wirepulse.retention', true) = 'on' THEN RETURN OLD; END IF;
  RAISE EXCEPTION 'audit_events is append-only' USING ERRCODE = 'restrict_violation';
END $$;
CREATE TRIGGER audit_events_append_only BEFORE UPDATE OR DELETE ON audit_events FOR EACH ROW EXECUTE FUNCTION wirepulse_audit_guard();
CREATE TRIGGER audit_events_no_truncate BEFORE TRUNCATE ON audit_events FOR EACH STATEMENT EXECUTE FUNCTION wirepulse_audit_guard();

-- Recomputes the chain for one workspace in chunks. first_bad_seq is NULL when the checked rows are intact.
CREATE FUNCTION wirepulse_audit_verify(ws uuid, from_seq bigint DEFAULT 0, max_rows integer DEFAULT 50000)
RETURNS TABLE (checked bigint, first_bad_seq bigint, last_seq bigint, head_hash text) LANGUAGE plpgsql STABLE AS $$
DECLARE r record; expected_prev text; expected_seq bigint; n bigint := 0; bad bigint; last_s bigint; head text;
BEGIN
  SELECT row_hash INTO expected_prev FROM audit_events WHERE workspace_id = ws AND chain_seq = from_seq - 1;
  expected_seq := CASE WHEN expected_prev IS NULL THEN NULL ELSE from_seq END;
  FOR r IN SELECT * FROM audit_events WHERE workspace_id = ws AND chain_seq >= from_seq ORDER BY chain_seq LIMIT max_rows LOOP
    n := n + 1;
    IF bad IS NULL AND (
      r.row_hash <> wirepulse_audit_hash(r.prev_hash, r.chain_seq, r.workspace_id, r.actor_subject, r.action, r.resource_type, r.resource_id, r.request_id, r.ip_address, r.details, r.created_at)
      OR (expected_prev IS NOT NULL AND r.prev_hash <> expected_prev)
      OR (expected_seq IS NOT NULL AND r.chain_seq <> expected_seq)
    ) THEN bad := r.chain_seq; END IF;
    expected_prev := r.row_hash; expected_seq := r.chain_seq + 1; last_s := r.chain_seq; head := r.row_hash;
  END LOOP;
  RETURN QUERY SELECT n, bad, last_s, head;
END $$;
