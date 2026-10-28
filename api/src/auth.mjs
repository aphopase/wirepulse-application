import crypto from "node:crypto";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { HttpError } from "./http.mjs";

export const ROLE_ORDER = { viewer: 0, engineer: 1, maintainer: 2, administrator: 3 };
const ASYMMETRIC = ["RS256", "RS384", "RS512", "PS256", "PS384", "PS512", "ES256", "ES384", "ES512", "EdDSA"];
const BEARER = /^Bearer\s+(\S+)$/i;

export const sha256 = (value) => crypto.createHash("sha256").update(value).digest("hex");
export const newToken = (prefix) => `${prefix}_${crypto.randomBytes(32).toString("base64url")}`;
export const bearerToken = (req) => BEARER.exec(req.get("authorization") ?? "")?.[1] ?? null;

export function safeEqual(a, b) {
  return crypto.timingSafeEqual(crypto.createHash("sha256").update(a).digest(), crypto.createHash("sha256").update(b).digest());
}

// Authentication for the human/CI API (/v1): API keys (wpk_), the development token, or OIDC JWTs.
// Failures are logged as security events and counted; the credential itself is never logged.
export function createAuth({ config, db, log, metrics, workspaceLimiter = (_req, _res, next) => next(), onAuthFailure = async () => {} }) {
  // Where the signing keys live: OIDC_JWKS_URI if set, otherwise whatever the issuer's discovery document says (every standard IdP
  // publishes it there, at a different path each). A failed discovery is retried after 30 seconds, not on every request.
  let keys = null; let retryAt = 0;
  async function discover() {
    let uri = config.oidc.jwksUri;
    if (!uri) {
      const response = await fetch(`${config.oidc.issuer}/.well-known/openid-configuration`, { signal: AbortSignal.timeout(5000) });
      const document = response.ok ? await response.json() : null;
      if (String(document?.issuer).replace(/\/$/, "") !== config.oidc.issuer || typeof document.jwks_uri !== "string") throw new Error("oidc_discovery_invalid");
      if (config.production && !document.jwks_uri.startsWith("https://")) throw new Error("oidc_discovery_insecure");
      uri = document.jwks_uri;
    }
    return createRemoteJWKSet(new URL(uri), { timeoutDuration: 5000, cooldownDuration: 30_000 });
  }
  function keySet() {
    if (!keys && Date.now() < retryAt) throw new Error("oidc_discovery_unavailable");
    keys ??= discover().catch((error) => { keys = null; retryAt = Date.now() + 30_000; throw error; });
    return keys;
  }

  async function reject(req, res, kind, reason, status = 401, code = "invalid_bearer_token") {
    metrics?.authFailures.inc({ kind, reason });
    (req.log ?? log).warn({ security: true, event: "auth.failed", kind, reason, ip: req.ip, path: req.path }, "authentication failed");
    await onAuthFailure(req); // counted before the answer leaves, so the very next attempt already sees it
    return res.status(status).json({ error: code, requestId: req.requestId });
  }

  async function apiKeyIdentity(token) {
    const result = await db.query(
      "UPDATE api_keys SET last_used_at = now() WHERE token_hash = $1 AND revoked_at IS NULL AND expires_at > now() AND (last_used_at IS NULL OR last_used_at < now() - interval '1 minute') RETURNING id, workspace_id, role",
      [sha256(token)]
    );
    let row = result.rows[0];
    // The throttled UPDATE returns nothing when the key was used within the last minute; read it instead.
    if (!row) row = (await db.query("SELECT id, workspace_id, role FROM api_keys WHERE token_hash = $1 AND revoked_at IS NULL AND expires_at > now()", [sha256(token)])).rows[0];
    return row ? { kind: "api_key", subject: `apikey:${row.id}`, email: null, emailVerified: false, apiKey: { id: row.id, workspaceId: row.workspace_id, role: row.role } } : null;
  }

  async function oidcIdentity(token) {
    const { payload } = await jwtVerify(token, await keySet(), { issuer: config.oidc.issuer, audience: config.oidc.audience, algorithms: ASYMMETRIC, clockTolerance: 30 });
    if (typeof payload.sub !== "string" || !payload.sub) throw new Error("subject_missing");
    const emailVerified = payload.email_verified === true || config.oidc.trustUnverifiedEmail;
    return { kind: "user", subject: payload.sub, email: emailVerified && typeof payload.email === "string" ? payload.email.toLowerCase() : null, emailVerified };
  }

  const identity = async (req, res, next) => {
    const token = bearerToken(req);
    if (!token) return reject(req, res, "none", "missing_token", 401, "bearer_token_required");
    try {
      let who = null;
      if (token.startsWith("wpk_")) {
        who = await apiKeyIdentity(token);
        if (!who) return reject(req, res, "api_key", "unknown_expired_or_revoked");
      } else if (config.dev && safeEqual(token, config.dev.token)) {
        who = { kind: "user", subject: config.dev.subject, email: config.dev.email, emailVerified: true };
      } else if (config.oidc) {
        try { who = await oidcIdentity(token); } catch (error) { return reject(req, res, "oidc", error.code ?? error.message); }
      } else return reject(req, res, "none", "no_identity_provider", 401, "invalid_bearer_token");
      req.identity = who;
      return next();
    } catch (error) { return next(error); }
  };

  // Resolves the caller's role in the workspace named by the route. API keys carry their own workspace and role.
  const requireRole = (minimum) => async (req, res, next) => {
    try {
      const workspaceId = req.params.workspaceId;
      if (!workspaceId) throw new HttpError(400, "workspace_id_required");
      // A deleted workspace answers like an unknown one. The plan rides along for quota and rate-limit decisions.
      let role = null; let plan = null;
      if (req.identity.apiKey) {
        if (req.identity.apiKey.workspaceId === workspaceId) {
          const workspace = (await db.query("SELECT plan FROM workspaces WHERE id = $1 AND deleted_at IS NULL", [workspaceId])).rows[0];
          if (workspace) { role = req.identity.apiKey.role; plan = workspace.plan; }
        }
      } else {
        const member = (await db.query("SELECT m.role, w.plan FROM workspace_members m JOIN workspaces w ON w.id = m.workspace_id WHERE m.workspace_id = $1 AND m.subject = $2 AND w.deleted_at IS NULL", [workspaceId, req.identity.subject])).rows[0];
        if (member) { role = member.role; plan = member.plan; }
      }
      if (!role || ROLE_ORDER[role] < ROLE_ORDER[minimum]) {
        (req.log ?? log).warn({ security: true, event: "authz.denied", subject: req.identity.subject, workspaceId, required: minimum, ip: req.ip }, "authorization denied");
        throw new HttpError(403, "insufficient_workspace_role");
      }
      req.workspaceId = workspaceId;
      req.workspaceRole = role;
      req.workspacePlan = plan;
      workspaceLimiter(req, res, next);
    } catch (error) { next(error); }
  };

  // Gateways authenticate with their own token and may only touch their workspace's jobs.
  const gatewayAuth = async (req, res, next) => {
    const token = bearerToken(req);
    if (!token?.startsWith("wpg_")) return reject(req, res, "gateway", "missing_or_wrong_token_type", 401, "gateway_token_required");
    try {
      const result = await db.query("SELECT g.id, g.workspace_id, g.name, g.labels, g.agent_version FROM gateways g JOIN workspaces w ON w.id = g.workspace_id WHERE g.token_hash = $1 AND g.revoked_at IS NULL AND (g.token_expires_at IS NULL OR g.token_expires_at > now()) AND w.deleted_at IS NULL", [sha256(token)]);
      if (!result.rowCount) return reject(req, res, "gateway", "unknown_expired_or_revoked", 401, "invalid_gateway_token");
      req.gateway = result.rows[0];
      return next();
    } catch (error) { return next(error); }
  };

  return { identity, requireRole, gatewayAuth };
}

// Human-only: API keys cannot create workspaces or manage who has access.
export function requireHuman(req, _res, next) {
  next(req.identity.kind === "user" ? undefined : new HttpError(403, "human_identity_required"));
}
