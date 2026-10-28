// The webhook sender on its own, against real local sockets: signing, the destination policy (including DNS rebinding, redirects and
// plain http), TLS verification (also with the environment trying to switch it off), timeouts and oversized responses.
import test from "node:test";
import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createGuard } from "../src/netguard.mjs";
import { postJson, secretFor, sign, verifySignature } from "../src/webhook-send.mjs";

const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src");
const loopbackOnly = createGuard({ allowedCidrs: ["127.0.0.0/8"] });
const strict = createGuard({ allowedCidrs: [] });

async function receiver(handler) {
  const requests = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => { requests.push({ method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(chunks).toString() }); handler(req, res, requests.length); });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { requests, port: server.address().port, url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }) };
}
const ok = (_req, res) => { res.statusCode = 200; res.end("ok"); };
const send = (url, options = {}) => postJson({ url, body: '{"hello":"world"}', headers: { "content-type": "application/json" }, guard: loopbackOnly, timeoutMs: 2000, ...options });

test("signatures: derived secrets are stable per webhook and version, and the verifier rejects tampering, wrong secrets and stale timestamps", () => {
  const key = "k".repeat(32);
  const secret = secretFor(key, "11111111-1111-4111-8111-111111111111", 1);
  assert.match(secret, /^whsec_[A-Za-z0-9_-]{43}$/);
  assert.equal(secret, secretFor(key, "11111111-1111-4111-8111-111111111111", 1));
  for (const other of [secretFor(key, "11111111-1111-4111-8111-111111111111", 2), secretFor(key, "22222222-2222-4222-8222-222222222222", 1), secretFor("j".repeat(32), "11111111-1111-4111-8111-111111111111", 1)]) assert.notEqual(other, secret);

  const body = '{"id":"x","data":{"a":1}}'; const now = Date.now(); const stamp = Math.floor(now / 1000);
  const header = sign(secret, stamp, body);
  assert.match(header, /^t=\d+,v1=[0-9a-f]{64}$/);
  assert.equal(verifySignature(secret, header, body, { now }), true);
  assert.equal(verifySignature(secret, header, `${body} `, { now }), false, "any change to the body breaks the signature");
  assert.equal(verifySignature(secretFor(key, "11111111-1111-4111-8111-111111111111", 2), header, body, { now }), false, "a rotated secret does not verify the old signature");
  assert.equal(verifySignature(secret, header, body, { now: now + 301_000 }), false, "a replayed old delivery is outside the tolerance window");
  assert.equal(verifySignature(secret, header, body, { now: now - 301_000 }), false, "so is one from the future");
  assert.equal(verifySignature(secret, header, body, { now: now + 299_000 }), true);
  // The timestamp is part of what is signed: moving it forward does not help a replay.
  assert.equal(verifySignature(secret, header.replace(`t=${stamp}`, `t=${stamp + 1}`), body, { now }), false);
  for (const junk of [undefined, "", "t=,v1=", "v1=abc", `t=${stamp}`, `t=${stamp},v1=zz`, `t=${stamp},v1=${"0".repeat(64)}`, `t=abc,v1=${"0".repeat(64)}`]) assert.equal(verifySignature(secret, junk, body, { now }), false, String(junk));
});

test("a delivery is one POST with exactly the given body and headers; any 2xx is success", async () => {
  const target = await receiver(ok);
  try {
    const result = await send(`${target.url}/hooks/a?x=1`, { headers: { "content-type": "application/json", "x-wirepulse-event": "job.finished" } });
    assert.deepEqual(result, { ok: true, status: 200, error: null });
    const [request] = target.requests;
    assert.equal(request.method, "POST"); assert.equal(request.url, "/hooks/a?x=1"); assert.equal(request.body, '{"hello":"world"}');
    assert.equal(request.headers["x-wirepulse-event"], "job.finished"); assert.equal(request.headers["content-length"], String(Buffer.byteLength('{"hello":"world"}')));
    assert.equal(request.headers.connection, "close", "no pooled connections are kept to receivers");
  } finally { await target.close(); }
  for (const status of [201, 204]) { const t = await receiver((_q, res) => { res.statusCode = status; res.end(); }); try { assert.equal((await send(t.url)).ok, true, String(status)); } finally { await t.close(); } }
});

test("non-2xx answers fail with their status, and redirects are never followed", async () => {
  for (const status of [400, 404, 410, 429, 500, 503]) {
    const t = await receiver((_q, res) => { res.statusCode = status; res.end("nope"); });
    try { assert.deepEqual(await send(t.url), { ok: false, status, error: `http_${status}` }); } finally { await t.close(); }
  }
  const trap = await receiver(ok);
  const redirecting = await receiver((_q, res) => { res.statusCode = 302; res.setHeader("location", `${trap.url}/stolen`); res.end(); });
  try {
    for (const status of [301, 302, 303, 307, 308]) {
      redirecting.requests.length = 0;
      const t = await receiver((_q, res) => { res.statusCode = status; res.setHeader("location", `${trap.url}/stolen`); res.end(); });
      try { assert.deepEqual(await send(t.url), { ok: false, status, error: "redirect_not_followed" }); } finally { await t.close(); }
    }
    assert.equal(trap.requests.length, 0, "the redirect target was never contacted");
  } finally { await redirecting.close(); await trap.close(); }
});

test("destinations: nothing outside the allow-list is reachable, and the policy applies to every address a name resolves to", async () => {
  const target = await receiver(ok);
  try {
    // No allow-list: loopback is private, so the receiver never sees a request, whatever the spelling.
    for (const url of [target.url, `http://localhost:${target.port}`, `http://[::ffff:127.0.0.1]:${target.port}`, `http://127.1:${target.port}`]) {
      assert.deepEqual(await send(url, { guard: strict }), { ok: false, status: null, error: "destination_blocked" }, url);
    }
    assert.equal(target.requests.length, 0);

    // Never-allowed ranges stay blocked even when an operator allows them explicitly.
    const permissive = createGuard({ allowedCidrs: ["0.0.0.0/0", "169.254.0.0/16"] });
    assert.equal((await send("http://169.254.169.254/latest/meta-data", { guard: permissive })).error, "destination_blocked");
    assert.equal((await send("https://[fe80::1]/x", { guard: permissive })).error, "destination_blocked");

    // A name with one bad answer among good ones is refused as a whole.
    const mixed = async () => [{ address: "93.184.216.34", family: 4 }, { address: "10.0.0.5", family: 4 }];
    assert.equal((await send("https://mixed.example.test/hook", { guard: strict, lookup: mixed })).error, "destination_blocked");
    // Unparsable or empty answers are refused too.
    assert.equal((await send("https://empty.example.test/hook", { guard: strict, lookup: async () => [] })).error, "destination_blocked");
    assert.equal((await send("https://odd.example.test/hook", { guard: strict, lookup: async () => [{ address: "not-an-ip", family: 4 }] })).error, "destination_blocked");

    // Plain http only reaches allow-listed addresses, even if the name resolves to a public one.
    const publicOnly = async () => [{ address: "93.184.216.34", family: 4 }];
    assert.equal((await send("http://public.example.test/hook", { guard: strict, lookup: publicOnly })).error, "destination_blocked");
    assert.equal((await send("http://public.example.test/hook", { guard: loopbackOnly, lookup: publicOnly })).error, "destination_blocked");
    assert.equal(target.requests.length, 0);

    // Malformed or unsupported URLs.
    for (const url of ["not a url", "ftp://127.0.0.1/x", "file:///etc/passwd", "http://user:pw@127.0.0.1/x", "javascript:alert(1)"]) assert.equal((await send(url)).error, "invalid_url", url);
  } finally { await target.close(); }
});

test("DNS rebinding: the connection goes to the address that was vetted, not to whatever the name resolves to afterwards", async () => {
  const target = await receiver(ok);
  const lookups = [];
  // First answer is the allow-listed receiver; any later answer would be the cloud metadata address.
  const rebinding = async (hostname) => { lookups.push(hostname); return [{ address: lookups.length === 1 ? "127.0.0.1" : "169.254.169.254", family: 4 }]; };
  try {
    const result = await send(`http://rebind.example.test:${target.port}/hook`, { lookup: rebinding });
    assert.deepEqual(result, { ok: true, status: 200, error: null });
    assert.equal(target.requests.length, 1);
    assert.equal(target.requests[0].headers.host, `rebind.example.test:${target.port}`, "the Host header still names the configured host");
    assert.equal(lookups.length, 1, "the name was resolved once; the socket reused that answer");
  } finally { await target.close(); }
});

test("timeouts: a receiver that never answers, or answers headers only slowly, is cut off at the deadline", async () => {
  const silent = await receiver(() => { /* never respond */ });
  try {
    const started = Date.now();
    const result = await send(silent.url, { timeoutMs: 600 });
    assert.deepEqual(result, { ok: false, status: null, error: "timeout" });
    assert.ok(Date.now() - started < 2500, `gave up after ${Date.now() - started} ms`);
  } finally { await silent.close(); }

  // Accepts the TCP connection but never completes the TLS handshake: the deadline covers the connect/TLS phase too.
  const sockets = new Set();
  const mute = net.createServer((socket) => { sockets.add(socket); socket.on("close", () => sockets.delete(socket)); socket.on("error", () => {}); });
  await new Promise((resolve) => mute.listen(0, "127.0.0.1", resolve));
  try {
    const started = Date.now();
    assert.equal((await send(`https://127.0.0.1:${mute.address().port}/x`, { timeoutMs: 600 })).error, "timeout");
    assert.ok(Date.now() - started < 2500);
  } finally { for (const socket of sockets) socket.destroy(); await new Promise((resolve) => mute.close(resolve)); }

  const refused = await receiver(ok); const port = refused.port; await refused.close();
  assert.equal((await send(`http://127.0.0.1:${port}/x`)).error, "connection_failed");
});

test("the response body is never read: an endless or huge body does not delay or break the delivery", async () => {
  let aborted = false;
  const endless = await receiver((_req, res) => {
    res.writeHead(200, { "content-type": "text/plain" });
    const timer = setInterval(() => res.write("x".repeat(65_536)), 1);
    res.on("close", () => { aborted = true; clearInterval(timer); });
  });
  try {
    const started = Date.now();
    assert.deepEqual(await send(endless.url), { ok: true, status: 200, error: null });
    assert.ok(Date.now() - started < 1500, "returned as soon as the status line arrived");
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(aborted, true, "the connection was dropped rather than drained");
  } finally { await endless.close(); }
});

// TLS needs a certificate; openssl is the one external tool the tests rely on.
function makeCertificate(directory, name, subjectAltName) {
  const key = path.join(directory, `${name}.key`); const cert = path.join(directory, `${name}.crt`);
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", key, "-out", cert, "-days", "2", "-subj", "/CN=wirepulse-test", "-addext", `subjectAltName=${subjectAltName}`], { stdio: "pipe" });
  return { key: fs.readFileSync(key), cert: fs.readFileSync(cert), certPath: cert };
}
async function tlsReceiver(credentials) {
  const requests = [];
  const server = https.createServer({ key: credentials.key, cert: credentials.cert }, (req, res) => { requests.push(req.url); res.statusCode = 200; res.end("ok"); req.resume(); });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { requests, port: server.address().port, close: () => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }) };
}

test("TLS: certificates are verified, also when the environment says not to; a private CA is honoured only through the operator's trust store", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "wp-tls-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const selfSigned = makeCertificate(directory, "good", "IP:127.0.0.1,DNS:localhost");
  const wrongName = makeCertificate(directory, "wrong", "DNS:somewhere-else.example.test");
  const good = await tlsReceiver(selfSigned); const wrong = await tlsReceiver(wrongName);
  t.after(() => Promise.all([good.close(), wrong.close()]));
  const previous = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
  try {
    // Control: with verification switched off in the environment, a client that does not set the option itself accepts the certificate.
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
    const lenient = await new Promise((resolve) => { const request = https.request({ host: "127.0.0.1", port: good.port, method: "GET", path: "/control", agent: false }, (res) => { res.resume(); resolve(res.statusCode); }); request.on("error", (error) => resolve(error.code)); request.end(); });
    assert.equal(lenient, 200, "the environment override works in this process, so the next assertions are meaningful");
    good.requests.length = 0;

    // The sender does not honour it: an untrusted certificate fails.
    assert.deepEqual(await send(`https://127.0.0.1:${good.port}/hook`), { ok: false, status: null, error: "tls_error" });
    assert.deepEqual(await send(`https://127.0.0.1:${wrong.port}/hook`), { ok: false, status: null, error: "tls_error" });
    assert.equal(good.requests.length, 0, "no request was sent over the unverified connection");
    assert.equal(wrong.requests.length, 0);
  } finally { if (previous === undefined) delete process.env.NODE_TLS_REJECT_UNAUTHORIZED; else process.env.NODE_TLS_REJECT_UNAUTHORIZED = previous; }

  // With the certificate in the operator's trust store (NODE_EXTRA_CA_CERTS, read at process start), the matching host is accepted and a
  // certificate for another name is still refused: trust and host name are both checked.
  const script = path.join(directory, "probe.mjs");
  fs.writeFileSync(script, `
    import { createGuard } from ${JSON.stringify(pathToFileURL(path.join(SRC, "netguard.mjs")).href)};
    import { postJson } from ${JSON.stringify(pathToFileURL(path.join(SRC, "webhook-send.mjs")).href)};
    const guard = createGuard({ allowedCidrs: ["127.0.0.0/8"] });
    const [good, wrong] = process.argv.slice(2);
    const probe = (port) => postJson({ url: "https://127.0.0.1:" + port + "/hook", body: "{}", headers: {}, guard, timeoutMs: 3000 });
    console.log(JSON.stringify({ good: await probe(good), wrong: await probe(wrong) }));
  `);
  const bundle = path.join(directory, "bundle.pem");
  fs.writeFileSync(bundle, `${fs.readFileSync(selfSigned.certPath)}\n${fs.readFileSync(wrongName.certPath)}`);
  const env = { ...process.env, NODE_EXTRA_CA_CERTS: bundle }; delete env.NODE_TLS_REJECT_UNAUTHORIZED;
  // Asynchronous on purpose: the TLS receivers live in this process and must keep answering while the child probes them.
  const child = await new Promise((resolve) => execFile(process.execPath, [script, String(good.port), String(wrong.port)], { env, encoding: "utf8" }, (error, stdout, stderr) => resolve({ status: error ? error.code ?? 1 : 0, stdout, stderr })));
  assert.equal(child.status, 0, child.stderr);
  assert.deepEqual(JSON.parse(child.stdout), { good: { ok: true, status: 200, error: null }, wrong: { ok: false, status: null, error: "tls_error" } });
  assert.deepEqual(good.requests, ["/hook"]); assert.deepEqual(wrong.requests, []);
});
