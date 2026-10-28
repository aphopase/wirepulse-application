import { expect, test } from "@playwright/test";

test("connects, receives real-time bytes, creates private test evidence, transmits, and disconnects", async ({ page }) => {
  let uploadedReport: Record<string, unknown> | undefined;
  await page.route("http://enterprise.test/**", async (route) => {
    const url = new URL(route.request().url());
    if (route.request().headers()["authorization"] !== "Bearer test-token") return route.fulfill({ status: 401, contentType: "application/json", body: JSON.stringify({ error: "invalid_bearer_token" }) });
    if (url.pathname === "/v1/workspaces" && route.request().method() === "GET") return route.fulfill({ contentType: "application/json", body: JSON.stringify([{ id: "workspace-1", name: "Hardware Lab", role: "engineer", createdAt: "2026-10-23T00:00:00Z" }]) });
    if (url.pathname === "/v1/workspaces/workspace-1/test-reports" && route.request().method() === "POST") {
      uploadedReport = route.request().postDataJSON() as Record<string, unknown>;
      return route.fulfill({ status: 201, contentType: "application/json", body: JSON.stringify({ id: "report-1", createdAt: "2026-10-23T00:00:00Z", evidenceVerification: "verified" }) });
    }
    return route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ error: "not_found" }) });
  });
  await page.addInitScript(() => {
    const encoder = new TextEncoder();
    let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
    const readable = new ReadableStream<Uint8Array>({
      start(streamController) { controller = streamController; }
    });
    const port = {
      readable,
      writable: new WritableStream<Uint8Array>({ write(chunk) { const text = new TextDecoder().decode(chunk); (window as Window & { serialWrites: string[] }).serialWrites.push(text); if (text === "status\n") window.setTimeout(() => controller?.enqueue(encoder.encode("READY\n")), 15); } }),
      async open() {
        window.setTimeout(() => controller?.enqueue(encoder.encode("READY\nTEMP0: 12.4\nWARN: supply high\n")), 20);
      },
      async close() { controller?.close(); }
    };
    Object.defineProperty(window, "serialWrites", { configurable: true, value: [] });
    Object.defineProperty(navigator, "serial", { configurable: true, value: { requestPort: async () => port, getPorts: async () => [] } });
  });

  await page.goto("/");
  await page.getByPlaceholder("https://api.wirepulse.example.com").fill("http://enterprise.test");
  await page.getByPlaceholder("Paste short-lived token").fill("test-token");
  await page.getByRole("button", { name: "Connect workspace" }).click();
  await expect(page.getByText("Connected. 1 workspace(s) available.")).toBeVisible();
  await page.getByRole("button", { name: "Connect device" }).click();
  await expect(page.getByText("CONNECTED", { exact: true })).toBeVisible();
  await expect(page.getByText("READY", { exact: true })).toBeVisible();
  await expect(page.getByText("WARN: supply high")).toBeVisible();
  await expect(page.getByText("12.4", { exact: true })).toBeVisible();
  await expect(page.getByText("1", { exact: true }).first()).toBeVisible();

  await page.getByPlaceholder("Type a command and press Enter…").fill("status");
  await page.getByRole("button", { name: "Send ↵" }).click();
  await expect.poll(() => page.evaluate(() => (window as Window & { serialWrites: string[] }).serialWrites)).toEqual(["status\n"]);
  await expect(page.locator(".terminal").getByText("status", { exact: true })).toBeVisible();

  await page.getByRole("button", { name: "Run all" }).click();
  await expect(page.getByText("PASS", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Upload report" }).click();
  await expect(page.getByText("Uploaded aggregate report with verified evidence. Raw serial logs and bytes were not uploaded.")).toBeVisible();
  expect(uploadedReport).toBeDefined();
  expect(JSON.stringify(uploadedReport)).not.toContain("READY");
  expect(JSON.stringify(uploadedReport)).not.toContain("status\\n");
  const evidence = (uploadedReport?.result as { evidence?: { events?: Array<{ type: string }> } }).evidence;
  expect(evidence?.events?.map((event) => event.type)).toEqual(expect.arrayContaining(["run.started", "command.transmitted", "response.window.opened", "assertion.completed", "run.finished"]));

  await page.getByRole("button", { name: "Disconnect" }).click();
  await expect(page.getByText("OFFLINE", { exact: true })).toBeVisible();
});
