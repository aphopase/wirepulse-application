import { z } from "zod";

export class HttpError extends Error {
  constructor(status, code, details) { super(code); this.status = status; this.code = code; this.details = details; }
}

// Express 4 does not forward rejected promises from async handlers.
export const h = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Rejects malformed identifiers before they reach PostgreSQL (which would answer 22P02).
export function validateUuidParams(app, names) {
  for (const name of names) app.param(name, (_req, _res, next, value) => (UUID.test(value) ? next() : next(new HttpError(400, "invalid_identifier", { param: name }))));
}

export function parseLimit(value, { fallback = 50, max = 200 } = {}) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? Math.min(max, Math.max(1, parsed)) : fallback;
}

// Opaque keyset cursor over (timestamp, id); the client only passes it back.
// PostgreSQL timestamps have microsecond precision but a JS Date only keeps milliseconds, so list queries select
// CURSOR_AT (a microsecond ISO string) and the cursor carries it verbatim; otherwise rows created in one millisecond are skipped.
export const CURSOR_AT = `to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_at`;
export const encodeCursor = (at, id) => Buffer.from(JSON.stringify([typeof at === "string" ? at : new Date(at).toISOString(), String(id)])).toString("base64url");
export function decodeCursor(cursor) {
  if (!cursor) return null;
  try {
    const [at, id] = JSON.parse(Buffer.from(String(cursor), "base64url").toString("utf8"));
    if (Number.isNaN(Date.parse(at)) || typeof id !== "string") throw new Error("bad cursor");
    return { at, id };
  } catch { throw new HttpError(400, "invalid_cursor"); }
}

export function publicJob(row, { detail = false } = {}) {
  const job = {
    id: row.id, suiteId: row.suite_id, status: row.status, gatewayId: row.gateway_id, priority: row.priority, requirements: row.requirements,
    progress: row.progress, summary: row.summary, error: row.error, attempts: row.attempts, maxAttempts: row.max_attempts, version: row.version,
    suiteVersion: row.suite_version, profileId: row.profile_id, profileVersion: row.profile_version, definitionHash: row.definition_hash,
    agentVersion: row.agent_version, engineFingerprint: row.engine_fingerprint, requestedBy: row.requested_by,
    createdAt: row.created_at, startedAt: row.started_at, finishedAt: row.finished_at, leaseExpiresAt: row.lease_expires_at
  };
  // Definitions and evidence can be large; lists and live updates omit them.
  if (detail) { job.definition = row.definition; job.result = row.result; }
  return job;
}

export const JOB_COLUMNS = "id, workspace_id, suite_id, requested_by, status, gateway_id, priority, requirements, progress, summary, error, attempts, max_attempts, version, suite_version, profile_id, profile_version, definition_hash, agent_version, engine_fingerprint, created_at, started_at, finished_at, lease_expires_at";
export const JOB_DETAIL_COLUMNS = `${JOB_COLUMNS}, definition, result`;

// Maps known failures to stable client-facing codes. Anything else is a 500 that never leaks internals.
export function errorHandler({ log, metrics }) {
  return (error, req, res, _next) => {
    if (res.headersSent) return res.destroy();
    const reply = (status, code, details) => res.status(status).json({ error: code, requestId: req.requestId, ...(details ? { details } : {}) });
    if (error instanceof z.ZodError) return reply(400, "invalid_request", error.flatten());
    if (error instanceof HttpError) return reply(error.status, error.code, error.details);
    if (error.type === "entity.too.large") return reply(413, "payload_too_large");
    if (error.type === "entity.parse.failed" || error.type === "encoding.unsupported" || error.type === "charset.unsupported") return reply(400, "invalid_json");
    if (error.type === "request.aborted") return undefined;
    switch (error.code) {
      case "23505": return reply(409, "conflict");
      case "23503": return reply(409, "referenced_resource_missing");
      case "23001": return reply(409, "operation_not_permitted");
      case "22P02": case "22007": case "22003": return reply(400, "invalid_value");
      case "57014": metrics?.dbTimeouts.inc(); (req.log ?? log).error({ err: error }, "database statement timeout"); return reply(503, "database_timeout");
      case "57P01": case "08006": case "08001": case "08003": (req.log ?? log).error({ err: error }, "database unavailable"); return reply(503, "database_unavailable");
      default: break;
    }
    (req.log ?? log).error({ err: error }, "unhandled request error");
    return reply(500, "internal_error");
  };
}
