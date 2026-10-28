# WirePulse enterprise overview

WirePulse is local-first: the browser talks to USB serial devices directly through the Web Serial API. The optional self-hosted control plane adds what teams need on top (shared configuration, roles, queued test runs on lab machines, tamper-evident results, audit) without ever receiving serial bytes. Setup and operations are in [DEPLOYMENT.md](DEPLOYMENT.md); the HTTP contract is [docs/openapi.yaml](docs/openapi.yaml).

## What is in the box

**Browser app** — serial monitor (ASCII/hex/binary, filters, recording and replay, telemetry, NMEA), automated hardware validation (command sequences, text and telemetry assertions, timeouts, retries, response windows, stale-output rejection, CSV reports), local device profiles with JSON import/export, and the **Enterprise console** (Jobs, Gateways, Team, API keys, Webhooks, Usage) that appears after you connect a workspace.

**Control plane** (`api/`, PostgreSQL) — OIDC sign-in, workspaces with four roles, versioned shared profiles and test suites, a job queue with leases, API keys for CI, gateway registration, test-report storage with JUnit export, live job updates (Server-Sent Events), Prometheus metrics, retention, and a hash-chained audit log with optional external anchoring. For running it as a service it adds per-workspace plans and quotas with usage metering, signed webhooks and invitation email through a durable outbox, workspace offboarding with a restore window, an operator CLI, and horizontal scale-out (several API replicas, Redis for shared rate limits).

**Gateway agent** (`gateway/`) — runs on the lab machine that owns the serial port, polls for jobs over outbound HTTPS, executes them and uploads hash-linked evidence.

## Security model

- **Identity**: OIDC JWTs validated against the issuer's keys; MFA and session policy are the identity provider's job. Invitations bind to a *verified* email. A development token exists only outside production and is refused in production.
- **Authorization**: server-side roles (viewer < engineer < maintainer < administrator) on every workspace route; the browser hides controls the user cannot use but is never trusted. Non-members, unknown workspaces and low roles get one identical `403`, so workspace ids cannot be probed.
- **Machine credentials**: gateway tokens (`wpg_…`) and API keys (`wpk_…`) are stored only as hashes and shown once. API keys are workspace-scoped, capped at maintainer, always expire, and cannot be created by another key. Both can be revoked; gateway tokens can be rotated, which stops the old agent.
- **Tenant isolation**: every query is scoped by workspace and PostgreSQL foreign keys back it; the test suite includes a cross-workspace matrix.
- **Audit**: every change is recorded with actor, request id and client address in an append-only, SHA-256 hash-chained log (verify and NDJSON export for administrators). Anchor the chain head outside the database to detect a full rewrite by a database superuser.
- **Evidence**: the browser (or gateway) hash-chains the run events; the API recomputes the chain itself, derives the pass/fail status itself, and rejects raw serial-data fields. Uploaded evidence is *what happened during the run as recorded by the client*, not proof about the device.
- **Hardening**: request size limits, security headers, rate limits per user, per IP, per gateway and per workspace (shared across replicas through Redis), an authentication-failure limiter, narrow CORS, structured logs with secret redaction, a non-root read-only container.
- **Outbound calls**: webhooks are HMAC-signed with a per-endpoint secret that is shown once; the destination is resolved once, vetted (private, link-local and cloud-metadata ranges refused unless the operator allow-lists a private range) and then connected to by that vetted address; certificates are always verified; redirects are not followed and responses are never read or kept. Email is plain text from a fixed template over STARTTLS or TLS.
- **Data controls**: serial logs and raw bytes stay local unless the user exports them; retention windows are configurable and each purge is audited. An administrator can offboard a workspace by typing its exact name; access, keys, gateways and webhooks stop at once, the content is purged after a grace period the operator can restore within, and the audit trail remains.

## What it deliberately does not do

- **No SAML or SCIM.** Sign-in is OIDC only (use your identity provider's OIDC bridge for SAML), and people are added by invitation, not provisioned. Remove a leaver at the identity provider and from the workspace.
- **No billing.** Plans and quotas are enforced, but the operator changes a workspace's plan (a CLI command); connect your own billing system to it.
- **Webhooks are minimal:** two event types (`job.finished`, `webhook.ping`), at-least-once delivery, no automatic disabling of a failing endpoint and no overlap period when a secret is rotated.
- **Email is for invitations only.** The API cannot tell the console whether a given invitation was mailed.
- No multi-region deployment and no customer-managed-key storage. High availability of PostgreSQL and Redis is yours to provide.
- Access tokens are kept in memory only. Browser `localStorage` holds convenience data (profiles, macros, the control-plane URL) and is not a security boundary.
- Device commands are sent only after a user connects a port, starts a local test run, or a gateway you registered claims a job you queued.

## Honest status

The control plane, gateway agent and console are covered by automated tests, including browser tests against the real API and database (counts and the full list of what is *not* verified are in [DEPLOYMENT.md](DEPLOYMENT.md#readiness-and-known-limits)). Before relying on it: validate with your own hardware, run a load and failover test sized for your users, obtain an independent security review, and connect it to your real identity provider. Regulated use needs external audit.
