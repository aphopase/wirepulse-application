// Invitation email over the real API, PostgreSQL, the outbox worker and a real SMTP server (smtp-server): what is sent, what cannot be injected,
// that nothing ever travels in clear text unless the operator opts in, and that a failing mail server never fails an invitation.
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import tls from "node:tls";
import pg from "pg";
import { SMTPServer } from "smtp-server";
import { DEV_TOKEN, createClient, createTestDatabase, skip, sleep, startApi, waitFor, ws } from "./helpers.mjs";

const FROM = "WirePulse <no-reply@wirepulse.example>";
const BASE = { OUTBOX_INTERVAL_MS: "100", SMTP_FROM: FROM, INVITE_BASE_URL: "https://console.example.test/" };

// A real SMTP server that keeps what it was given. `secure` is TLS from the first byte (smtps); `starttls: false` hides the capability.
async function smtpServer({ secure = false, starttls = true, credentials, certificate, port = 0 } = {}) {
  const messages = []; const rejects = { rcpt: null };
  const server = new SMTPServer({
    logger: false, secure, authOptional: !credentials, allowInsecureAuth: true, disabledCommands: starttls ? [] : ["STARTTLS"],
    ...(certificate ? { key: certificate.key, cert: certificate.cert } : {}),
    onAuth(auth, _session, done) { return credentials && auth.username === credentials.user && auth.password === credentials.pass ? done(null, { user: auth.username }) : done(new Error("Invalid login")); },
    onRcptTo(_address, _session, done) { return rejects.rcpt ? done(Object.assign(new Error(rejects.rcpt.message), { responseCode: rejects.rcpt.code })) : done(); },
    onData(stream, session, done) {
      const chunks = []; stream.on("data", (chunk) => chunks.push(chunk));
      stream.on("end", () => { messages.push({ raw: Buffer.concat(chunks).toString("utf8"), from: session.envelope.mailFrom.address, to: session.envelope.rcptTo.map((r) => r.address) }); done(); });
    }
  });
  server.on("error", () => {});
  await new Promise((resolve) => server.listen(port, "127.0.0.1", resolve));
  return { messages, port: server.server.address().port, reject: (code, message) => { rejects.rcpt = code ? { code, message } : null; }, close: () => new Promise((resolve) => server.close(resolve)) };
}

function parse(raw) {
  const split = raw.indexOf("\r\n\r\n");
  const lines = raw.slice(0, split).replace(/\r\n[ \t]+/g, " ").split("\r\n");
  // RFC 2047 encoded words ("=?UTF-8?Q?...?=" / "=?UTF-8?B?...?="); neighbouring words are joined without the whitespace between them.
  const decodeWords = (value) => value.replace(/\?=\s+=\?/g, "?==?").replace(/=\?UTF-8\?([QB])\?(.*?)\?=/gi, (_m, kind, text) => kind.toUpperCase() === "B"
    ? Buffer.from(text, "base64").toString("utf8")
    : Buffer.from(text.replace(/_/g, " ").replace(/=([0-9A-F]{2})/gi, (_h, hex) => String.fromCharCode(parseInt(hex, 16))), "latin1").toString("utf8"));
  const headers = lines.map((line) => [line.slice(0, line.indexOf(":")).toLowerCase(), decodeWords(line.slice(line.indexOf(":") + 1).trim())]);
  const get = (name) => headers.find(([key]) => key === name)?.[1];
  let body = raw.slice(split + 4);
  const encoding = (get("content-transfer-encoding") ?? "7bit").toLowerCase();
  if (encoding === "quoted-printable") body = Buffer.from(body.replace(/=\r\n/g, "").replace(/=([0-9A-F]{2})/g, (_m, hex) => String.fromCharCode(parseInt(hex, 16))), "latin1").toString("utf8");
  if (encoding === "base64") body = Buffer.from(body, "base64").toString("utf8");
  return { names: headers.map(([key]) => key), get, body: body.replace(/\r\n/g, "\n") };
}

function certificate(directory, name) {
  const key = path.join(directory, `${name}.key`); const cert = path.join(directory, `${name}.crt`);
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", key, "-out", cert, "-days", "2", "-subj", "/CN=mail.example.test", "-addext", "subjectAltName=IP:127.0.0.1,DNS:localhost"], { stdio: "pipe" });
  return { key: fs.readFileSync(key), cert: fs.readFileSync(cert) };
}

// One API (with its own database) per scenario, because the mail settings are per deployment.
async function deployment(t, env) {
  const database = await createTestDatabase();
  const api = await startApi({ databaseUrl: database.url, env: { ...BASE, ...env } });
  const pool = new pg.Pool({ connectionString: database.url, max: 3 });
  t.after(async () => { await api.stop(); await pool.end(); await database.drop(); });
  const admin = createClient(api.url, DEV_TOKEN);
  const workspace = async (name = "Acme Robotics") => { const response = await admin("/v1/workspaces", { method: "POST", body: { name } }); assert.equal(response.status, 201, response.text); return response.body.id; };
  const invite = (workspaceId, email, role = "engineer") => admin(`${ws(workspaceId)}/invitations`, { method: "POST", body: { email, role } });
  const emails = async () => (await pool.query("SELECT * FROM outbox WHERE kind = 'email' ORDER BY created_at")).rows;
  const settled = (id, predicate, message) => waitFor(async () => { const row = (await pool.query("SELECT * FROM outbox WHERE id = $1", [id])).rows[0]; return row && row.lease_expires_at === null && predicate(row) ? row : null; }, { timeoutMs: 20_000, message });
  const fastForward = (id) => pool.query("UPDATE outbox SET next_attempt_at = now() WHERE id = $1 AND status = 'pending'", [id]);
  return { api, pool, admin, workspace, invite, emails, settled, fastForward };
}
const closed = async () => { const server = net.createServer(); await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve)); const { port } = server.address(); await new Promise((resolve) => server.close(resolve)); return port; };

test("an invitation sends one plain-text message to the invitee, from the configured sender, with the operator's link; afterwards no text is kept", { skip }, async (t) => {
  const smtp = await smtpServer(); t.after(() => smtp.close());
  const d = await deployment(t, { SMTP_URL: `smtp://127.0.0.1:${smtp.port}?tls=none` });
  const workspaceId = await d.workspace("Acme Robotics");
  const invitation = await d.invite(workspaceId, "New.Person@Example.com", "maintainer");
  assert.equal(invitation.status, 201, invitation.text);

  const [queued] = await d.emails();
  const row = await d.settled(queued.id, (r) => r.status === "delivered", "the invitation email to be delivered");
  await sleep(500);
  assert.equal(smtp.messages.length, 1, "exactly one message");
  assert.deepEqual([row.attempts, row.last_error], [1, null]);
  const [message] = smtp.messages;
  assert.deepEqual([message.from, message.to], ["no-reply@wirepulse.example", ["new.person@example.com"]], "one envelope sender and one recipient (the address is stored lower-cased)");
  const mail = parse(message.raw);
  assert.equal(mail.get("from"), FROM); assert.equal(mail.get("to"), "new.person@example.com");
  assert.equal(mail.get("subject"), "You have been invited to Acme Robotics on WirePulse");
  assert.equal(mail.get("auto-submitted"), "auto-generated");
  assert.match(mail.get("content-type"), /^text\/plain/, "plain text only: no HTML, no tracking");
  assert.ok(mail.body.includes('workspace "Acme Robotics" as maintainer.'));
  assert.ok(mail.body.includes("https://console.example.test/"), "the operator's own link");
  assert.match(mail.body, /expires on \d{4}-\d{2}-\d{2}\./);
  assert.ok(!/<[a-z][^>]*>|https?:\/\/(?!console\.example\.test)/i.test(mail.body), "no markup and no other links");
  assert.ok(!mail.body.includes(invitation.body.id) && !mail.body.includes(DEV_TOKEN), "no internal ids or credentials");

  assert.deepEqual(row.payload, { redacted: true }, "the stored message (address and text) is dropped once it is sent");
  assert.ok(!d.api.logs().includes("new.person@example.com"), "the address is not logged");
  assert.equal((await d.admin(`${ws(workspaceId)}/audit/verify`)).body.valid, true);
});

test("tenant-controlled text cannot add headers or recipients; malformed addresses are refused before anything is queued", { skip }, async (t) => {
  const smtp = await smtpServer(); t.after(() => smtp.close());
  const d = await deployment(t, { SMTP_URL: `smtp://127.0.0.1:${smtp.port}?tls=none` });
  const hostile = 'Acme\r\nBcc: evil@example.com\r\nSubject: pwn\u2028X-Injected: yes\u0085"quoted"';
  const workspaceId = await d.workspace(hostile);
  assert.equal((await d.invite(workspaceId, "victim@example.com")).status, 201);
  const [queued] = await d.emails();
  await d.settled(queued.id, (r) => r.status === "delivered", "the message");

  assert.equal(smtp.messages.length, 1);
  assert.deepEqual(smtp.messages[0].to, ["victim@example.com"], "no extra recipient");
  const mail = parse(smtp.messages[0].raw);
  assert.equal(mail.names.filter((name) => name === "subject").length, 1, "one Subject header");
  assert.ok(!mail.names.includes("bcc") && !mail.names.includes("x-injected"), `headers: ${mail.names.join(",")}`);
  assert.ok(mail.get("subject").startsWith("You have been invited to Acme") && mail.get("subject").endsWith("on WirePulse"));
  assert.ok(!mail.get("subject").includes("pwn\r") && !/[\r\n\u2028\u0085]/.test(mail.get("subject")));
  assert.ok(mail.body.includes('Acme Bcc: evil@example.com Subject: pwn X-Injected: yes "quoted"'), "the name is flattened to one line in the body too");

  for (const email of ["a@example.com\r\nBcc: x@example.com", "a@example.com,b@example.com", "not-an-address", "a b@example.com", ""]) {
    assert.equal((await d.invite(workspaceId, email)).status, 400, JSON.stringify(email));
  }
  assert.equal((await d.emails()).length, 1, "refused invitations queued nothing");
});

test("mail never goes out in clear text by accident, and certificates are verified even when the environment says not to", { skip }, async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "wp-mail-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const selfSigned = certificate(directory, "mail");
  const previous = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
  t.after(() => { if (previous === undefined) delete process.env.NODE_TLS_REJECT_UNAUTHORIZED; else process.env.NODE_TLS_REJECT_UNAUTHORIZED = previous; });
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

  // Control: the environment override really is in effect in this process (a client that does not set the option accepts the certificate).
  const implicit = await smtpServer({ secure: true, certificate: selfSigned }); t.after(() => implicit.close());
  const lenient = await new Promise((resolve) => { const socket = tls.connect({ host: "127.0.0.1", port: implicit.port }, () => { socket.destroy(); resolve("connected"); }); socket.on("error", (error) => resolve(error.code)); });
  assert.equal(lenient, "connected");

  const noStarttls = await smtpServer({ starttls: false }); t.after(() => noStarttls.close());
  const untrusted = await smtpServer({ certificate: selfSigned }); t.after(() => untrusted.close());
  const cases = [
    ["a server that does not offer STARTTLS", `smtp://127.0.0.1:${noStarttls.port}`, noStarttls],
    ["a server whose STARTTLS certificate is not trusted", `smtp://127.0.0.1:${untrusted.port}`, untrusted],
    ["an smtps server with a self-signed certificate", `smtps://127.0.0.1:${implicit.port}`, implicit]
  ];
  for (const [label, url, server] of cases) {
    const d = await deployment(t, { SMTP_URL: url });
    const workspaceId = await d.workspace();
    assert.equal((await d.invite(workspaceId, "someone@example.com")).status, 201, label);
    const [queued] = await d.emails();
    const row = await d.settled(queued.id, (r) => r.attempts >= 1, `${label}: the first attempt`);
    assert.equal(row.status, "pending", `${label}: retried later, not dropped and not sent`);
    assert.equal(row.last_error, "smtp_tls_error", label);
    assert.equal(server.messages.length, 0, `${label}: nothing was delivered`);
    assert.notEqual(row.payload.redacted, true, `${label}: the message is still waiting`);
  }
  // Each of the above is specific to TLS: the same deployment settings with an opt-in `tls=none` do deliver.
  const plain = await smtpServer({ starttls: false }); t.after(() => plain.close());
  const optIn = await deployment(t, { SMTP_URL: `smtp://127.0.0.1:${plain.port}?tls=none` });
  assert.equal((await optIn.invite(await optIn.workspace(), "someone@example.com")).status, 201);
  await waitFor(() => plain.messages.length === 1, { message: "the opted-in plain delivery" });
});

test("a rejecting server ends the message for good, a busy one is retried, bad credentials are retried and never logged", { skip }, async (t) => {
  const smtp = await smtpServer({ credentials: { user: "mailer", pass: "p@ss w0rd/ü" } }); t.after(() => smtp.close());
  const secret = encodeURIComponent("p@ss w0rd/ü");
  const d = await deployment(t, { SMTP_URL: `smtp://mailer:${secret}@127.0.0.1:${smtp.port}?tls=none` });
  const workspaceId = await d.workspace();

  smtp.reject(550, "Mailbox unavailable");
  assert.equal((await d.invite(workspaceId, "gone@example.com")).status, 201);
  let [permanent] = await d.emails();
  permanent = await d.settled(permanent.id, (r) => r.status === "failed", "the permanent rejection");
  assert.deepEqual([permanent.attempts, permanent.last_error, permanent.payload], [1, "smtp_rejected", { redacted: true }], "no retries, and the text is dropped");
  const entry = d.api.logEntries().find((e) => e.event === "outbox.failed" && e.outboxId === permanent.id);
  assert.deepEqual([entry?.reason, entry?.kind], ["smtp_rejected", "email"]);
  assert.ok(!d.api.logs().includes("gone@example.com"));

  smtp.reject(450, "Try again later");
  assert.equal((await d.invite(workspaceId, "busy@example.com")).status, 201);
  const busy = (await d.emails()).find((r) => r.id !== permanent.id);
  const waiting = await d.settled(busy.id, (r) => r.attempts === 1, "the temporary failure");
  assert.deepEqual([waiting.status, waiting.last_error, smtp.messages.length], ["pending", "smtp_temporary_failure", 0]);
  smtp.reject(null);
  await d.fastForward(busy.id);
  const sent = await d.settled(busy.id, (r) => r.status === "delivered", "the retry after the server recovered");
  assert.deepEqual([sent.attempts, sent.payload, smtp.messages.length], [2, { redacted: true }, 1]);
  assert.deepEqual(smtp.messages[0].to, ["busy@example.com"]);

  // The credentials in SMTP_URL are used, but appear nowhere.
  assert.ok(!d.api.logs().includes("w0rd") && !d.api.logs().includes(secret));

  const wrong = await deployment(t, { SMTP_URL: `smtp://mailer:wrong@127.0.0.1:${smtp.port}?tls=none` });
  assert.equal((await wrong.invite(await wrong.workspace(), "x@example.com")).status, 201);
  const [bad] = await wrong.emails();
  const denied = await wrong.settled(bad.id, (r) => r.attempts === 1, "the failed login");
  assert.deepEqual([denied.status, denied.last_error], ["pending", "smtp_auth_failed"]);
  assert.equal(smtp.messages.length, 1, "nothing more was delivered");
});

test("an unreachable mail server never fails or delays the invitation; the message follows once it is back; with no mail server nothing is queued", { skip }, async (t) => {
  const port = await closed();
  const d = await deployment(t, { SMTP_URL: `smtp://127.0.0.1:${port}?tls=none` });
  const workspaceId = await d.workspace();
  const started = Date.now();
  const invitation = await d.invite(workspaceId, "later@example.com");
  assert.equal(invitation.status, 201); assert.ok(Date.now() - started < 3000, "the request did not wait for the mail server");
  assert.equal((await d.admin(`${ws(workspaceId)}/invitations`)).body.length, 1);
  const [queued] = await d.emails();
  const down = await d.settled(queued.id, (r) => r.attempts === 1, "the first attempt");
  assert.deepEqual([down.status, down.last_error], ["pending", "smtp_connection_failed"]);

  const smtp = await smtpServer({ port }); t.after(() => smtp.close());
  await d.fastForward(queued.id);
  await d.settled(queued.id, (r) => r.status === "delivered", "delivery after the server came back");
  assert.deepEqual(smtp.messages.map((m) => m.to), [["later@example.com"]]);

  const bare = await deployment(t, {}); // no SMTP_URL
  const bareWorkspace = await bare.workspace();
  assert.equal((await bare.invite(bareWorkspace, "nobody@example.com")).status, 201);
  assert.deepEqual(await bare.emails(), [], "no email is queued when the deployment has no mail server");
});

test("the invitation and its email are committed together or not at all", { skip }, async (t) => {
  const smtp = await smtpServer(); t.after(() => smtp.close());
  const d = await deployment(t, { SMTP_URL: `smtp://127.0.0.1:${smtp.port}?tls=none` });
  const workspaceId = await d.workspace();
  const refuse = async (table, condition) => {
    await d.pool.query(`CREATE OR REPLACE FUNCTION refuse_${table}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF ${condition} THEN RAISE EXCEPTION 'refused for the test'; END IF; RETURN NEW; END $$`);
    await d.pool.query(`CREATE TRIGGER refuse_${table} BEFORE INSERT ON ${table} FOR EACH ROW EXECUTE FUNCTION refuse_${table}()`);
    return () => d.pool.query(`DROP TRIGGER refuse_${table} ON ${table}`);
  };
  const invitations = async () => (await d.admin(`${ws(workspaceId)}/invitations`)).body.length;

  // The message cannot be queued: no invitation is created without it.
  let restore = await refuse("outbox", "true");
  try { assert.equal((await d.invite(workspaceId, "a@example.com")).status, 500); } finally { await restore(); }
  assert.deepEqual([await invitations(), (await d.emails()).length], [0, 0]);

  // The invitation cannot be completed (its audit entry is refused): no message is left behind for an invitation that does not exist.
  restore = await refuse("audit_events", "NEW.action = 'invitation.created'");
  try { assert.equal((await d.invite(workspaceId, "b@example.com")).status, 500); } finally { await restore(); }
  assert.deepEqual([await invitations(), (await d.emails()).length], [0, 0]);
  await sleep(500);
  assert.equal(smtp.messages.length, 0, "nothing was sent for either attempt");

  // Both work again afterwards, and the audit chain is intact.
  assert.equal((await d.invite(workspaceId, "c@example.com")).status, 201);
  await waitFor(() => smtp.messages.length === 1, { message: "the message for the successful invitation" });
  assert.deepEqual(smtp.messages[0].to, ["c@example.com"]);
  assert.equal((await d.admin(`${ws(workspaceId)}/audit/verify`)).body.valid, true);
});
