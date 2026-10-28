// The browser console against the real control plane: real API, real PostgreSQL, real gateway agent (simulated serial device).
// Needs WP_TEST_DATABASE_URL, like the API tests; skipped without it. Run with the dev server on :5173 (npm run dev).
import { expect, test, type Page } from "@playwright/test";
// Plain ESM helpers shared with the API test-suite (no type declarations).
// @ts-ignore
import { DEV_TOKEN, createClient, createTestDatabase, sampleDefinition, skip, startApi, startReceiver, ws } from "../api/test/helpers.mjs";
// @ts-ignore
import { verifySignature } from "../api/src/webhook-send.mjs";
// @ts-ignore
import { createAgent, createAgentLog } from "../gateway/src/agent.mjs";
// @ts-ignore
import { createSimulatedTransport } from "../gateway/src/transports.mjs";

const ORIGIN = "http://127.0.0.1:5173";
test.skip(!!skip, String(skip));
test.describe.configure({ mode: "serial" });

let database: any; let api: any; let admin: any;
const agents: Array<{ agent: any; done: Promise<unknown> }> = [];

test.beforeAll(async () => {
  database = await createTestDatabase();
  // Webhooks are on, may reach loopback (the receiver below), and give up after one attempt so a failed delivery is visible at once.
  api = await startApi({ databaseUrl: database.url, env: { CORS_ORIGINS: ORIGIN, WEBHOOK_SIGNING_KEY: "live-console-webhook-signing-key-0123456789", WEBHOOK_ALLOWED_CIDRS: "127.0.0.0/8", OUTBOX_INTERVAL_MS: "200", OUTBOX_MAX_ATTEMPTS: "1" } });
  admin = createClient(api.url, DEV_TOKEN);
});
test.afterAll(async () => {
  for (const { agent, done } of agents.splice(0)) { agent.stop(); await done; }
  await api?.stop();
  await database?.drop();
});

function startAgent(token: string) {
  const agent = createAgent({
    config: { apiUrl: api.url, token, serialPath: "/dev/ttyTEST", pollMs: 50, leaseRenewMs: 500, heartbeatMs: 300, requestTimeoutMs: 3000, maxBackoffMs: 200, shutdownGraceMs: 300 },
    log: createAgentLog({ write: () => undefined, secrets: [token] }),
    openTransport: async () => createSimulatedTransport({ responder: () => ["READY"] })
  });
  const handle = { agent, done: agent.run().then(() => null, (error: unknown) => error) };
  agents.push(handle);
  return handle;
}

// Connects the page to the API and creates (and selects) a workspace of the given name.
async function openWorkspace(page: Page, name: string) {
  page.on("dialog", (dialog) => void dialog.accept());
  await page.goto("/");
  await page.getByPlaceholder("https://api.wirepulse.example.com").fill(api.url);
  await page.getByPlaceholder("Paste short-lived token").fill(DEV_TOKEN);
  await page.getByRole("button", { name: "Connect workspace" }).click();
  await expect(page.getByText(/^Connected\./)).toBeVisible();
  await page.getByPlaceholder("New workspace name").fill(name);
  await page.getByRole("button", { name: "Create", exact: true }).click();
  await expect(page.getByRole("heading", { name: `Enterprise console · ${name}` })).toBeVisible();
  const workspace = (await admin("/v1/workspaces")).body.find((item: { name: string }) => item.name === name);
  return workspace.id as string;
}
const console_ = (page: Page) => page.getByRole("region", { name: "Enterprise console" });
const tab = (page: Page, name: string) => console_(page).getByRole("tab", { name });
const secretOf = async (page: Page) => (await page.getByTestId("one-time-secret").textContent()) ?? "";

test("a registered gateway runs a queued job and the console follows it live, down to the verified evidence", async ({ page }) => {
  await openWorkspace(page, "Live Lab");

  await tab(page, "Gateways").click();
  await console_(page).getByLabel("Name").fill("Bench 1");
  await console_(page).getByLabel("Labels (key=value, …)").fill("bench=1, board=esp32");
  await console_(page).getByRole("button", { name: "Register gateway" }).click();
  const token = await secretOf(page);
  expect(token).toMatch(/^wpg_[A-Za-z0-9_-]{40,}$/);
  await console_(page).getByRole("button", { name: "I have saved it — hide" }).click();
  await expect(page.getByTestId("one-time-secret")).toHaveCount(0);
  await expect(console_(page).getByText("Labels: bench=1, board=esp32")).toBeVisible();
  await expect(console_(page).getByText("offline", { exact: true })).toBeVisible();

  startAgent(token);
  await expect(async () => {
    await console_(page).getByRole("button", { name: "Refresh" }).click();
    await expect(console_(page).getByText("online", { exact: true })).toBeVisible({ timeout: 500 });
  }).toPass({ timeout: 10_000 });
  await expect(console_(page).getByText("Serial ports: /dev/ttyTEST")).toBeVisible();

  await tab(page, "Jobs").click();
  await expect(console_(page).getByText("Live", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Queue gateway job" }).click();
  const row = console_(page).locator(".ec-job").first();
  await expect(row.locator(".ec-badge")).toHaveText("passed", { timeout: 15_000 });
  await expect(row).toContainText("1 passed · 0 failed · 1 total");
  await expect(row).toContainText("on Bench 1");

  await row.getByRole("button", { name: "Details" }).click();
  await expect(row.locator("dd", { hasText: /^[a-f0-9]{64}$/ }).first()).toBeVisible();
  await expect(row).toContainText("Engine fingerprint");

  const [download] = await Promise.all([page.waitForEvent("download"), row.getByRole("button", { name: "JUnit XML" }).click()]);
  const xml = await (await import("node:fs/promises")).readFile((await download.path())!, "utf8");
  expect(download.suggestedFilename()).toMatch(/^wirepulse-[0-9a-f]{8}\.xml$/);
  expect(xml).toContain("<testsuite");
  expect(xml).not.toContain("READY"); // evidence and reports never carry the device's bytes
});

test("rotating a gateway token stops the old agent and shows the new token once; revoking is final", async ({ page }) => {
  const workspaceId = await openWorkspace(page, "Rotation Lab");
  await tab(page, "Gateways").click();
  await console_(page).getByLabel("Name").fill("Bench 2");
  await console_(page).getByRole("button", { name: "Register gateway" }).click();
  const first = await secretOf(page);
  const old = startAgent(first);
  await console_(page).getByRole("button", { name: "I have saved it — hide" }).click();

  await console_(page).getByRole("button", { name: "Rotate token" }).click();
  const second = await secretOf(page);
  expect(second).toMatch(/^wpg_/); expect(second).not.toBe(first);
  const error = await Promise.race([old.done, new Promise((resolve) => setTimeout(() => resolve("still running"), 8000))]);
  expect(String((error as Error)?.message ?? error)).toMatch(/rejected the gateway token/);
  expect(await page.content()).not.toContain(first);

  await console_(page).getByRole("button", { name: "I have saved it — hide" }).click();
  await console_(page).getByRole("button", { name: "Revoke", exact: true }).click();
  await expect(console_(page).getByText("revoked", { exact: true })).toBeVisible();
  await expect(console_(page).getByRole("button", { name: "Rotate token" })).toHaveCount(0);
  expect((await admin(`${ws(workspaceId)}/gateways`)).body[0].revokedAt).not.toBeNull();
});

test("team and API keys: invite (email only when configured), create a CI key that works, revoke it and it stops", async ({ page }) => {
  const workspaceId = await openWorkspace(page, "Team Lab");

  await tab(page, "Team").click();
  await expect(console_(page).getByText("admin@wirepulse.local")).toBeVisible();
  await console_(page).getByLabel("Email").fill("colleague@example.com");
  await console_(page).locator("label").filter({ hasText: "Role" }).locator("select").selectOption("viewer");
  await console_(page).getByRole("button", { name: "Invite" }).click();
  await expect(console_(page).getByRole("status")).toContainText("emailed only if this server has email configured");
  await expect(console_(page).getByText("colleague@example.com", { exact: true })).toBeVisible();
  await console_(page).getByRole("button", { name: "Revoke" }).click();
  await expect(console_(page).getByText(/^revoked$/)).toBeVisible();

  await tab(page, "API keys").click();
  await console_(page).getByLabel("Name").fill("nightly-ci");
  await console_(page).getByRole("button", { name: "Create key" }).click();
  const key = await secretOf(page);
  expect(key).toMatch(/^wpk_/);
  expect((await createClient(api.url, key)(`${ws(workspaceId)}/test-jobs`)).status).toBe(200);
  await console_(page).getByRole("button", { name: "I have saved it — hide" }).click();
  await console_(page).getByRole("button", { name: "Revoke" }).click();
  await expect(console_(page).getByText(/revoked · last used/)).toBeVisible();
  expect((await createClient(api.url, key)(`${ws(workspaceId)}/test-jobs`)).status).toBe(401);
});

test("when the live stream is unavailable the console says so and keeps the list fresh by polling", async ({ page }) => {
  test.setTimeout(60_000);
  await page.route(/\/test-jobs\/stream/, (route) => route.abort());
  const workspaceId = await openWorkspace(page, "Polling Lab");
  await expect(console_(page).getByText(/Reconnecting — refreshing every 10 s/)).toBeVisible();

  const queued = await admin(`${ws(workspaceId)}/test-jobs`, { method: "POST", body: { definition: sampleDefinition(), idempotencyKey: "polled" } });
  expect(queued.status).toBe(201);
  await expect(console_(page).locator(".ec-job").first()).toContainText(queued.body.id.slice(0, 8), { timeout: 20_000 });
  await expect(console_(page).locator(".ec-job .ec-badge").first()).toHaveText("queued");
});

test("the usage tab shows the plan and its consumption, and a limit that is reached is explained in plain words", async ({ page }) => {
  const workspaceId = await openWorkspace(page, "Usage Lab");
  await tab(page, "Usage").click();
  await expect(console_(page).getByTestId("plan-name")).toHaveText("enterprise");
  await expect(console_(page).locator(".ec-job", { hasText: "Gateways" })).toContainText("unlimited");

  await api.db.query("UPDATE workspaces SET plan = 'free' WHERE id = $1", [workspaceId]);
  await console_(page).getByRole("button", { name: "Refresh" }).click();
  await expect(console_(page).getByTestId("plan-name")).toHaveText("free");
  await expect(console_(page).locator(".ec-job", { hasText: "Members" })).toContainText("1 of 3");
  await expect(console_(page).locator(".ec-job", { hasText: "Gateways" })).toContainText("0 of 1");
  await expect(console_(page).locator(".ec-job", { hasText: "Requests per minute" })).toContainText("up to 120");

  await tab(page, "Gateways").click();
  await console_(page).getByLabel("Name").fill("First");
  await console_(page).getByRole("button", { name: "Register gateway" }).click();
  await console_(page).getByRole("button", { name: "I have saved it — hide" }).click();
  await console_(page).getByLabel("Name").fill("Second");
  await console_(page).getByRole("button", { name: "Register gateway" }).click();
  await expect(console_(page).getByRole("status")).toContainText("the free plan limit for gateways (1) is reached");
  expect((await admin(`${ws(workspaceId)}/gateways`)).body).toHaveLength(1);

  await tab(page, "Usage").click();
  await expect(console_(page).locator(".ec-job", { hasText: "Gateways" })).toContainText("1 of 1");
});

test("webhooks: create one, receive a signed delivery for a finished job, rotate the secret, and redeliver a failed delivery", async ({ page }) => {
  test.setTimeout(60_000);
  const receiver = await startReceiver();
  try {
    const workspaceId = await openWorkspace(page, "Hook Lab");
    await tab(page, "Webhooks").click();

    // A destination the server would not be allowed to call is refused when the webhook is configured.
    await console_(page).getByLabel("Name").fill("Internal");
    await console_(page).getByLabel("URL").fill("http://10.1.2.3/hook");
    await console_(page).getByRole("button", { name: "Add webhook" }).click();
    await expect(console_(page).getByRole("status")).toContainText("webhook_destination_not_allowed");
    await expect(console_(page).getByText("No webhooks.")).toBeVisible();

    await console_(page).getByLabel("Name").fill("CI status");
    await console_(page).getByLabel("URL").fill(`${receiver.url}/hooks/ci`);
    await console_(page).getByRole("button", { name: "Add webhook" }).click();
    const first = await secretOf(page);
    expect(first).toMatch(/^whsec_[A-Za-z0-9_-]{40,}$/);
    await console_(page).getByRole("button", { name: "I have saved it — hide" }).click();
    const hook = console_(page).locator(".ec-job", { hasText: "CI status" });
    await expect(hook).toContainText("enabled");
    await expect(hook).toContainText("secret v1");

    // A real job, run by a real agent, ends in a signed delivery that verifies with the secret that was shown.
    const gateway = (await admin(`${ws(workspaceId)}/gateways`, { method: "POST", body: { name: "Bench", labels: {} } })).body;
    startAgent(gateway.token);
    await page.getByRole("button", { name: "Queue gateway job" }).click();
    await expect.poll(() => receiver.requests.length, { timeout: 20_000 }).toBeGreaterThan(0);
    const delivered = receiver.requests[0];
    expect(delivered.url).toBe("/hooks/ci");
    expect(delivered.headers["x-wirepulse-event"]).toBe("job.finished");
    expect(verifySignature(first, delivered.headers["x-wirepulse-signature"], delivered.body)).toBe(true);
    expect(delivered.body).not.toContain("READY"); // the notification names the job, never the device's bytes

    // Delivery status changes after the request is made, so the list has a Refresh button.
    const deliveryBadges = (status: string, count: number) => async () => {
      await hook.getByRole("button", { name: "Refresh deliveries" }).click();
      await expect(hook.locator(".ec-badge", { hasText: status })).toHaveCount(count, { timeout: 500 });
    };
    await hook.getByRole("button", { name: "Deliveries" }).click();
    await expect(deliveryBadges("delivered", 1)).toPass({ timeout: 10_000 });

    // Rotating moves signing to a new secret at once; the old one no longer verifies.
    await hook.getByRole("button", { name: "Rotate secret" }).click();
    const second = await secretOf(page);
    expect(second).toMatch(/^whsec_/); expect(second).not.toBe(first);
    await console_(page).getByRole("button", { name: "I have saved it — hide" }).click();
    await expect(hook).toContainText("secret v2");
    await hook.getByRole("button", { name: "Send test" }).click();
    await expect.poll(() => receiver.requests.length, { timeout: 20_000 }).toBe(2);
    const ping = receiver.requests[1];
    expect(ping.headers["x-wirepulse-event"]).toBe("webhook.ping");
    expect(verifySignature(second, ping.headers["x-wirepulse-signature"], ping.body)).toBe(true);
    expect(verifySignature(first, ping.headers["x-wirepulse-signature"], ping.body)).toBe(false);

    // A receiver that is down turns the delivery into a failed one, which can be sent again once it is back.
    receiver.setHandler((_req: unknown, res: { statusCode: number; end(): void }) => { res.statusCode = 500; res.end(); });
    await hook.getByRole("button", { name: "Send test" }).click();
    await expect(deliveryBadges("failed", 1)).toPass({ timeout: 10_000 });
    await expect(hook).toContainText("HTTP 500");
    receiver.setHandler((_req: unknown, res: { statusCode: number; end(): void }) => { res.statusCode = 200; res.end("ok"); });
    await hook.getByRole("button", { name: "Redeliver" }).click();
    await expect.poll(async () => (await admin(`${ws(workspaceId)}/webhooks/${(await admin(`${ws(workspaceId)}/webhooks`)).body[0].id}/deliveries`)).body.filter((item: { status: string }) => item.status === "delivered").length, { timeout: 20_000 }).toBe(3);

    await hook.getByRole("button", { name: "Delete", exact: true }).click();
    await expect(console_(page).getByText("No webhooks.")).toBeVisible();
  } finally { await receiver.close(); }
});

test("deleting a workspace needs its exact name, and it is gone at once", async ({ page }) => {
  const workspaceId = await openWorkspace(page, "Doomed Lab");
  await tab(page, "Usage").click();
  const confirm = console_(page).getByLabel("Type the workspace name to confirm");
  const button = console_(page).getByRole("button", { name: "Delete workspace" });
  await expect(button).toBeDisabled();
  await confirm.fill("Doomed");
  await expect(button).toBeDisabled();
  await confirm.fill("Doomed Lab");
  await expect(button).toBeEnabled();
  await button.click();
  await expect(page.getByRole("heading", { name: "Enterprise console · Doomed Lab" })).toHaveCount(0);
  await expect(page.getByText(/^Workspace deleted\./)).toBeVisible();
  expect((await admin(`${ws(workspaceId)}/usage`)).status).toBe(403); // a deleted workspace answers like one the caller never belonged to
  expect((await admin("/v1/workspaces")).body.some((item: { id: string }) => item.id === workspaceId)).toBe(false);
});

test("a viewer sees usage but none of the administrator controls", async ({ page }) => {
  const workspaceId = await openWorkspace(page, "Viewer Lab");
  const key = (await admin(`${ws(workspaceId)}/api-keys`, { method: "POST", body: { name: "read-only", role: "viewer", expiresInDays: 1 } })).body.token;
  await page.goto("/");
  await page.getByPlaceholder("https://api.wirepulse.example.com").fill(api.url);
  await page.getByPlaceholder("Paste short-lived token").fill(key);
  await page.getByRole("button", { name: "Connect workspace" }).click();
  await expect(page.getByRole("heading", { name: "Enterprise console · Viewer Lab" })).toBeVisible();
  await expect(console_(page).getByRole("tab")).toHaveText(["Jobs", "Gateways", "Usage"]);
  await tab(page, "Usage").click();
  await expect(console_(page).getByTestId("plan-name")).toHaveText("enterprise");
  await expect(console_(page).getByRole("button", { name: "Delete workspace" })).toHaveCount(0);
});

test("when the server has webhooks switched off the Webhooks tab says so instead of failing", async ({ page }) => {
  await page.route(/\/webhooks$/, (route) => route.fulfill({ status: 501, contentType: "application/json", body: JSON.stringify({ error: "webhooks_not_configured" }) }));
  await openWorkspace(page, "No Hooks Lab");
  await tab(page, "Webhooks").click();
  await expect(console_(page).getByText(/Webhooks are not enabled on this server/)).toBeVisible();
  await expect(console_(page).getByRole("button", { name: "Add webhook" })).toHaveCount(0);
  await expect(console_(page).getByRole("status")).toHaveText("");
});
