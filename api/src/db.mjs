import pg from "pg";

const { Pool, Client } = pg;

export function createDatabase({ url, poolSize = 10, ssl, statementTimeoutMs = 15_000, idleTxTimeoutMs = 15_000, connectTimeoutMs = 5_000, log }) {
  const clientConfig = { connectionString: url, ssl, application_name: "wirepulse-api", connectionTimeoutMillis: connectTimeoutMs };
  const pool = new Pool({ ...clientConfig, max: poolSize, idleTimeoutMillis: 30_000, statement_timeout: statementTimeoutMs, idle_in_transaction_session_timeout: idleTxTimeoutMs });
  // An idle client dropped by the server must not crash the process; the pool replaces it on the next checkout.
  pool.on("error", (error) => log?.error({ err: error }, "idle database client error"));
  return {
    query: (text, values) => pool.query(text, values),
    transaction: async (fn) => {
      const client = await pool.connect();
      // The pool only listens to idle clients. A connection that drops while checked out (restart, failover, the idle-in-transaction
      // timeout) emits an error with no one listening, which would crash the process; the failing query or COMMIT reports it instead.
      const onError = (error) => log?.error({ err: error }, "database client error during a transaction");
      client.on("error", onError);
      let broken;
      try { await client.query("BEGIN"); const result = await fn(client); await client.query("COMMIT"); return result; }
      catch (error) { try { await client.query("ROLLBACK"); } catch (rollbackError) { broken = rollbackError; } throw error; }
      finally { client.removeListener("error", onError); client.release(broken); }
    },
    // Dedicated connection for LISTEN/NOTIFY; it must not come from the pool and must not sit behind a transaction-mode pooler.
    newListenerClient: () => new Client({ ...clientConfig, keepAlive: true }),
    stats: () => ({ total: pool.totalCount, idle: pool.idleCount, waiting: pool.waitingCount }),
    health: async () => { await pool.query("SELECT 1"); },
    close: () => pool.end()
  };
}

// Always the last statement of a transaction: the audit hash chain serializes writers per workspace until commit.
export async function audit(executor, event) {
  await executor.query(
    `INSERT INTO audit_events (workspace_id, actor_subject, action, resource_type, resource_id, request_id, ip_address, details)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [event.workspaceId, event.actor, event.action, event.resourceType, event.resourceId ?? null, event.requestId, event.ip ?? null, event.details ?? {}]
  );
}
