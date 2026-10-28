export type Role = "viewer" | "engineer" | "maintainer" | "administrator";
export type JobStatus = "queued" | "assigned" | "running" | "passed" | "failed" | "stopped" | "cancelled" | "timed_out";
export type EnterpriseWorkspace = { id: string; name: string; role: Role; createdAt: string };
export type EnterpriseResource = { id: string; name: string; definition: Record<string, unknown>; version: number; createdAt: string; updatedAt: string };
// List responses and stream events omit `definition` and `result`; only the single-job endpoint returns them.
export type EnterpriseTestJob = { id: string; suiteId?: string | null; profileId?: string | null; status: JobStatus; gatewayId: string | null; priority?: number; requirements?: Record<string, string>; progress: { completed: number; total: number } | null; summary: { passed: number; failed: number; total: number; evidenceSchema: string; evidenceFinalHash: string } | null; error: string | null; attempts: number; maxAttempts?: number; version?: number; definitionHash?: string; agentVersion?: string | null; engineFingerprint?: string | null; requestedBy?: string; createdAt: string; startedAt: string | null; finishedAt: string | null; leaseExpiresAt?: string | null; definition?: Record<string, unknown>; result?: Record<string, unknown> | null };
export type EnterpriseGateway = { id: string; name: string; online: boolean; labels: Record<string, string>; lastHeartbeatAt: string | null; agentVersion: string | null; capabilities: Record<string, unknown> | null; tokenExpiresAt: string | null; tokenRotatedAt: string | null; revokedAt: string | null; createdAt: string };
export type EnterpriseMember = { subject: string; email: string | null; role: Role; createdAt: string };
export type EnterpriseInvitation = { id: string; email: string; role: Role; invitedBy?: string; createdAt: string; expiresAt: string; acceptedBy: string | null; acceptedAt: string | null; revokedAt: string | null };
export type EnterpriseApiKey = { id: string; name: string; role: "viewer" | "engineer" | "maintainer"; prefix: string; createdBy?: string; createdAt: string; expiresAt: string; lastUsedAt: string | null; revokedAt: string | null };
export type PlanLimits = { members: number | null; gateways: number | null; apiKeys: number | null; webhooks: number | null; queuedJobs: number | null; jobsPerMonth: number | null; reportsPerMonth: number | null; requestsPerMinute: number | null };
export type WorkspaceUsage = { period: string; members: number; pendingInvitations: number; gateways: number; apiKeys: number; webhooks: number; queuedJobs: number; jobsThisMonth: number; reportsThisMonth: number };
export type EnterprisePlan = { plan: string; limits: PlanLimits; usage: WorkspaceUsage };
export type WebhookEvent = "job.finished";
export type EnterpriseWebhook = { id: string; name: string; url: string; events: WebhookEvent[]; enabled: boolean; secretVersion: number; createdBy: string; createdAt: string; updatedAt: string };
export type WebhookDeliveryStatus = "pending" | "delivered" | "failed";
export type EnterpriseWebhookDelivery = { id: string; eventType: string; status: WebhookDeliveryStatus; attempts: number; lastStatus?: number | null; lastError?: string | null; createdAt: string; nextAttemptAt?: string | null; finishedAt?: string | null };

export const ROLE_RANK: Record<Role, number> = { viewer: 0, engineer: 1, maintainer: 2, administrator: 3 };
// The server is the authority; this only decides which controls are worth showing.
export const hasRole = (have: Role, need: Role): boolean => ROLE_RANK[have] >= ROLE_RANK[need];

export class EnterpriseApiError extends Error {
  constructor(message: string, readonly status: number, readonly details?: unknown) { super(message); }
}

export async function enterpriseRequest<T>(apiUrl: string, token: string, path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`${apiUrl.replace(/\/$/, "")}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${token}`, accept: "application/json", ...(init.body ? { "content-type": "application/json" } : {}), ...init.headers }
  });
  if (response.status === 204) return undefined as T;
  const body: unknown = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = body && typeof body === "object" && "error" in body && typeof body.error === "string" ? body.error : `Request failed (${response.status})`;
    throw new EnterpriseApiError(message, response.status, body && typeof body === "object" && "details" in body ? body.details : undefined);
  }
  return body as T;
}

const workspacePath = (workspaceId: string) => `/v1/workspaces/${encodeURIComponent(workspaceId)}`;
const json = (method: string, body?: unknown): RequestInit => ({ method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });

export function listWorkspaces(apiUrl: string, token: string): Promise<EnterpriseWorkspace[]> { return enterpriseRequest(apiUrl, token, "/v1/workspaces"); }
export function createWorkspace(apiUrl: string, token: string, name: string): Promise<EnterpriseWorkspace> { return enterpriseRequest(apiUrl, token, "/v1/workspaces", json("POST", { name })); }

export function createResource(apiUrl: string, token: string, workspaceId: string, collection: "profiles" | "test-suites", name: string, definition: Record<string, unknown>): Promise<EnterpriseResource> { return enterpriseRequest(apiUrl, token, `${workspacePath(workspaceId)}/${collection}`, json("POST", { name, definition })); }
export function createTestReport(apiUrl: string, token: string, workspaceId: string, suiteId: string | null, summary: Record<string, unknown>, result: Record<string, unknown>): Promise<{ id: string; createdAt: string; evidenceVerification: "verified" }> { return enterpriseRequest(apiUrl, token, `${workspacePath(workspaceId)}/test-reports`, json("POST", { suiteId, summary, result })); }

export function listTestJobs(apiUrl: string, token: string, workspaceId: string): Promise<EnterpriseTestJob[]> { return enterpriseRequest(apiUrl, token, `${workspacePath(workspaceId)}/test-jobs`); }
export function createTestJob(apiUrl: string, token: string, workspaceId: string, definition: Record<string, unknown>, idempotencyKey: string, suiteId: string | null = null): Promise<EnterpriseTestJob> { return enterpriseRequest(apiUrl, token, `${workspacePath(workspaceId)}/test-jobs`, json("POST", { suiteId, definition, idempotencyKey })); }
export function cancelTestJob(apiUrl: string, token: string, workspaceId: string, jobId: string): Promise<EnterpriseTestJob> { return enterpriseRequest(apiUrl, token, `${workspacePath(workspaceId)}/test-jobs/${encodeURIComponent(jobId)}/cancel`, json("POST")); }

// The JUnit file needs the Authorization header, so it is fetched here and saved by the caller rather than linked to.
export async function fetchJobJunit(apiUrl: string, token: string, workspaceId: string, jobId: string): Promise<Blob> {
  const response = await fetch(`${apiUrl.replace(/\/$/, "")}${workspacePath(workspaceId)}/test-jobs/${encodeURIComponent(jobId)}/junit.xml`, { headers: { authorization: `Bearer ${token}` } });
  if (!response.ok) throw new EnterpriseApiError(`Request failed (${response.status})`, response.status);
  return response.blob();
}

export function listGateways(apiUrl: string, token: string, workspaceId: string): Promise<EnterpriseGateway[]> { return enterpriseRequest(apiUrl, token, `${workspacePath(workspaceId)}/gateways`); }
// The token in the response is shown once and never retrievable again.
export function registerGateway(apiUrl: string, token: string, workspaceId: string, name: string, labels: Record<string, string>, expiresInDays?: number): Promise<EnterpriseGateway & { token: string }> { return enterpriseRequest(apiUrl, token, `${workspacePath(workspaceId)}/gateways`, json("POST", { name, labels, ...(expiresInDays ? { expiresInDays } : {}) })); }
export function rotateGateway(apiUrl: string, token: string, workspaceId: string, gatewayId: string): Promise<EnterpriseGateway & { token: string }> { return enterpriseRequest(apiUrl, token, `${workspacePath(workspaceId)}/gateways/${encodeURIComponent(gatewayId)}/rotate`, json("POST")); }
export function setGatewayLabels(apiUrl: string, token: string, workspaceId: string, gatewayId: string, labels: Record<string, string>): Promise<EnterpriseGateway> { return enterpriseRequest(apiUrl, token, `${workspacePath(workspaceId)}/gateways/${encodeURIComponent(gatewayId)}`, json("PATCH", { labels })); }
export function revokeGateway(apiUrl: string, token: string, workspaceId: string, gatewayId: string): Promise<void> { return enterpriseRequest(apiUrl, token, `${workspacePath(workspaceId)}/gateways/${encodeURIComponent(gatewayId)}`, json("DELETE")); }

export function listMembers(apiUrl: string, token: string, workspaceId: string): Promise<EnterpriseMember[]> { return enterpriseRequest(apiUrl, token, `${workspacePath(workspaceId)}/members`); }
export function setMemberRole(apiUrl: string, token: string, workspaceId: string, subject: string, role: Role): Promise<EnterpriseMember> { return enterpriseRequest(apiUrl, token, `${workspacePath(workspaceId)}/members/${encodeURIComponent(subject)}`, json("PUT", { role })); }
export function removeMember(apiUrl: string, token: string, workspaceId: string, subject: string): Promise<void> { return enterpriseRequest(apiUrl, token, `${workspacePath(workspaceId)}/members/${encodeURIComponent(subject)}`, json("DELETE")); }
export function listInvitations(apiUrl: string, token: string, workspaceId: string): Promise<EnterpriseInvitation[]> { return enterpriseRequest(apiUrl, token, `${workspacePath(workspaceId)}/invitations`); }
export function inviteMember(apiUrl: string, token: string, workspaceId: string, email: string, role: Role): Promise<EnterpriseInvitation> { return enterpriseRequest(apiUrl, token, `${workspacePath(workspaceId)}/invitations`, json("POST", { email, role })); }
export function revokeInvitation(apiUrl: string, token: string, workspaceId: string, invitationId: string): Promise<void> { return enterpriseRequest(apiUrl, token, `${workspacePath(workspaceId)}/invitations/${encodeURIComponent(invitationId)}`, json("DELETE")); }

export function listApiKeys(apiUrl: string, token: string, workspaceId: string): Promise<EnterpriseApiKey[]> { return enterpriseRequest(apiUrl, token, `${workspacePath(workspaceId)}/api-keys`); }
export function createApiKey(apiUrl: string, token: string, workspaceId: string, name: string, role: EnterpriseApiKey["role"], expiresInDays?: number): Promise<EnterpriseApiKey & { token: string }> { return enterpriseRequest(apiUrl, token, `${workspacePath(workspaceId)}/api-keys`, json("POST", { name, role, ...(expiresInDays ? { expiresInDays } : {}) })); }
export function revokeApiKey(apiUrl: string, token: string, workspaceId: string, keyId: string): Promise<void> { return enterpriseRequest(apiUrl, token, `${workspacePath(workspaceId)}/api-keys/${encodeURIComponent(keyId)}`, json("DELETE")); }

export function getWorkspacePlan(apiUrl: string, token: string, workspaceId: string): Promise<EnterprisePlan> { return enterpriseRequest(apiUrl, token, `${workspacePath(workspaceId)}/usage`); }
// Offboarding: the server wants the exact workspace name as confirmation, and keeps the content for a grace period before purging it.
export function deleteWorkspace(apiUrl: string, token: string, workspaceId: string, confirm: string): Promise<{ id: string; deletedAt: string; purgeAfter: string }> { return enterpriseRequest(apiUrl, token, `${workspacePath(workspaceId)}?confirm=${encodeURIComponent(confirm)}`, json("DELETE")); }

const webhookPath = (workspaceId: string, webhookId: string) => `${workspacePath(workspaceId)}/webhooks/${encodeURIComponent(webhookId)}`;
export function listWebhooks(apiUrl: string, token: string, workspaceId: string): Promise<EnterpriseWebhook[]> { return enterpriseRequest(apiUrl, token, `${workspacePath(workspaceId)}/webhooks`); }
export function createWebhook(apiUrl: string, token: string, workspaceId: string, name: string, url: string, events: WebhookEvent[]): Promise<EnterpriseWebhook & { secret: string }> { return enterpriseRequest(apiUrl, token, `${workspacePath(workspaceId)}/webhooks`, json("POST", { name, url, events })); }
export function updateWebhook(apiUrl: string, token: string, workspaceId: string, webhookId: string, changes: { name?: string; url?: string; enabled?: boolean }): Promise<EnterpriseWebhook> { return enterpriseRequest(apiUrl, token, webhookPath(workspaceId, webhookId), json("PATCH", changes)); }
export function deleteWebhook(apiUrl: string, token: string, workspaceId: string, webhookId: string): Promise<void> { return enterpriseRequest(apiUrl, token, webhookPath(workspaceId, webhookId), json("DELETE")); }
export function rotateWebhookSecret(apiUrl: string, token: string, workspaceId: string, webhookId: string): Promise<{ secret: string; secretVersion: number }> { return enterpriseRequest(apiUrl, token, `${webhookPath(workspaceId, webhookId)}/rotate-secret`, json("POST")); }
export function pingWebhook(apiUrl: string, token: string, workspaceId: string, webhookId: string): Promise<{ deliveryId: string }> { return enterpriseRequest(apiUrl, token, `${webhookPath(workspaceId, webhookId)}/ping`, json("POST")); }
export function listWebhookDeliveries(apiUrl: string, token: string, workspaceId: string, webhookId: string): Promise<EnterpriseWebhookDelivery[]> { return enterpriseRequest(apiUrl, token, `${webhookPath(workspaceId, webhookId)}/deliveries?limit=25`); }
export function redeliverWebhook(apiUrl: string, token: string, workspaceId: string, webhookId: string, deliveryId: string): Promise<{ deliveryId: string }> { return enterpriseRequest(apiUrl, token, `${webhookPath(workspaceId, webhookId)}/deliveries/${encodeURIComponent(deliveryId)}/redeliver`, json("POST")); }

// Incremental Server-Sent Events parser: feed it decoded text in any chunking; it reports each complete event once.
export function createSseParser(onEvent: (event: string, data: string) => void): (chunk: string) => void {
  let buffer = "";
  return (chunk) => {
    buffer += chunk.replace(/\r\n?/g, "\n");
    for (let end = buffer.indexOf("\n\n"); end >= 0; end = buffer.indexOf("\n\n")) {
      const block = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      let event = "message";
      const data: string[] = [];
      for (const line of block.split("\n")) {
        if (!line || line.startsWith(":")) continue; // blank lines and comments (keep-alive pings)
        const colon = line.indexOf(":");
        const field = colon < 0 ? line : line.slice(0, colon);
        const value = colon < 0 ? "" : line.slice(colon + 1).replace(/^ /, "");
        if (field === "event") event = value;
        else if (field === "data") data.push(value);
      }
      if (data.length) onEvent(event, data.join("\n"));
    }
  };
}

export type StreamState = "connecting" | "live" | "reconnecting" | "denied";
export type JobStreamHandlers = { onJob(job: EnterpriseTestJob): void; onResync(): void; onState(state: StreamState): void };

const pause = (ms: number, signal: AbortSignal) => new Promise<void>((resolve) => {
  if (signal.aborted) return resolve();
  const timer = setTimeout(done, ms);
  function done() { clearTimeout(timer); signal.removeEventListener("abort", done); resolve(); }
  signal.addEventListener("abort", done, { once: true });
});

// Live job updates. EventSource cannot send an Authorization header, so the stream is read with fetch.
// `onResync` fires on every (re)connect and on a server `resync`: the caller refetches the list to close any gap.
// A 401/403 ends the stream for good (retrying would only feed the server's auth-failure limiter); everything else backs off.
// Returns a function that closes the stream; call it before opening another (the server allows few per user).
export function streamTestJobs(apiUrl: string, token: string, workspaceId: string, handlers: JobStreamHandlers): () => void {
  const controller = new AbortController();
  const { signal } = controller;
  void (async () => {
    let failures = 0;
    while (!signal.aborted) {
      let retryAfterMs = 0;
      try {
        handlers.onState(failures ? "reconnecting" : "connecting");
        const response = await fetch(`${apiUrl.replace(/\/$/, "")}${workspacePath(workspaceId)}/test-jobs/stream`, { headers: { authorization: `Bearer ${token}`, accept: "text/event-stream" }, cache: "no-store", signal });
        if (response.status === 401 || response.status === 403) { handlers.onState("denied"); return; }
        if (!response.ok || !response.body) { retryAfterMs = Math.min(60, Number(response.headers.get("retry-after")) || 0) * 1000; throw new Error(`stream refused (${response.status})`); }
        const parse = createSseParser((event, data) => {
          if (event === "ready") { failures = 0; handlers.onState("live"); handlers.onResync(); }
          else if (event === "resync") handlers.onResync();
          else if (event === "job") { try { handlers.onJob(JSON.parse(data) as EnterpriseTestJob); } catch { /* a malformed event is skipped; the next resync repairs the list */ } }
        });
        const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
        for (;;) { const { value, done } = await reader.read(); if (done) break; parse(value); }
      } catch { if (signal.aborted) return; }
      failures += 1;
      handlers.onState("reconnecting");
      await pause(Math.max(retryAfterMs, Math.min(30_000, 1000 * 2 ** Math.min(failures - 1, 5)) * (0.5 + Math.random() / 2)), signal);
    }
  })();
  return () => controller.abort();
}

// Invitations addressed to the signed-in person's verified email, across workspaces.
export type PendingInvitation = { id: string; role: Role; expiresAt: string; workspaceId: string; workspaceName: string };
export function listMyInvitations(apiUrl: string, token: string): Promise<PendingInvitation[]> { return enterpriseRequest(apiUrl, token, "/v1/invitations"); }
export function acceptInvitation(apiUrl: string, token: string, invitationId: string): Promise<{ workspaceId: string; role: Role }> { return enterpriseRequest(apiUrl, token, `/v1/invitations/${encodeURIComponent(invitationId)}/accept`, json("POST")); }
