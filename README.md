# WirePulse

WirePulse is an original browser serial monitor with automated hardware validation. It uses the Web Serial API, so serial communication stays in the browser. An optional self-hosted control plane adds shared configuration, roles, queued test runs on lab machines, tamper-evident results and audit, and never receives serial bytes.

| Document | What it covers |
|---|---|
| [USER_GUIDE.md](USER_GUIDE.md) | **Start here if you use WirePulse:** step-by-step guide to connecting a device, sending commands, charts, hardware tests, and the team workspace, with troubleshooting |
| [DEPLOYMENT.md](DEPLOYMENT.md) | Deploying and operating the control plane and gateway agents, configuration reference, scale-out, plans and offboarding, webhooks and email, backup/restore, monitoring, and the **readiness and known limits** |
| [ENTERPRISE.md](ENTERPRISE.md) | Security model and what the enterprise features do and do not do |
| [docs/openapi.yaml](docs/openapi.yaml) | The HTTP API contract (OpenAPI 3.0.3), checked against the running server by the tests |

## Run the browser app

```sh
npm install
npm run dev
```

Open the HTTPS or localhost URL in Chrome or Edge. USB serial access requires an explicit browser permission.

## Features

- Web Serial connect/disconnect; baud, data bits, stop bits, parity, and RTS/CTS settings
- ASCII, hexadecimal, and binary display; LF, CR, CRLF, and no line-ending transmission
- Terminal send/receive with RX/TX counters; clear, pause, auto-scroll, TXT and CSV export
- Four quick command macros; TEMP0–TEMP9 telemetry charts; basic RMC/GGA NMEA position and satellite parsing
- Local device profiles with JSON import/export
- Automated hardware validation with retries, post-command response windows, stale-response rejection, tamper-evident evidence chains, and CSV reports
- Privacy-preserving report verification: test/profile/engine fingerprints and evidence hashes are uploaded; raw serial logs and bytes stay local
- Raw-byte recording/export and configurable binary-frame inspection
- Obsidian, Nord, Amber, and Phosphor themes
- **Enterprise console** (after connecting a workspace): live job list with JUnit download and evidence details, gateway registration/rotation/revocation, members and invitations, CI API keys, signed webhooks with a delivery log, plan and usage with workspace offboarding

Shortcuts: Ctrl+L clear, Ctrl+S export TXT, Ctrl+D disconnect.

## Enterprise control plane

```sh
./scripts/init-secrets.sh          # random database secrets in ./secrets
cp .env.example .env               # set CORS_ORIGINS, OIDC_ISSUER, OIDC_AUDIENCE, TRUST_PROXY
docker compose up -d --build       # postgres → one-shot migration → API on 127.0.0.1:8080
```

Browsers queue jobs; a gateway agent on the lab machine owns the serial port and runs them:

1. Register a gateway in the console (Gateways tab, maintainer role). The `wpg_…` token is shown once and stored only as a hash.
2. On the lab host run the agent from `gateway/` (`WIREPULSE_API_URL`, `WIREPULSE_GATEWAY_TOKEN_FILE`, `WIREPULSE_SERIAL_PATH`; a systemd unit is in `gateway/deploy/`).
3. Queue jobs from the browser or CI. Jobs are claimed with `FOR UPDATE SKIP LOCKED` and leased; expired leases are requeued and after `JOB_MAX_ATTEMPTS` the job becomes `timed_out`.
4. The API re-verifies the hash-linked evidence and derives the final status itself; the gateway's claim is not trusted.

Schema changes are versioned in `api/migrations`.

### Running it as a service

The same image scales out and can run multi-tenant:

- **Scale:** `docker compose -f docker-compose.yml -f docker-compose.scale.yml up -d --build --scale api=3` runs three replicas behind nginx with Redis for shared rate limits. Jobs, claims, quotas, audit and live updates are coordinated in PostgreSQL, so any replica can serve any request. `node scripts/loadtest.mjs` measures throughput and checks that no job ran twice and every audit chain still verifies.
- **SaaS:** per-workspace plans (`free`, `team`, `business`, `enterprise`) with quotas, usage metering and a per-workspace request budget; `DEFAULT_PLAN`, `MAX_WORKSPACES_PER_USER`; an operator CLI (`docker compose exec api node src/admin-cli.mjs plan set|show`, `workspace list|restore`); workspace offboarding with a restore window. Billing is not included.
- **Integrations:** HMAC-signed webhooks (`job.finished`) with retries, redelivery and SSRF protection, and invitation email, both through a durable outbox. Off until `WEBHOOK_SIGNING_KEY` / `SMTP_URL` are set.
- **Audit anchoring:** `AUDIT_ANCHOR_INTERVAL_MINUTES` logs each chain head so tampering with the database is detectable.

Everything is described, with what was and was not tested, in [DEPLOYMENT.md](DEPLOYMENT.md).

## Tests

```sh
export WP_TEST_DATABASE_URL=postgresql://user:pw@127.0.0.1:5432/postgres   # a disposable server: each test file creates and drops its own database
export WP_TEST_REDIS_URL=redis://127.0.0.1:6379                              # a disposable Redis, for the shared rate-limit tests
(cd api && npm test)               # API integration tests (167) and the OpenAPI contract test; runs 5 files in parallel
(cd gateway && npm test)           # gateway agent (22)
npm run typecheck
npm run dev &                      # Playwright expects the dev server on http://127.0.0.1:5173
npm run test:e2e                   # browser tests (14); the live-console spec runs the real API, PostgreSQL and an agent
```

Without `WP_TEST_DATABASE_URL` the database-backed tests and the live-console spec are skipped, not failed; without `WP_TEST_REDIS_URL` only the Redis tests are skipped. Check the summary line for `skipped 0` before trusting a green run. The Redis tests delete every `wirepulse:rl:*` key they find, so never point `WP_TEST_REDIS_URL` at a Redis that holds anything else.

## Status

Validated with a simulated serial transport, and for sign-in against a real Keycloak 26 (production mode, over https) but not your identity provider. Still to be done by you: real USB/UART hardware, load and failover at your scale (a three-replica baseline, a five-minute soak and a PostgreSQL-restart drill exist), your own identity provider, a real SMTP provider, billing, and an independent security assessment (details in [DEPLOYMENT.md](DEPLOYMENT.md#readiness-and-known-limits)). Regulated deployment needs external audit.

WirePulse is an independent implementation and does not copy SerialX source code or branding.
