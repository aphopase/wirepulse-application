import crypto from "node:crypto";
import http from "node:http";
import https from "node:https";
import { BlockedDestination, resolveSafe } from "./netguard.mjs";

// Webhook signing key material is derived, never stored: rotating a webhook's secret bumps its version, and rotating the operator's
// WEBHOOK_SIGNING_KEY changes every secret at once.
export const secretFor = (signingKey, webhookId, version) =>
  `whsec_${crypto.createHmac("sha256", signingKey).update(`wirepulse-webhook:${webhookId}:${version}`).digest("base64url")}`;

// The header value is `t=<unix seconds>,v1=<hex HMAC-SHA256 of "<t>.<raw body>">`. Receivers recompute it and compare in constant time.
export function sign(secret, timestamp, body) {
  return `t=${timestamp},v1=${crypto.createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex")}`;
}

// Reference verifier for receivers (also used by the tests): rejects a bad signature or a timestamp outside the tolerance window.
export function verifySignature(secret, header, body, { toleranceSeconds = 300, now = Date.now() } = {}) {
  const parts = Object.fromEntries(String(header ?? "").split(",").map((part) => part.trim().split("=")).filter((pair) => pair.length === 2));
  const timestamp = Number(parts.t);
  if (!Number.isInteger(timestamp) || !parts.v1) return false;
  if (Math.abs(now / 1000 - timestamp) > toleranceSeconds) return false;
  const expected = Buffer.from(sign(secret, timestamp, body).split("v1=")[1], "hex");
  const given = Buffer.from(parts.v1, "hex");
  return given.length === expected.length && crypto.timingSafeEqual(given, expected);
}

// Connect to exactly the address that was vetted, whatever the name resolves to by the time the socket opens (no DNS rebinding window).
const pinned = (answer) => (_hostname, options, callback) => {
  if (typeof options === "function") { callback = options; options = {}; }
  if (options?.all) callback(null, [{ address: answer.address, family: answer.family }]);
  else callback(null, answer.address, answer.family);
};

// Coarse on purpose: the stored reason is shown to tenants, and a detailed one ("connection refused" vs "timed out") would let them
// map the network behind an allow-listed range.
function classifyError(error) {
  if (error instanceof BlockedDestination) return "destination_blocked";
  const code = String(error?.code ?? "");
  if (error?.message === "timeout") return "timeout";
  if (code === "ENOTFOUND" || code === "EAI_AGAIN" || code === "EAI_NODATA") return "dns_failed";
  if (/CERT|TLS|SSL|SELF_SIGNED|UNABLE_TO_(VERIFY|GET)|HOSTNAME_MISMATCH/i.test(code)) return "tls_error";
  if (["ECONNREFUSED", "ECONNRESET", "EHOSTUNREACH", "ENETUNREACH", "EPIPE", "ETIMEDOUT"].includes(code)) return "connection_failed";
  return "request_failed";
}

// POSTs `body` to `url`. Never throws; resolves { ok, status, error }. The response body is never read or kept: a tenant must not be able
// to use this server as a window onto whatever the URL points at.
//  - the destination is resolved once and vetted by `guard`; plain http is only used for explicitly allow-listed addresses
//  - TLS certificates are always verified (explicitly, so NODE_TLS_REJECT_UNAUTHORIZED=0 in the environment cannot switch it off)
//  - redirects are not followed
//  - the whole attempt (resolution, connect, TLS, request, response headers) has one deadline
export async function postJson({ url, body, headers, guard, timeoutMs, lookup }) {
  let target;
  try { target = new URL(url); } catch { return { ok: false, status: null, error: "invalid_url" }; }
  if (!["http:", "https:"].includes(target.protocol) || target.username || target.password) return { ok: false, status: null, error: "invalid_url" };
  const deadline = Date.now() + timeoutMs;
  let answer;
  try {
    answer = await Promise.race([
      resolveSafe(target.hostname, guard, lookup ? { lookup } : {}),
      new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), timeoutMs).unref())
    ]);
    if (target.protocol === "http:" && !guard.isAllowListed(answer.address)) throw new BlockedDestination("insecure_scheme");
  } catch (error) { return { ok: false, status: null, error: classifyError(error) }; }

  const secure = target.protocol === "https:";
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result) => { if (!settled) { settled = true; clearTimeout(timer); resolve(result); } };
    const payload = Buffer.from(body);
    const request = (secure ? https : http).request({
      host: target.hostname.startsWith("[") ? target.hostname.slice(1, -1) : target.hostname, port: target.port || undefined, path: `${target.pathname}${target.search}`, method: "POST",
      headers: { ...headers, "content-length": payload.length }, lookup: pinned(answer), agent: false,
      ...(secure ? { rejectUnauthorized: true, minVersion: "TLSv1.2" } : {})
    }, (response) => {
      const status = response.statusCode;
      response.destroy();
      if (status >= 200 && status < 300) finish({ ok: true, status, error: null });
      else finish({ ok: false, status, error: status >= 300 && status < 400 ? "redirect_not_followed" : `http_${status}` });
    });
    const timer = setTimeout(() => { request.destroy(new Error("timeout")); finish({ ok: false, status: null, error: "timeout" }); }, Math.max(1, deadline - Date.now()));
    request.on("error", (error) => finish({ ok: false, status: null, error: classifyError(error) }));
    request.end(payload);
  });
}
