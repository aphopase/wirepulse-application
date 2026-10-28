import fs from "node:fs";
import { z } from "zod";
import { PLAN_NAMES } from "./plans.mjs";
import { parseCidr } from "./netguard.mjs";

export class ConfigError extends Error {
  constructor(problems) { super(`Invalid configuration:\n - ${problems.join("\n - ")}`); this.problems = problems; }
}

const int = (min, max, fallback) => z.coerce.number().int().min(min).max(max).default(fallback);
const flag = (fallback) => z.enum(["true", "false"]).default(fallback ? "true" : "false").transform((value) => value === "true");

const schema = z.object({
  NODE_ENV: z.string().optional(),
  PORT: int(0, 65535, 8080),
  DATABASE_URL: z.string().url(),
  DB_POOL_SIZE: int(1, 200, 10),
  DB_SSL: z.enum(["off", "require", "verify"]).default("off"),
  DB_SSL_CA_FILE: z.string().optional(),
  DB_STATEMENT_TIMEOUT_MS: int(100, 600_000, 15_000),
  DB_IDLE_TX_TIMEOUT_MS: int(100, 600_000, 15_000),
  DB_CONNECT_TIMEOUT_MS: int(100, 120_000, 5_000),
  MIGRATE_ON_START: flag(true),
  CORS_ORIGINS: z.string().optional(),
  TRUST_PROXY: z.string().optional(),
  OIDC_ISSUER: z.string().url().optional(),
  OIDC_AUDIENCE: z.string().min(1).optional(),
  OIDC_JWKS_URI: z.string().url().optional(),
  OIDC_TRUST_UNVERIFIED_EMAIL: flag(false),
  DEV_BEARER_TOKEN: z.string().min(8).optional(),
  DEV_SUBJECT: z.string().min(1).max(200).optional(),
  DEV_EMAIL: z.string().max(200).optional(),
  RATE_LIMIT_PER_MINUTE: int(1, 1_000_000, 240),
  RATE_LIMIT_IP_PER_MINUTE: int(1, 1_000_000, 1200),
  GATEWAY_RATE_LIMIT_PER_MINUTE: int(1, 1_000_000, 600),
  AUTH_FAILURE_LIMIT_PER_MINUTE: int(1, 100_000, 30),
  MAX_JSON_BYTES: int(1024, 16_777_216, 262_144),
  MAX_EVIDENCE_BYTES: int(1024, 67_108_864, 8_388_608),
  MAX_QUEUED_JOBS_PER_WORKSPACE: int(1, 1_000_000, 1000),
  JOB_LEASE_SECONDS: int(5, 3600, 60),
  JOB_MAX_ATTEMPTS: int(1, 10, 3),
  SWEEP_INTERVAL_MS: int(100, 600_000, 5000),
  QUEUE_TTL_SECONDS: int(0, 31_536_000, 86_400),
  INVITATION_TTL_DAYS: int(1, 90, 7),
  API_KEY_MAX_DAYS: int(1, 3650, 365),
  RETENTION_DAYS_JOBS: int(0, 36_500, 0),
  RETENTION_DAYS_REPORTS: int(0, 36_500, 0),
  RETENTION_DAYS_AUDIT: int(0, 36_500, 0),
  RETENTION_INTERVAL_HOURS: int(1, 720, 24),
  SSE_MAX_CLIENTS: int(1, 100_000, 500),
  SSE_HEARTBEAT_MS: int(1000, 120_000, 15_000),
  SSE_MAX_LIFETIME_SECONDS: int(10, 86_400, 1800),
  DEFAULT_PLAN: z.enum(PLAN_NAMES).default("enterprise"),
  MAX_WORKSPACES_PER_USER: int(0, 10_000, 0),
  WORKSPACE_PURGE_GRACE_DAYS: int(0, 365, 30),
  WORKSPACE_PURGE_INTERVAL_MS: int(100, 86_400_000, 300_000),
  REDIS_URL: z.string().regex(/^rediss?:\/\//, "must start with redis:// or rediss://").optional(),
  SMTP_URL: z.string().regex(/^smtps?:\/\//, "must start with smtp:// or smtps://").optional(),
  SMTP_FROM: z.string().max(254).optional(),
  INVITE_BASE_URL: z.string().url().optional(),
  WEBHOOK_SIGNING_KEY: z.string().min(32).optional(),
  WEBHOOK_ALLOW_PRIVATE_NETWORKS: flag(false),
  WEBHOOK_ALLOWED_CIDRS: z.string().max(2000).optional(),
  WEBHOOK_TIMEOUT_MS: int(500, 60_000, 5000),
  OUTBOX_INTERVAL_MS: int(100, 600_000, 2000),
  OUTBOX_MAX_ATTEMPTS: int(1, 30, 8),
  OUTBOX_RETENTION_DAYS: int(1, 365, 14),
  AUDIT_ANCHOR_INTERVAL_MINUTES: int(0, 10_080, 0),
  METRICS_TOKEN: z.string().optional(),
  METRICS_PORT: int(0, 65535, 0),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info")
});

// NAME, or the file named by NAME_FILE (Docker/Kubernetes secrets), so secrets never have to sit in the environment.
function readSetting(env, name, problems) {
  const file = env[`${name}_FILE`];
  if (!file) return env[name];
  try { return fs.readFileSync(file, "utf8").trim(); } catch (error) { problems.push(`${name}_FILE (${file}) cannot be read: ${error.code ?? error.message}`); return undefined; }
}

function parseTrustProxy(value) {
  if (value === undefined || value === "false") return false;
  if (value === "true") return true;
  if (/^\d+$/.test(value)) return Number(value);
  return value;
}

export function loadConfig(env = process.env) {
  const problems = [];
  const warnings = [];
  const raw = {};
  for (const name of Object.keys(schema.shape)) {
    const value = readSetting(env, name, problems);
    if (value !== undefined && value !== "") raw[name] = value;
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) for (const issue of parsed.error.issues) problems.push(`${issue.path.join(".")}: ${issue.message}`);
  if (problems.length) throw new ConfigError(problems);
  const v = parsed.data;
  const production = v.NODE_ENV === "production";

  const corsOrigins = (v.CORS_ORIGINS ?? (production ? "" : "http://localhost:5173")).split(",").map((item) => item.trim()).filter(Boolean);
  for (const origin of corsOrigins) {
    let url;
    try { url = new URL(origin); } catch { problems.push(`CORS_ORIGINS entry "${origin}" is not a URL origin`); continue; }
    if (url.origin !== origin) problems.push(`CORS_ORIGINS entry "${origin}" must be an origin without path or trailing slash (${url.origin})`);
    if (production && url.protocol !== "https:") problems.push(`CORS_ORIGINS entry "${origin}" must use https in production`);
  }
  if (production && !corsOrigins.length) problems.push("CORS_ORIGINS must list the exact https browser origin(s) in production");

  if (Boolean(v.OIDC_ISSUER) !== Boolean(v.OIDC_AUDIENCE)) problems.push("OIDC_ISSUER and OIDC_AUDIENCE must be set together");
  if (production) {
    if (v.DEV_BEARER_TOKEN) problems.push("DEV_BEARER_TOKEN must not be set in production; configure OIDC instead");
    if (!v.OIDC_ISSUER) problems.push("OIDC_ISSUER and OIDC_AUDIENCE are required in production");
    if (v.OIDC_ISSUER && !v.OIDC_ISSUER.startsWith("https://")) problems.push("OIDC_ISSUER must use https in production");
    if (v.OIDC_JWKS_URI && !v.OIDC_JWKS_URI.startsWith("https://")) problems.push("OIDC_JWKS_URI must use https in production");
  } else if (!v.OIDC_ISSUER && !v.DEV_BEARER_TOKEN) warnings.push("neither OIDC nor DEV_BEARER_TOKEN is configured; every /v1 request will be rejected");
  if (v.METRICS_TOKEN && v.METRICS_TOKEN.length < 24) problems.push("METRICS_TOKEN must be at least 24 characters");
  if (v.SMTP_URL && !v.SMTP_FROM) problems.push("SMTP_FROM is required when SMTP_URL is set");
  if (v.SMTP_FROM && !/^[^\s<>@]+@[^\s<>@]+$|^[^<>]+<[^\s<>@]+@[^\s<>@]+>$/.test(v.SMTP_FROM)) problems.push("SMTP_FROM must be an address or Name <address>");
  if (production && v.WEBHOOK_ALLOW_PRIVATE_NETWORKS) problems.push("WEBHOOK_ALLOW_PRIVATE_NETWORKS must not be enabled in production (it disables SSRF protection)");
  const allowedCidrs = (v.WEBHOOK_ALLOWED_CIDRS ?? "").split(",").map((item) => item.trim()).filter(Boolean);
  for (const cidr of allowedCidrs) { try { parseCidr(cidr); } catch (error) { problems.push(`WEBHOOK_ALLOWED_CIDRS: ${error.message}`); } }
  if (allowedCidrs.length && !v.WEBHOOK_SIGNING_KEY) warnings.push("WEBHOOK_ALLOWED_CIDRS has no effect without WEBHOOK_SIGNING_KEY (webhooks are off)");
  let smtpTls = null;
  if (v.SMTP_URL) {
    try {
      const smtp = new URL(v.SMTP_URL);
      if (!smtp.hostname) problems.push("SMTP_URL has no host");
      const params = [...smtp.searchParams.keys()];
      if (params.some((key) => key !== "tls") || (smtp.searchParams.has("tls") && smtp.searchParams.get("tls") !== "none")) problems.push("SMTP_URL: the only supported query parameter is tls=none");
      smtpTls = smtp.searchParams.get("tls");
    } catch { problems.push("SMTP_URL is not a valid URL"); }
  }
  if (production && smtpTls === "none") problems.push("SMTP_URL must not use tls=none in production (mail would travel unencrypted)");

  let ssl;
  if (v.DB_SSL === "require") ssl = { rejectUnauthorized: false };
  if (v.DB_SSL === "verify") {
    ssl = { rejectUnauthorized: true };
    if (v.DB_SSL_CA_FILE) { try { ssl.ca = fs.readFileSync(v.DB_SSL_CA_FILE, "utf8"); } catch (error) { problems.push(`DB_SSL_CA_FILE (${v.DB_SSL_CA_FILE}) cannot be read: ${error.code ?? error.message}`); } }
  }
  if (problems.length) throw new ConfigError(problems);

  if (production && v.DB_SSL === "off") warnings.push("DB_SSL=off: database traffic is not encrypted; acceptable only on a private network");
  if (production && v.TRUST_PROXY === undefined) warnings.push("TRUST_PROXY is unset: client IPs (rate limits, audit) will be the reverse proxy's address");
  if (v.DB_SSL === "require") warnings.push("DB_SSL=require encrypts but does not verify the server certificate; use DB_SSL=verify");

  return Object.freeze({
    production,
    port: v.PORT,
    logLevel: v.LOG_LEVEL,
    databaseUrl: v.DATABASE_URL,
    db: { poolSize: v.DB_POOL_SIZE, ssl, statementTimeoutMs: v.DB_STATEMENT_TIMEOUT_MS, idleTxTimeoutMs: v.DB_IDLE_TX_TIMEOUT_MS, connectTimeoutMs: v.DB_CONNECT_TIMEOUT_MS },
    migrateOnStart: v.MIGRATE_ON_START,
    corsOrigins,
    trustProxy: parseTrustProxy(v.TRUST_PROXY),
    oidc: v.OIDC_ISSUER ? { issuer: v.OIDC_ISSUER.replace(/\/$/, ""), audience: v.OIDC_AUDIENCE, jwksUri: v.OIDC_JWKS_URI ?? null, trustUnverifiedEmail: v.OIDC_TRUST_UNVERIFIED_EMAIL } : null,
    dev: v.DEV_BEARER_TOKEN ? { token: v.DEV_BEARER_TOKEN, subject: v.DEV_SUBJECT ?? "dev-admin", email: v.DEV_EMAIL ?? "admin@wirepulse.local" } : null,
    limits: { subjectPerMinute: v.RATE_LIMIT_PER_MINUTE, ipPerMinute: v.RATE_LIMIT_IP_PER_MINUTE, gatewayPerMinute: v.GATEWAY_RATE_LIMIT_PER_MINUTE, authFailurePerMinute: v.AUTH_FAILURE_LIMIT_PER_MINUTE, jsonBytes: v.MAX_JSON_BYTES, evidenceBytes: v.MAX_EVIDENCE_BYTES, maxQueuedJobs: v.MAX_QUEUED_JOBS_PER_WORKSPACE },
    jobs: { leaseSeconds: v.JOB_LEASE_SECONDS, maxAttempts: v.JOB_MAX_ATTEMPTS, sweepIntervalMs: v.SWEEP_INTERVAL_MS, queueTtlSeconds: v.QUEUE_TTL_SECONDS },
    invitationTtlDays: v.INVITATION_TTL_DAYS,
    apiKeyMaxDays: v.API_KEY_MAX_DAYS,
    retention: { jobsDays: v.RETENTION_DAYS_JOBS, reportsDays: v.RETENTION_DAYS_REPORTS, auditDays: v.RETENTION_DAYS_AUDIT, intervalHours: v.RETENTION_INTERVAL_HOURS },
    sse: { maxClients: v.SSE_MAX_CLIENTS, heartbeatMs: v.SSE_HEARTBEAT_MS, maxLifetimeMs: v.SSE_MAX_LIFETIME_SECONDS * 1000 },
    metrics: { token: v.METRICS_TOKEN ?? null, port: v.METRICS_PORT },
    saas: { defaultPlan: v.DEFAULT_PLAN, maxWorkspacesPerUser: v.MAX_WORKSPACES_PER_USER, purgeGraceDays: v.WORKSPACE_PURGE_GRACE_DAYS, purgeIntervalMs: v.WORKSPACE_PURGE_INTERVAL_MS },
    redis: v.REDIS_URL ? { url: v.REDIS_URL } : null,
    smtp: v.SMTP_URL ? { url: v.SMTP_URL, from: v.SMTP_FROM, inviteBaseUrl: v.INVITE_BASE_URL ?? null } : null,
    webhooks: v.WEBHOOK_SIGNING_KEY ? { signingKey: v.WEBHOOK_SIGNING_KEY, allowPrivateNetworks: v.WEBHOOK_ALLOW_PRIVATE_NETWORKS, allowedCidrs, timeoutMs: v.WEBHOOK_TIMEOUT_MS } : null,
    outbox: { intervalMs: v.OUTBOX_INTERVAL_MS, maxAttempts: v.OUTBOX_MAX_ATTEMPTS, retentionDays: v.OUTBOX_RETENTION_DAYS },
    anchorIntervalMinutes: v.AUDIT_ANCHOR_INTERVAL_MINUTES,
    warnings
  });
}
