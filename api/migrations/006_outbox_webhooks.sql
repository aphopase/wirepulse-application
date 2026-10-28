-- Outbound integrations: webhook subscriptions and a durable outbox that delivers both webhook calls and email.
-- Rows are written in the same transaction as the event that caused them, so a message is never lost or sent for work that rolled back;
-- a worker on any instance claims due rows (FOR UPDATE SKIP LOCKED) under a lease, so a crashed instance's rows are retried by another.
-- Delivery is at-least-once: receivers deduplicate on the delivery id (the outbox row id, sent as X-WirePulse-Delivery).

CREATE TABLE webhooks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  url text NOT NULL CHECK (length(url) BETWEEN 1 AND 2048),
  events text[] NOT NULL CHECK (cardinality(events) BETWEEN 1 AND 16),
  -- The signing secret is derived from the operator's WEBHOOK_SIGNING_KEY, the webhook id and this version, so no secret is stored.
  secret_version integer NOT NULL DEFAULT 1,
  enabled boolean NOT NULL DEFAULT true,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX webhooks_workspace_name ON webhooks (workspace_id, lower(name));

CREATE TABLE outbox (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  kind text NOT NULL CHECK (kind IN ('webhook', 'email')),
  webhook_id uuid REFERENCES webhooks(id) ON DELETE CASCADE,
  event_type text NOT NULL,
  payload jsonb NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'delivered', 'failed')),
  attempts integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  lease_expires_at timestamptz,
  last_status integer,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  CHECK ((kind = 'webhook') = (webhook_id IS NOT NULL))
);
CREATE INDEX outbox_due ON outbox (next_attempt_at) WHERE status = 'pending';
CREATE INDEX outbox_webhook_recent ON outbox (webhook_id, created_at DESC, id DESC) WHERE webhook_id IS NOT NULL;
CREATE INDEX outbox_finished ON outbox (finished_at) WHERE status <> 'pending';
