import { DBSQLClient } from "@databricks/sql";

/**
 * Runs a single SQL query against the Databricks SQL Warehouse and returns
 * the rows as plain JS objects. Opens and closes a fresh session per call —
 * simplest correct approach for a low-traffic dashboard; not optimized for
 * high concurrency (see note below if traffic ever grows).
 *
 * Note on cold starts: if the SQL Warehouse has been idle, the underlying
 * cluster may take 30s-3min to spin up on the first query. Callers should
 * show a loading state rather than assuming a fast response.
 */
export async function runQuery(sql) {
  const client = new DBSQLClient();

  await client.connect({
    host: process.env.DATABRICKS_SERVER_HOSTNAME,
    path: process.env.DATABRICKS_HTTP_PATH,
    token: process.env.DATABRICKS_TOKEN,
  });

  try {
    const session = await client.openSession();

    const operation = await session.executeStatement(sql, {
      runAsync: true,
      maxRows: 10000,
    });

    const rows = await operation.fetchAll();
    await operation.close();
    await session.close();

    return rows;
  } finally {
    await client.close();
  }
}
