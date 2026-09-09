import { runQuery } from "../../databricksClient.js";

/**
 * Secondary, best-effort sink: mirrors postings into Delta so they feed the
 * medallion layers.
 *
 * Explicitly NOT the durability guarantee — sqliteSink is. This one is
 * allowed to fail and be skipped, because on Free Edition the warehouse is
 * frequently unavailable (compute gets gated for inactivity) and the board
 * must not care. Write-only: nothing on the request path reads this table,
 * so the warehouse stays asleep apart from these writes.
 */

const CATALOG = process.env.DATABRICKS_CATALOG || "job_market";
const LIVE_TABLE = `${CATALOG}.bronze.linkedin_postings_live`;

function sqlStr(v) {
  if (v === null || v === undefined) return "NULL";
  return `'${String(v).replace(/'/g, "''")}'`;
}

/**
 * MERGE rather than INSERT because Delta enforces no unique constraint —
 * there is no ON CONFLICT to lean on. In practice the poller only hands us
 * postings the store already judged new, so WHEN NOT MATCHED is the only
 * branch that fires; the MERGE is belt-and-braces against a restart
 * racing a poll before seed() completes.
 */
async function persist(postings) {
  if (!postings.length) return;

  const values = postings
    .map(
      (p) =>
        `(${sqlStr(p.posting_id)}, ${sqlStr(p.title)}, ${sqlStr(p.company)}, ` +
        `${sqlStr(p.location)}, ${sqlStr(p.job_url)}, ` +
        `${p.posted_at ? `CAST(${sqlStr(p.posted_at)} AS DATE)` : "NULL"}, ` +
        `${p.posted_at_precise ? `CAST(${sqlStr(p.posted_at_precise)} AS TIMESTAMP)` : "NULL"}, ` +
        `${p.applicants ?? "NULL"}, ` +
        `CAST(${sqlStr(p.retrieved_at)} AS TIMESTAMP), ${sqlStr(p.source)})`
    )
    .join(",\n      ");

  const sql = `
    MERGE INTO ${LIVE_TABLE} AS t
    USING (
      SELECT * FROM VALUES
      ${values}
      AS s(posting_id, title, company, location, job_url, posted_at,
           posted_at_precise, applicants, retrieved_at, source)
    ) AS s
    ON t.posting_id = s.posting_id
    WHEN NOT MATCHED THEN INSERT *
  `;

  await runQuery(sql);
}

export const deltaSink = {
  name: "delta",
  primary: false,
  persist,
};
