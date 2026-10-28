import assert from "node:assert/strict";
import test from "node:test";
import pg from "pg";
import { createDatabase } from "../src/db.mjs";
import { createTestDatabase, skip, sleep } from "./helpers.mjs";

// A database restart, a failover or the server's idle-in-transaction timeout closes connections that are checked out of the pool.
// An error event nobody listens for crashes the whole Node process (and every request it is serving), so these run for real
// against PostgreSQL: if the process were to crash, node:test reports an uncaught exception and fails the test.
let database; let admin;
const quiet = { error() {}, warn() {}, info() {} };

test.before(async () => {
  if (skip) return;
  database = await createTestDatabase();
  admin = new pg.Pool({ connectionString: database.url, max: 2 });
});
test.after(async () => { await admin?.end(); await database?.drop(); });

test("a connection terminated between two queries of a transaction fails that request, not the process", { skip }, async () => {
  const db = createDatabase({ url: database.url, log: quiet });
  try {
    await assert.rejects(db.transaction(async (client) => {
      const { rows } = await client.query("SELECT pg_backend_pid() AS pid");
      await admin.query("SELECT pg_terminate_backend($1)", [rows[0].pid]);
      await sleep(300); // nothing is running on the client when the connection drops
      await client.query("SELECT 1");
    }));
    await sleep(100);
    assert.equal((await db.query("SELECT 1 AS ok")).rows[0].ok, 1, "the pool hands out a working connection afterwards");
  } finally { await db.close(); }
});

test("the server's idle-in-transaction timeout fails the request, not the process", { skip }, async () => {
  const db = createDatabase({ url: database.url, log: quiet, idleTxTimeoutMs: 200 });
  try {
    await assert.rejects(db.transaction(async (client) => {
      await client.query("SELECT 1");
      await sleep(600); // the server ends the session after 200 ms of idleness inside the transaction
      await client.query("SELECT 2");
    }));
    await sleep(100);
    assert.equal((await db.query("SELECT 1 AS ok")).rows[0].ok, 1);
  } finally { await db.close(); }
});
