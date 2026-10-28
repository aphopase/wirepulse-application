import { expect, test } from "@playwright/test";

async function mockSerial(page: import("@playwright/test").Page): Promise<void> {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "serial", { configurable: true, value: { requestPort: async () => ({}), getPorts: async () => [] } });
  });
}

test("renders the local-first workspace when Web Serial is available", async ({ page }) => {
  await mockSerial(page);
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "WirePulse" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Connect device" })).toBeVisible();
  await expect(page.getByText("Serial connection unavailable")).not.toBeVisible();
});

test("persists macros, telemetry configuration, and device profiles locally", async ({ page }) => {
  await mockSerial(page);
  await page.goto("/");
  await page.getByRole("button", { name: "Edit" }).click();
  const macroLabel = page.getByLabel("Macro 1 label");
  await macroLabel.fill("Read status");
  await page.reload();
  await expect(page.getByRole("button", { name: "Read status" })).toBeVisible();

  await page.getByRole("button", { name: "Configure" }).click();
  await page.getByLabel("Channel 1 name").fill("Battery voltage");
  await page.getByLabel("Channel 1 token").fill("VOLTAGE");
  await page.reload();
  await page.getByRole("button", { name: "Configure" }).click();
  await expect(page.getByLabel("Channel 1 name")).toHaveValue("Battery voltage");
  await expect(page.getByLabel("Channel 1 token")).toHaveValue("VOLTAGE");

  const profile = page.getByPlaceholder("Profile name");
  await profile.fill("E2E ESP32");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByRole("button", { name: "E2E ESP32", exact: true })).toBeVisible();
});

test("handles control-plane discovery and workspace creation with authenticated API behavior", async ({ page }) => {
  await mockSerial(page);
  let nextId = 0;
  await page.route("http://enterprise.test/**", async (route) => {
    const url = new URL(route.request().url());
    if (route.request().headers()["authorization"] !== "Bearer test-token") return route.fulfill({ status: 401, contentType: "application/json", body: JSON.stringify({ error: "invalid_bearer_token" }) });
    if (url.pathname === "/v1/workspaces" && route.request().method() === "GET") return route.fulfill({ contentType: "application/json", body: JSON.stringify([{ id: "workspace-1", name: "Hardware Lab", role: "administrator", createdAt: "2026-10-23T00:00:00Z" }]) });
    if (url.pathname === "/v1/workspaces" && route.request().method() === "POST") { nextId += 1; const body = route.request().postDataJSON(); return route.fulfill({ status: 201, contentType: "application/json", body: JSON.stringify({ id: `workspace-${nextId + 1}`, name: body.name, role: "administrator", createdAt: "2026-10-23T00:00:00Z" }) }); }
    if (/\/v1\/workspaces\/workspace-1\/test-reports$/.test(url.pathname) && route.request().method() === "POST") return route.fulfill({ status: 201, contentType: "application/json", body: JSON.stringify({ id: "report-1", createdAt: "2026-10-23T00:00:00Z", evidenceVerification: "verified" }) });
    return route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ error: "not_found" }) });
  });
  await page.goto("/");
  await page.getByPlaceholder("https://api.wirepulse.example.com").fill("http://enterprise.test");
  await page.getByPlaceholder("Paste short-lived token").fill("test-token");
  await page.getByRole("button", { name: "Connect workspace" }).click();
  await expect(page.getByText("Connected. 1 workspace(s) available.")).toBeVisible();
  await page.getByPlaceholder("New workspace name").fill("Browser E2E");
  await page.getByRole("button", { name: "Create", exact: true }).click();
  await expect(page.getByText("Created workspace Browser E2E.")).toBeVisible();
});

test("reports unavailable serial APIs without claiming a device was tested", async ({ page }) => {
  await page.addInitScript(() => { Object.defineProperty(navigator, "serial", { configurable: true, value: undefined }); });
  await page.goto("/");
  await expect(page.getByRole("button", { name: "Connect device" })).toBeVisible();
  await expect(page.getByText("Serial connection unavailable")).toBeVisible();
  await expect(page.getByRole("alert").getByText(/Web Serial is not exposed|not secure/)).toBeVisible();
});
