# Self-hosted WirePulse deployment

WirePulse has three parts. Only the first needs no server.

| Part | Where it runs | What it does |
|---|---|---|
| Browser app (`dist/`) | any static host | Serial monitor and validation. Serial bytes stay in the browser. |
| Control plane (`api/` + PostgreSQL) | your server, via `docker-compose.yml` | Workspaces, roles, shared profiles and suites, job queue, evidence verification, audit. |
| Gateway agent (`gateway/`) | the lab machine with the device attached | Claims queued jobs, drives the serial port, uploads hash-linked evidence (never raw bytes). |

The full HTTP contract is [docs/openapi.yaml](docs/openapi.yaml) (OpenAPI 3.0.3). The test suite checks the live server against it. For what is and is not covered by tests, see [Readiness and known limits](#readiness-and-known-limits).

Two deployment shapes use the same image and the same code:

- **Self-hosted, one organisation.** The defaults: every workspace is on the `enterprise` plan (no per-workspace limits), no Redis, no outbound mail, no webhooks. Start here.
- **Multi-tenant service (SaaS).** Several API replicas behind a load balancer, Redis for shared rate limits, per-workspace plans and quotas, webhooks, invitation email, workspace offboarding. See [Scale out](#scale-out-several-api-replicas) and [Running it as a service](#running-it-as-a-service-plans-quotas-offboarding).

## Prerequisites

- Docker Engine with Compose v2 on a Linux host
- An HTTPS reverse proxy or ingress in front of the API (Caddy, nginx, Traefik, a cloud load balancer)
- An OpenID Connect provider that enforces your MFA policy; the API validates its JWTs
- DNS and certificates for the browser app and the API
- Optional: Redis (shared rate limits across replicas; exercised with Redis 7), an SMTP relay (invitation email), a signing key (webhooks)

## Deploy the control plane

1. **Create the database secrets** on a local disk (not a root-squashed network mount, which cannot be bind-mounted):

   ```sh
   sudo ./scripts/init-secrets.sh /etc/wirepulse/secrets      # or just ./scripts/init-secrets.sh for ./secrets
   export WIREPULSE_SECRETS_DIR=/etc/wirepulse/secrets         # also put this in your service environment
   ```

   The script writes a random password and the matching `DATABASE_URL`. It never overwrites existing files. The files are mode 0644 inside a 0700 directory, because the containers read them as non-root users.

2. **Configure** `cp .env.example .env` and set `CORS_ORIGINS` (the exact https origin of the browser app), `OIDC_ISSUER`, `OIDC_AUDIENCE` and `TRUST_PROXY` (number of proxy hops in front of the API).

3. **Start**:

   ```sh
   docker compose up -d --build
   docker compose ps          # postgres healthy, migrate exited 0, api healthy
   ```

   Compose runs a one-shot `migrate` service first, then the API with `MIGRATE_ON_START=false`, so several API replicas can never race to migrate. To upgrade, rebuild and run `docker compose up -d --build` again; the migration runs before the new API starts.

4. **Put the reverse proxy in front** of `127.0.0.1:${API_PORT:-8080}`. Do not publish PostgreSQL; in this compose file it sits on an internal network with no published port. For the live job stream (`GET …/test-jobs/stream`, Server-Sent Events) the proxy must not buffer responses and must allow idle reads of a few minutes (nginx: `proxy_buffering off; proxy_read_timeout 3600s;`). The server sends a keep-alive comment every 15 s and closes each stream after `SSE_MAX_LIFETIME_SECONDS` (default 1800); the browser reconnects.

5. **Probe**: `GET /healthz` (liveness) and `GET /readyz` (readiness: 503 while the database is failing or the server is shutting down). Point the load balancer at `/readyz`.

The default configuration is production: the API refuses to start unless OIDC and https CORS origins are configured, `DEV_BEARER_TOKEN` is rejected, and `/metrics` is hidden unless `METRICS_TOKEN` is set. For a local trial set `NODE_ENV=development`, `DEV_BEARER_TOKEN`, `CORS_ORIGINS=http://localhost:5173` in `.env`.

Container hardening already applied: non-root user, read-only root filesystem, all Linux capabilities dropped, `no-new-privileges`, tini as PID 1 (so `docker stop` triggers the graceful shutdown and exits 0), CPU and memory limits, rotated JSON logs, healthchecks.

## Host the browser app

```sh
npm ci && npm run build        # type-checks, then writes dist/
```

Serve `dist/` from any static host over HTTPS. Set a restrictive Content-Security-Policy at that host; the app only needs to connect to itself and to your API origin (`connect-src 'self' https://api.example.com`). Users enter the API URL and a short-lived OIDC access token in the sidebar; the token is kept in memory only.

## Configuration reference

All settings can be given as `NAME` or `NAME_FILE` (the file's contents), so any of them can be a Docker or Kubernetes secret. Defaults are in [api/src/config.mjs](api/src/config.mjs), which is the authority. `docker-compose.yml` passes the container the settings listed in `.env.example` (plus a few more under `x-env`); to set any other setting, or a `*_FILE` variant, add it to `x-env` there.

| Setting | Default | Purpose |
|---|---|---|
| `DATABASE_URL` | required | PostgreSQL connection string |
| `DB_POOL_SIZE` | 10 | Connections per API instance, plus one dedicated listener connection. Keep `instances × (DB_POOL_SIZE + 1)` below PostgreSQL's `max_connections` (100 by default), with headroom for the migration job and your own tools |
| `DB_SSL`, `DB_SSL_CA_FILE` | `off` | `verify` + a CA file for a managed database (`require` encrypts but does not verify the server) |
| `CORS_ORIGINS` | none in production | Exact browser origin(s) |
| `OIDC_ISSUER`, `OIDC_AUDIENCE`, `OIDC_JWKS_URI` | issuer and audience required in production | Token validation. The signing keys are located through `<issuer>/.well-known/openid-configuration` (the document every standard provider publishes); set `OIDC_JWKS_URI` (https) only if yours does not. The issuer is reached over TLS with certificate verification; trust a private CA with `NODE_EXTRA_CA_CERTS`. If the provider is unreachable at startup, sign-ins fail (401) and discovery is retried after 30 seconds. |
| `OIDC_TRUST_UNVERIFIED_EMAIL` | `false` | Keep `false`: invitations are matched to a verified email only |
| `TRUST_PROXY` | unset | Proxy hops; without it rate limits and audit see the proxy's address (warned at startup) |
| `RATE_LIMIT_PER_MINUTE` / `_IP_` / `GATEWAY_` / `AUTH_FAILURE_` | 240 / 1200 / 600 / 30 | Per user, per IP, per gateway, and failed authentications per IP. Shared across replicas when `REDIS_URL` is set, otherwise counted per instance |
| `REDIS_URL` | unset | `redis://` or `rediss://`. Holds rate-limit counters only (nothing else is stored there). While Redis is unreachable each instance falls back to its own counters and logs the failure; it recovers by itself |
| `JOB_LEASE_SECONDS`, `JOB_MAX_ATTEMPTS` | 60, 3 | A gateway that stops renewing loses its job; after the last attempt the job is `timed_out` |
| `MAX_QUEUED_JOBS_PER_WORKSPACE`, `QUEUE_TTL_SECONDS` | 1000, 86400 | Queue limit per workspace (429 `queue_full`; the lower of this and the plan's `queuedJobs` applies, counted under a lock so concurrent submissions cannot overshoot) and expiry of never-claimed jobs |
| `SSE_MAX_CLIENTS`, `SSE_MAX_LIFETIME_SECONDS` | 500, 1800 | Live-stream caps per instance (503 `too_many_streams`; 10 per user → 429) |
| `INVITATION_TTL_DAYS`, `API_KEY_MAX_DAYS` | 7, 365 | API keys always expire |
| `RETENTION_DAYS_JOBS/REPORTS/AUDIT` | `0` (keep) | Irreversible deletion; each purge is audited |
| `AUDIT_ANCHOR_INTERVAL_MINUTES` | `0` (off) | Every N minutes each workspace's audit chain head is verified against the previous anchor, then logged as an anchor (see [Audit log](#audit-log)) |
| `DEFAULT_PLAN` | `enterprise` | Plan given to new workspaces: `free`, `team`, `business` or `enterprise` (unlimited). **Set `free` for a public service** (see the launch checklist) |
| `MAX_WORKSPACES_PER_USER` | `0` (no cap) | Live workspaces one person may have created (counts those not offboarded). **Set a cap for a public service** |
| `WORKSPACE_PURGE_GRACE_DAYS`, `WORKSPACE_PURGE_INTERVAL_MS` | 30, 300000 | How long an offboarded workspace can still be restored, and how often the purge worker looks |
| `SMTP_URL`, `SMTP_FROM`, `INVITE_BASE_URL` | unset | Invitation email. `smtp://user:pass@host:587` must upgrade with STARTTLS or nothing is sent; `smtps://` uses TLS from the first byte; `?tls=none` (a trusted local relay only) is refused in production. `SMTP_FROM` is required with `SMTP_URL`. `INVITE_BASE_URL` is the link put in the mail (your browser app's address) |
| `WEBHOOK_SIGNING_KEY` | unset (webhooks off) | At least 32 characters of secret. Per-webhook secrets are derived from it; without it the webhook routes answer 501 `webhooks_not_configured` |
| `WEBHOOK_ALLOWED_CIDRS` | none | Private ranges webhooks may reach (for example `10.20.0.0/16` for an internal receiver). Public addresses need no entry; link-local and cloud-metadata addresses are never reachable |
| `WEBHOOK_ALLOW_PRIVATE_NETWORKS` | `false` | Switches the SSRF protection off. Refused at startup in production |
| `WEBHOOK_TIMEOUT_MS` | 5000 | One deadline for resolving, connecting and getting response headers |
| `OUTBOX_INTERVAL_MS`, `OUTBOX_MAX_ATTEMPTS`, `OUTBOX_RETENTION_DAYS` | 2000, 8, 14 | Delivery worker poll interval, attempts per message (1–30), and how long delivered or failed messages are kept |
| `METRICS_TOKEN`, `METRICS_PORT` | unset | Bearer token (≥ 24 chars) on `/metrics`, or serve it on a separate internal port |
| `LOG_LEVEL` | `info` | pino JSON logs; secrets and tokens are redacted |

## Run a gateway agent

The agent runs on the machine the device is plugged into. It only makes outbound HTTPS calls; no inbound port is needed.

1. In the console: **Gateways → Register gateway** (maintainer or above). The `wpg_…` token is shown once and stored server-side only as a hash. Labels such as `bench=1` select where a job runs: a gateway only claims jobs whose `requirements` are all present in its labels.
2. On the lab machine: install Node 20, copy `gateway/` to `/opt/wirepulse/gateway`, run `npm ci --omit=dev` there (the `serialport` module is an optional dependency and needed for real hardware).
3. Install the unit [gateway/deploy/wirepulse-gateway.service](gateway/deploy/wirepulse-gateway.service) (the token goes in a file, see the comments in the unit), then `systemctl enable --now wirepulse-gateway`. Settings: `WIREPULSE_API_URL` (https; plain http only for localhost), `WIREPULSE_SERIAL_PATH`, `WIREPULSE_GATEWAY_TOKEN_FILE`, and optional `WIREPULSE_POLL_MS`, `_HEARTBEAT_MS`, `_LEASE_RENEW_MS`, `_REQUEST_TIMEOUT_MS`, `_MAX_BACKOFF_MS`, `_SHUTDOWN_GRACE_MS`.
4. **Rotate** a token: Gateways → **Rotate token**, write the new token to the token file, `systemctl restart wirepulse-gateway`. The old agent stops by itself the next time it contacts the server (it logs that the token was rejected). **Revoke** retires the gateway for good.
5. A gateway is shown online if it sent a heartbeat in the last 90 s. If the device cannot be opened, the agent does not report the job as failed; its lease expires and the job is requeued (up to `JOB_MAX_ATTEMPTS`).

The server decides every job's final status itself by re-verifying the hash-linked evidence; the agent's claim is not trusted.

## Roles

| Role | Can additionally |
|---|---|
| viewer | list and read jobs, stream, download JUnit XML; read profiles, suites (with version history) and reports; list gateways; read the workspace's plan and usage |
| engineer | queue and cancel jobs; create and update profiles and suites; upload test reports |
| maintainer | register, label, rotate and revoke gateways; delete profiles and suites; list members |
| administrator | manage members, invitations, API keys and webhooks; list, export and verify the audit log; delete (offboard) the workspace, as a person only |

A non-member, an unknown workspace and a too-low role all receive the same `403 insufficient_workspace_role`, so workspace ids cannot be probed. A missing object inside an accessible workspace is `404`. API keys (`wpk_…`) are workspace-scoped, at most maintainer, always expiring, and can only be created by a person, not by another key. An invitation is matched to the invitee's verified OIDC email when they sign in and accept. If SMTP is configured the server also emails the invitee; otherwise tell the invitee yourself (see [Invitation email](#invitation-email)).

## Scale out: several API replicas

`docker-compose.scale.yml` is an overlay that runs several identical API replicas behind nginx (`deploy/nginx.scale.conf`) and adds Redis:

```sh
docker compose -f docker-compose.yml -f docker-compose.scale.yml up -d --build --scale api=3
```

Nothing depends on which replica served a request, so any load balancer works; what is shared, and how:

| What | Where it is coordinated |
|---|---|
| Jobs, claims, quotas, audit | PostgreSQL row locks and advisory locks |
| Live job updates (SSE) | PostgreSQL `LISTEN/NOTIFY`: a client connected to one replica sees changes made through another |
| Rate limits | Redis when `REDIS_URL` is set. Without it each replica counts alone, so the effective limit is the configured one times the number of replicas |
| Background workers (lease sweep, outbox, retention, anchoring, purge) | Run on every replica and coordinate in PostgreSQL (`FOR UPDATE SKIP LOCKED`, advisory locks); a crashed worker's rows come back when its lease runs out |

Things to get right:

- **Database connections.** Each replica holds up to `DB_POOL_SIZE` pooled connections plus one for `LISTEN`. Keep `replicas × (DB_POOL_SIZE + 1)` below `max_connections`. Connection exhaustion did happen in this repository's three-replica load test before the pool size was made configurable, which is why `DB_POOL_SIZE` exists and defaults to 10. A connection pooler in front of PostgreSQL was not tested; `LISTEN` needs a session-level connection.
- **Redis is optional state.** It holds only rate-limit counters, no data worth keeping (the overlay runs it without persistence and with a memory cap). If it is unreachable the API keeps serving on per-replica counters, logs a warning at most every 30 s and counts `wirepulse_rate_limit_store_errors_total`; it returns to the shared counters by itself. This was tested by stopping Redis under load: no request failed.
- **Your own load balancer.** Health check `/readyz`; no response buffering and an idle timeout of at least a few minutes on `…/test-jobs/stream`; set `TRUST_PROXY` to the number of hops in front of the API.
- **Rolling restarts.** On `SIGTERM` a replica starts answering `/readyz` with 503, finishes in-flight requests and closes streams (browsers reconnect). Restart one replica at a time. A request that is still in flight when a replica is forced to exit can surface as a 502 from the proxy; in a rolling restart under load that was 2 of about 28,000 requests, both POSTs. The gateway agent retries, and job submission is idempotent through `idempotencyKey`, so CI clients should retry too.
- **Schema upgrades** run once in the `migrate` service before any new replica starts. A zero-downtime upgrade (old and new replicas running against the new schema) was not tested; read the migration before relying on it.

### Load and integrity test

`scripts/loadtest.mjs` drives a running deployment (one instance or many behind a balancer) with simulated gateways that claim and complete jobs with real, verifiable evidence, while submitters and readers hit the API:

```sh
node scripts/loadtest.mjs --url http://127.0.0.1:8080 --token "$ADMIN_TOKEN" --seconds 30 --workspaces 2 --gateways 6
```

It prints throughput and latency percentiles, and it exits 1 unless every submitted job was handed out exactly once and ended `passed`, no response was a 5xx, and every workspace's audit chain still verifies. It creates its own `loadtest-…` workspaces and leaves them behind (offboard them afterwards), and they need a plan with room for the gateways and queue it uses (the default `enterprise` plan has no limits). Do not point it at production.

Baseline from this repository's development machine, which was shared with other work (load average 6–7), so read it as an order of magnitude and not as a capacity promise: about 160–190 completed jobs per second against one instance, and 63–229 jobs per second across repeated runs of the three-replica stack (4,231 of 4,231 jobs completed once each, no duplicate claim, all chains valid, no 5xx). The cause of the spread between runs was not isolated. Size your deployment by running the test on your own hardware.

## Running it as a service: plans, quotas, offboarding

Every workspace has a **plan**. New workspaces get `DEFAULT_PLAN`; the operator moves a workspace between plans. A self-hosted organisation keeps the default `enterprise` plan, which has no limits. The limits are in [api/src/plans.mjs](api/src/plans.mjs) (`—` = unlimited):

| Limit | free | team | business | enterprise |
|---|---|---|---|---|
| Members (including pending invitations) | 3 | 15 | 100 | — |
| Gateways (not revoked) | 1 | 5 | 50 | — |
| API keys (active) | 2 | 10 | 50 | — |
| Webhooks | 1 | 5 | 25 | — |
| Queued jobs | 50 | 500 | 5,000 | — |
| Jobs created per UTC month | 500 | 10,000 | 200,000 | — |
| Reports per UTC month (uploads and jobs finished by a gateway) | 100 | 2,000 | 50,000 | — |
| Requests per minute, whole workspace | 120 | 600 | 3,000 | — |

- Creating something over a limit answers `403 plan_limit_reached` with `details: { resource, plan, limit }`; a full queue answers `429 queue_full`; the workspace request budget answers `429 rate_limited`. The check and the insert happen under one workspace lock, so concurrent requests cannot overshoot a limit (tested with parallel requests).
- Moving a workspace to a smaller plan removes nothing: existing gateways, keys and members stay, and new ones are refused until usage is under the new limit.
- `GET /v1/workspaces/{id}/usage` (any member) and the console's **Usage** tab show the plan, limits and current usage. Monthly counters reset at the start of each UTC month.
- `MAX_WORKSPACES_PER_USER` caps how many live workspaces one person can have created (`403 workspace_limit_reached`).

**Operator commands.** Run them where the API's environment is (they use `DATABASE_URL`). Output is JSON; every change is written to the workspace's audit trail with the operator's OS user name as the actor.

```sh
docker compose exec api node src/admin-cli.mjs plan show <workspaceId>
docker compose exec api node src/admin-cli.mjs plan set <workspaceId> team
docker compose exec api node src/admin-cli.mjs workspace list [--deleted]
docker compose exec api node src/admin-cli.mjs workspace restore <workspaceId>
```

**Billing is not included.** Plans are changed by the operator; there is no payment provider, invoice or trial logic. Connect your billing system by having it call `plan set` (or write the `workspaces.plan` column and the audit event the same way) when a subscription changes.

**Abuse controls.** Anyone your identity provider lets sign in can create workspaces, so set sign-up controls at the IdP, run with `DEFAULT_PLAN=free` and set `MAX_WORKSPACES_PER_USER`. The one message the server sends to an address chosen by a tenant is the invitation email; it is bounded by the plan's member limit (pending invitations count) times the per-user workspace cap, and each message is a fixed plain-text template whose only tenant-chosen text is the workspace name. Watch `wirepulse_rate_limited_total` and `wirepulse_outbox_messages_total{kind="email"}`.

### Offboarding and restore

An administrator (a person, not an API key) deletes a workspace with `DELETE /v1/workspaces/{id}?confirm=<exact workspace name>`, or from the console's Usage tab. Immediately:

- the workspace answers `403` on every route, like a non-member; queued, assigned and running jobs are cancelled, its API keys, gateways and invitations are revoked, its webhooks are disabled and pending outbox messages are marked failed;
- the content is kept for `WORKSPACE_PURGE_GRACE_DAYS` (default 30), and the person's workspace cap is freed.

Within the grace period the operator can undo it with `workspace restore <id>`. The workspace returns **without** its API keys, gateways and invitations (they were revoked; create new ones) and with its webhooks disabled (re-enable them). After the grace period the purge worker deletes the content in slices of at most 1,000 rows per table, on any replica; a restore racing the deadline ends in exactly one state, whole or gone. Restore after the deadline is refused even if the purge has not started.

Export what you need **before** deleting: after deletion the API refuses the workspace's routes, including audit export, and an operator can read the rest only from the database. The workspace row stays behind as a tombstone together with its **audit trail**, which is append-only evidence and is not deleted by the purge. It contains actor ids, client IP addresses, request ids and event details such as names and invited email addresses, but not job results, profiles or serial data. Set `RETENTION_DAYS_AUDIT` to match your privacy policy; there is no per-person erasure of audit rows, so decide with your data-protection owner how to answer an erasure request.

## Integrations: webhooks and invitation email

Both leave through a durable **outbox** table written in the same transaction as the change that caused them, so a message exists exactly when the change committed. A worker on every replica delivers due rows (`FOR UPDATE SKIP LOCKED` plus a lease). Delivery is **at-least-once**: a receiver must tolerate the same event twice.

### Webhooks

Set `WEBHOOK_SIGNING_KEY` (≥ 32 characters; use `WEBHOOK_SIGNING_KEY_FILE` for a secret) to turn the routes on; without it they answer `501 webhooks_not_configured`. An administrator adds an endpoint under **Webhooks** in the console (or `POST /v1/workspaces/{id}/webhooks`). The `whsec_…` secret is shown once, at creation and at rotation; it is derived from the signing key and the webhook id and is not stored. Events: `job.finished` (any final status, including `timed_out`) and `webhook.ping` (the "Send test" button). Nothing else is sent.

The request is a `POST` with `Content-Type: application/json`, a body like `{"id":"<delivery id>","type":"job.finished","createdAt":"…","workspaceId":"…","data":{…the job, as GET …/test-jobs/{id} without the definition…}}` and these headers:

| Header | Meaning |
|---|---|
| `X-WirePulse-Event` | event type |
| `X-WirePulse-Delivery` | delivery id: stable across retries and redelivery; deduplicate on it |
| `X-WirePulse-Signature` | `t=<unix seconds>,v1=<hex HMAC-SHA256 of "<t>.<raw body>" keyed with the secret>` |

A receiver must verify the signature over the **raw** body in constant time and reject timestamps older than about 5 minutes. Reference implementation (Node):

```js
import crypto from "node:crypto";
export function verify(secret, header, rawBody, toleranceSeconds = 300) {
  const parts = Object.fromEntries(String(header).split(",").map((p) => p.trim().split("=")));
  const t = Number(parts.t);
  if (!Number.isInteger(t) || !parts.v1 || Math.abs(Date.now() / 1000 - t) > toleranceSeconds) return false;
  const expected = crypto.createHmac("sha256", secret).update(`${t}.${rawBody}`).digest();
  const given = Buffer.from(parts.v1, "hex");
  return given.length === expected.length && crypto.timingSafeEqual(given, expected);
}
```

- **Success** is any 2xx within `WEBHOOK_TIMEOUT_MS`; redirects are not followed and the response body is never read or stored.
- **Retries** after a failure wait about 10 s, 30 s, 2 min, 10 min, 30 min, 1 h, 2 h, then 4 h (±20 %), up to `OUTBOX_MAX_ATTEMPTS` (default 8, so about 3 h 40 min in all; the 4 h step and the 6 h cap only matter if you raise it). The body is byte-identical on every attempt; only the timestamp and signature change. A delivery that ends `failed` can be redelivered from the console or `POST …/deliveries/{deliveryId}/redeliver`, with the same delivery id.
- **Rotation.** "Rotate secret" invalidates the old secret at once for messages not yet sent, and there is no overlap window: update the receiver first or accept a few failed deliveries and redeliver them. Changing `WEBHOOK_SIGNING_KEY` rotates every secret at once.
- **SSRF policy.** The destination is resolved once and the connection goes to exactly that vetted address (no DNS-rebinding gap); TLS certificates are always verified. Link-local, cloud-metadata, multicast and reserved addresses can never be reached. Private ranges (RFC 1918, loopback, CGNAT, ULA…) are refused unless inside `WEBHOOK_ALLOWED_CIDRS`; plain `http://` is accepted only for such an allow-listed address. A refused destination is a permanent failure and is shown to tenants only as `destination_blocked`.
- The stored failure reason is deliberately coarse (`timeout`, `dns_failed`, `tls_error`, `connection_failed`, `request_failed`, a status code) so a tenant cannot map the network behind an allow-listed range.
- **Not built:** automatic disabling of a failing endpoint, dual-secret rotation, a ping rate limit, and event types beyond the two above. Receivers that are down for longer than the retry window need a redelivery.

### Invitation email

With `SMTP_URL` and `SMTP_FROM` set, creating an invitation also queues one plain-text email through the outbox (fixed template, the operator's `INVITE_BASE_URL` as the only link). Without SMTP nothing is sent and the administrator must tell the invitee; the API response does not say whether mail was queued, and the console words this neutrally. `smtp://` must negotiate STARTTLS or the message is not sent (there is no silent downgrade); certificates are verified. The message body is removed from the outbox once the attempt is final. A relay that rejects the recipient (a 55x reply) is a permanent failure; temporary failures retry on the schedule above. This was tested against an in-process SMTP server, not a third-party provider.

### Proxies, private CAs and TLS verification

Outgoing webhook and SMTP connections verify certificates explicitly, even if the container's environment sets `NODE_TLS_REJECT_UNAUTHORIZED=0` (a test proves this). Do not set that variable anyway. If your receivers or relay use a private CA, add it with `NODE_EXTRA_CA_CERTS=/path/ca.pem` (mount the file read-only into the container); this is separate from `DB_SSL_CA_FILE`, which applies to PostgreSQL only. Webhook and SMTP connections do not use an outbound HTTP proxy.

## Operations

### Monitoring

`/metrics` is Prometheus text. Beyond default process metrics: `wirepulse_http_request_duration_seconds`, `wirepulse_jobs{status}`, `wirepulse_oldest_queued_job_age_seconds`, `wirepulse_gateways_online`, `wirepulse_sse_clients`, `wirepulse_listener_connected`, `wirepulse_db_pool_connections`, `wirepulse_rate_limited_total{limiter}`, `wirepulse_rate_limit_store_errors_total`, `wirepulse_auth_failures_total`, `wirepulse_outbox_messages_total{kind,result}`, `wirepulse_webhook_deliveries_total{result}`, `wirepulse_audit_anchors_total{result}`, `wirepulse_workspaces_purged_total`, `wirepulse_retention_deleted_total`. Suggested alerts:

- `/readyz` failing for more than 1 minute
- `wirepulse_listener_connected == 0` (live updates fall back to polling)
- `wirepulse_oldest_queued_job_age_seconds` above your queue SLO while `wirepulse_gateways_online == 0`
- 5xx ratio or p95 latency above target
- sustained `429`s or `auth_failure` log lines: probing, or a misconfigured client. Only failed authentications count toward `AUTH_FAILURE_LIMIT_PER_MINUTE`, but once an IP is over the limit it is refused entirely, valid requests included, until the minute window passes; behind a shared NAT one broken client can therefore lock out its neighbours for a minute at a time (fix the client, or raise the limit)
- `increase(wirepulse_audit_anchors_total{result="mismatch"}[1h]) > 0` or the log event `audit.anchor_mismatch`: see [Audit log](#audit-log); treat as a security incident until explained
- `increase(wirepulse_rate_limit_store_errors_total[5m]) > 0` for longer than a few minutes (Redis down: limits are per replica meanwhile)
- `wirepulse_outbox_messages_total{result="failed"}` growing: webhook receivers or the SMTP relay are failing

### Backup and restore

Back up the database; it holds everything. Keep the secrets directory separately, and keep `WEBHOOK_SIGNING_KEY` with it: webhook secrets are derived from that key and are not stored, so a restore under a different key silently changes every webhook secret and receivers start rejecting deliveries. Dumps contain audit data (actor ids, IP addresses, invited email addresses), the hashes of gateway tokens and API keys, and pending outbox messages: encrypt them and restrict access.

```sh
docker compose exec -T postgres pg_dump -U wirepulse -d wirepulse --format=custom --no-owner > wirepulse-$(date +%F).dump
```

Rehearse a restore into a scratch database and check it through a second API instance before you need it:

```sh
docker compose exec -T postgres createdb -U wirepulse wirepulse_restore
docker compose exec -T postgres pg_restore -U wirepulse -d wirepulse_restore --no-owner --exit-on-error < wirepulse-2026-10-27.dump
# start an API against wirepulse_restore (same DATABASE_URL with the database name changed, MIGRATE_ON_START=false)
# then, as an administrator:  GET /v1/workspaces/<id>/audit/verify   →   valid: true, same headHash as production
```

This sequence has been run end to end against this compose stack: the restored database was served by a separate API container, and `audit/verify` returned `valid: true` with the same `headHash` as the original. For disaster recovery, stop the API, restore into an empty database, and start the stack. Dump-based backups lose everything since the last dump; for a tighter recovery point use PostgreSQL WAL archiving or your provider's point-in-time recovery (not set up by this repository).

### Audit log

Audit rows form a SHA-256 hash chain per workspace and the table is append-only (enforced by a database trigger). `GET …/audit/verify` recomputes the chain; `GET …/audit-events/export.ndjson` exports it. A database superuser could rewrite the tail of a chain and re-chain it, and only a copy of the head kept outside the database would reveal that.

**Anchoring.** Set `AUDIT_ANCHOR_INTERVAL_MINUTES` (for example `15`; the first run is 30 s after start). Then, for every workspace and on one replica at a time, the server checks that the audit row the previous anchor points at still exists with the same hash, recomputes the chain from that anchor onward, and records the new head as the next anchor. Each new anchor is also written to the log (`event: "audit.anchor"`, `workspaceId`, `seq`, `headHash`). **Ship those log lines to a system the database administrators cannot edit** (your SIEM or a write-once bucket): that copy is the independent evidence. The `audit_anchors` table is in the same database, so by itself it only detects accidental damage and an attacker who forgets to fix it.

A problem is logged at `error` level every cycle as `event: "audit.anchor_mismatch"` (`security: true`) with a `reason`, counted in `wirepulse_audit_anchors_total{result="mismatch"}`, and the anchor is **not** advanced, so it cannot go quiet by itself:

| `reason` | Meaning |
|---|---|
| `row_missing` | the audited row at the anchored position is gone |
| `hash_changed` | the row is there with different content |
| `chain_broken` | a row after the anchor does not follow from the one before (`firstBadSeq` says where) |

Rows removed by `RETENTION_DAYS_AUDIT` are not a mismatch; an anchor older than the retention window is dropped with them.

**Runbook for a mismatch.** (1) Do not delete anything yet. (2) Compare with your shipped log: find the last `audit.anchor` line for that workspace and compare its `headHash` with the `row_hash` of the event whose `chain_seq` equals its `seq` in `GET …/audit-events/export.ndjson`. (3) If someone edited history, preserve the database and the log and follow your incident process. (4) If there is an innocent explanation (for example you restored an older backup into this database, so rows after the backup point are legitimately gone), re-baseline that one workspace by deleting its anchors: `DELETE FROM audit_anchors WHERE workspace_id = '<workspace id>';`. The next cycle anchors the current head. This silences the alarm, so write down why in your change record first.

Known limits: the anchor check starts at the previous anchor and does not re-read older history each cycle (use `GET …/audit/verify` for a full recompute), and a workspace whose chain is very long is verified in batches over several cycles.

## Readiness and known limits

**Verified by tests in this repository** (run against real PostgreSQL and, where stated, real Redis; the numbers are from the last full run)

- API: 167 integration tests in 21 files. They include a contract test that checks the running server against `docs/openapi.yaml` (route inventory, response schemas, role and workspace-isolation matrix); quota and plan tests with concurrent requests; the outbox, webhook signing and SSRF policy (including DNS-rebinding and redirect cases); invitation email against a real SMTP server (STARTTLS, TLS, auth, header injection); the operator CLI; offboarding, restore and the purge worker, including two instances purging at once and a restore racing the deadline; audit anchoring with tampering; the rate limiters including Redis outage and recovery; and several API instances sharing one database.
- Gateway agent: 22 tests (claim, lease renewal, evidence upload, shutdown, token rejection, config validation).
- Browser: 14 Playwright tests. Seven of them drive the console against the real API, PostgreSQL and a real agent: register a gateway, run a job with a live update, evidence hashes and JUnit; rotate and revoke; invite and API key; stream outage and polling fallback; usage and plan limits; webhook lifecycle (signed delivery verified, secret rotation, failure and redelivery); workspace deletion; role gating.
- Mutation checks: the tests for the new quota, webhook, offboarding, limiter, purge and console behaviour were run against deliberately broken copies of the code. Each mutant that survived either led to a new test (one exposed a real bug in the authentication-failure limiter, fixed) or was shown to be an equivalent change that cannot alter behaviour.
- Multi-replica run (Docker, three API replicas behind nginx, Redis, PostgreSQL), driven by `scripts/loadtest.mjs`: 4,231 of 4,231 jobs completed, none claimed twice, every audit chain valid, no 5xx; with Redis stopped under load no request failed and limits fell back to per-replica counters, then recovered; a rolling restart of the replicas under load lost 2 of about 28,000 requests (in-flight POSTs).
- Container: image builds; the production configuration fails fast without OIDC with a readable message; non-root, read-only filesystem and dropped capabilities were checked inside a running container; data survives a restart; backup and restore as above. The multi-replica Docker runs above used `NODE_ENV=development` with a development bearer token.
- Production mode against a real identity provider: the API container ran with `NODE_ENV=production` against **Keycloak 26** over https (a private CA trusted through `NODE_EXTRA_CA_CERTS`, no TLS-verification override). A real Keycloak token was accepted, the development token, garbage and tampered tokens were refused, a user with an unverified email could not accept invitations, `/metrics` stayed guarded, and with the CA not trusted the API failed closed (401). This found and fixed a real defect: signing keys were looked up at a guessed path (`/.well-known/jwks.json`) that Keycloak, Okta and Entra do not serve; they are now found through the issuer's discovery document (see `OIDC_JWKS_URI` in the configuration reference).
- PostgreSQL restart under load: the API process survived, `/readyz` went 503 → 200 within a second of the database returning, audit chains verified, and a clean load run followed (2,603 jobs, no duplicates, no 5xx). This found and fixed a real defect: a connection that dropped while a transaction held it crashed the whole process.
- Soak: five minutes at full speed against one API process, one PostgreSQL: 78,820 of 78,820 jobs completed, none claimed twice, no 5xx, no error-level log line, process memory flat (about 130–190 MB, no upward trend) and a constant 11 database connections. Five minutes shows no fast leak; it cannot show a slow one, so watch memory in production.
- Independent code review of the API (a second reviewer reading the code, no running system) produced ten findings. Fixed: profile and suite lists returned every definition (now summaries only), a report could name another workspace's suite, and the IPv6 /64 rate-limit key was wrong for compressed addresses. The rest are in the launch checklist and design limits below.

**Not achievable by code alone, and not done**

- **Real USB/UART hardware.** Only a simulated transport was exercised. Run your own device matrix (adapters, resets, reconnects, throughput) before relying on results.
- **High availability and load at your scale.** The load numbers above are a single-machine, shared-host baseline (single instance roughly 160–260 jobs/s depending on the run; three replicas varied between runs and the cause was not isolated). Not done: replica promotion or failover of PostgreSQL, Redis failover, a connection pooler in front of PostgreSQL, a zero-downtime schema upgrade test, more than three replicas, and any soak longer than five minutes.
- **Independent security assessment.** None by a third party; the code review above was done with the same tooling that wrote the code. Commission a penetration test before external exposure.
- **SSO with your identity provider.** Tested against Keycloak 26 (see above), not against Entra ID, Okta, Auth0 or Google Workspace. Their tokens follow the same standard, but check the audience and the `email_verified` claim your tenant actually issues.
- **Real third parties.** Email was tested against an in-process SMTP server, not a provider (SPF/DKIM/DMARC and deliverability are yours to set up), and webhooks against local receivers, not public ones.
- **Billing.** There is no payment provider integration; the operator sets plans.
- **Regulated use** (for example safety or medical evidence) needs an external audit and certification that this repository cannot provide.

**Deliberately not built**

- SAML and SCIM user provisioning: use your identity provider's OIDC bridge, and remove people in the identity provider and from the workspace.
- Billing and payments (see above).
- Paging of the gateways list: it is bounded by the plan's gateway limit.
- Webhook extras: automatic disabling of a failing endpoint, dual-secret rotation, a ping rate limit, event types beyond `job.finished` and `webhook.ping`.
- A `workspace delete` operator command: an administrator offboards through the API or console; the operator can list and restore.

**Launch checklist for a public, multi-tenant service.** The shipped defaults suit one organisation hosting its own copy; a service for strangers needs these set deliberately.

- `NODE_ENV=production` with `OIDC_ISSUER`, `OIDC_AUDIENCE` and https `CORS_ORIGINS` (the API refuses to start otherwise), no `DEV_BEARER_TOKEN`, and `METRICS_TOKEN` if `/metrics` is reachable.
- `DEFAULT_PLAN=free` and `MAX_WORKSPACES_PER_USER` set. The shipped `DEFAULT_PLAN=enterprise` has no limits at all, so with it anyone who can sign in gets an unlimited workspace and can create more of them.
- `TRUST_PROXY` equal to the number of proxy hops, and a proxy that overwrites `X-Forwarded-For` (the nginx in `docker-compose.scale.yml` does). With it unset, every client looks like the proxy: one client's failed logins lock out everyone, gateways included. With it set too high, a client can forge its address and dodge the per-IP limits.
- `REDIS_URL`, so rate limits are shared by the replicas; a memory limit on every replica (the scale compose file uses 512 MB) and alerts on restarts.
- Ship the container logs somewhere the database administrator cannot edit (audit anchoring depends on it), and take and test backups (see [Backup and restore](#backup-and-restore)).
- Set SMTP only after the plan limits above are in place: invitation mail goes out from your domain.
- Revoke a person's API keys when you remove them; keys outlive their creator's membership.

**Design limits to know about**

- A tenant can use the shared pieces more than its share: the live-stream cap (`SSE_MAX_CLIENTS`) is per replica, not per workspace, so a tenant with many API keys can fill it and the others fall back to polling; the outbox is one queue for all tenants, so webhooks to very slow or non-resolving hostnames delay other tenants' deliveries (hostname lookups share Node's small thread pool, `UV_THREADPOOL_SIZE`); and a signed-in user's request body is read (up to `MAX_JSON_BYTES`, 8 MiB on evidence routes) before the workspace role is checked. The plan limits and the per-user rate limits bound all three but do not make them fair per tenant. Watch `wirepulse_sse_clients` against `SSE_MAX_CLIENTS`, and `wirepulse_outbox_messages_total` by `result` (a rising failure count is the sign of a stuck destination; there is no outbox-age gauge).
- A webhook administrator can tell an unresolvable hostname (`dns_failed`) from a blocked address (`destination_blocked`) in the delivery status, so they can probe whether an internal name exists.
- Rate limits are shared across replicas only when `REDIS_URL` is set and reachable; otherwise each replica counts separately and the effective limit is multiplied. A per-IP failure limiter refuses a locked IP entirely, which can affect everyone behind one NAT.
- Live-stream authorization is checked when the stream opens; streams are closed after at most `SSE_MAX_LIFETIME_SECONDS`, so a revoked user or key can keep an already-open stream for at most that long.
- Webhook and email delivery is at-least-once; receivers must deduplicate on `X-WirePulse-Delivery`. Messages that exhaust their attempts stay `failed` and can be redelivered only for webhooks.
- The outbox has no per-workspace index, so each purge slice of an offboarded workspace scans the outbox table. That is cheap at the default 14-day outbox retention; very large outboxes were not measured.
- Anchoring depends on you shipping the logs. A database superuser can edit the `audit_anchors` table; only the logged copy is independent. A mismatch is resolved by a person (see [Audit log](#audit-log)).
- Offboarding keeps the audit trail and the workspace tombstone after the purge; the audit trail cannot be erased per person.
- The console cannot tell whether an invitation email was actually sent, because the API does not report it.
- `audit` ids and `chain_seq` are 64-bit integers and travel as decimal strings in JSON.
