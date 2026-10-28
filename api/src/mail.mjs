import nodemailer from "nodemailer";

const clean = (text) => String(text).replace(/[\u0000-\u001f\u007f\u0085\u2028\u2029]+/g, " ").replace(/\s+/g, " ").trim();

// Plain text only, a fixed template, no secrets and no links except the operator's own INVITE_BASE_URL. The workspace name is chosen by
// whoever created the workspace, so it is flattened to one line and quoted; it is the only tenant-controlled text in the message.
export function invitationMessage({ to, workspaceName, role, expiresAt, baseUrl }) {
  const name = clean(workspaceName).slice(0, 120);
  return {
    to,
    subject: `You have been invited to ${name} on WirePulse`,
    text: [
      `You have been invited to join the WirePulse workspace "${name}" as ${role}.`,
      "",
      baseUrl ? `Sign in with this email address to accept the invitation:\n${baseUrl}` : "Sign in to WirePulse with this email address to accept the invitation.",
      "",
      `The invitation expires on ${new Date(expiresAt).toISOString().slice(0, 10)}.`,
      "If you were not expecting it, you can ignore this message.",
      ""
    ].join("\n")
  };
}

function classify(error) {
  const code = String(error?.code ?? ""); const response = Number(error?.responseCode ?? 0);
  // A failed STARTTLS or login also carries the server's numeric reply (500, 535), so the error code is looked at first.
  if (code === "ETLS") return { error: "smtp_tls_error" };
  if (code === "EAUTH") return { error: "smtp_auth_failed" };
  // 55x: the server refused this recipient or message for good; retrying cannot change that.
  if (response >= 550 && response <= 559) return { error: "smtp_rejected", permanent: true };
  if (response >= 400) return { error: "smtp_temporary_failure" };
  if (/CERT|TLS|SSL|SELF_SIGNED|STARTTLS/i.test(`${code} ${error?.message}`)) return { error: "smtp_tls_error" };
  return { error: "smtp_connection_failed" };
}

// smtps:// uses TLS from the first byte; smtp:// must upgrade with STARTTLS or the message is not sent (no silent downgrade to clear
// text). `?tls=none` (refused in production) is for a trusted local relay and for tests. Certificates are verified explicitly, so
// NODE_TLS_REJECT_UNAUTHORIZED=0 in the environment cannot weaken it.
export function createMailer(smtp) {
  const url = new URL(smtp.url);
  const secure = url.protocol === "smtps:";
  const plain = url.searchParams.get("tls") === "none";
  const transport = nodemailer.createTransport({
    host: url.hostname, port: Number(url.port) || (secure ? 465 : 587), secure,
    auth: url.username ? { user: decodeURIComponent(url.username), pass: decodeURIComponent(url.password) } : undefined,
    requireTLS: !secure && !plain, ignoreTLS: plain,
    tls: { rejectUnauthorized: true, minVersion: "TLSv1.2" },
    connectionTimeout: 10_000, greetingTimeout: 10_000, socketTimeout: 20_000, dnsTimeout: 10_000,
    disableFileAccess: true, disableUrlAccess: true
  });
  return {
    async send({ to, subject, text }) {
      try {
        await transport.sendMail({ from: smtp.from, to, subject: clean(subject).slice(0, 200), text, headers: { "Auto-Submitted": "auto-generated" } });
        return { ok: true };
      } catch (error) { return { ok: false, ...classify(error) }; }
    },
    close: () => transport.close()
  };
}
