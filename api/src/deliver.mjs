import { postJson, secretFor, sign } from "./webhook-send.mjs";

// What the outbox worker calls for each claimed row. Returns { ok, status?, error?, permanent? }; `permanent` stops retries.
export function createDeliverer({ db, config, mailer, guard }) {
  return async function deliver(row) {
    if (row.kind === "email") {
      if (!mailer) return { ok: false, error: "smtp_not_configured", permanent: true };
      return mailer.send(row.payload);
    }
    if (!config.webhooks) return { ok: false, error: "webhooks_not_configured", permanent: true };
    // The destination and secret are read at send time, so editing or rotating a webhook takes effect for messages still waiting.
    const hook = (await db.query("SELECT url, secret_version, enabled FROM webhooks WHERE id = $1", [row.webhook_id])).rows[0];
    if (!hook) return { ok: false, error: "webhook_deleted", permanent: true };
    if (!hook.enabled) return { ok: false, error: "webhook_disabled", permanent: true };
    // The envelope is rebuilt from the stored row, so every retry carries a byte-identical body and the same delivery id.
    const body = JSON.stringify({ id: row.id, type: row.event_type, createdAt: row.created_at, workspaceId: row.workspace_id, data: row.payload });
    const timestamp = Math.floor(Date.now() / 1000);
    const secret = secretFor(config.webhooks.signingKey, row.webhook_id, hook.secret_version);
    const result = await postJson({
      url: hook.url, body, guard, timeoutMs: config.webhooks.timeoutMs,
      headers: {
        "content-type": "application/json", "user-agent": "WirePulse-Webhooks/1", "x-wirepulse-event": row.event_type, "x-wirepulse-delivery": row.id,
        "x-wirepulse-signature": sign(secret, timestamp, body)
      }
    });
    return { ...result, permanent: result.error === "destination_blocked" || result.error === "invalid_url" };
  };
}
