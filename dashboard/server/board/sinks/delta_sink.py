"""Secondary, best-effort sink: mirrors postings into Delta so they feed the
medallion layers.

Explicitly NOT the durability guarantee — sqlite_sink is. This one is allowed
to fail and be skipped, because on Free Edition the warehouse is frequently
unavailable (compute gets gated for inactivity) and the board must not care.
Write-only: nothing on the request path reads this table, so the warehouse
stays asleep apart from these writes.
"""

import os

from databricks_client import run_query

CATALOG = os.getenv("DATABRICKS_CATALOG", "job_market")
LIVE_TABLE = f"{CATALOG}.bronze.linkedin_postings_live"


def _sql_str(v) -> str:
    if v is None:
        return "NULL"
    return "'" + str(v).replace("'", "''") + "'"


def _row(p: dict) -> str:
    posted_at = f"CAST({_sql_str(p['posted_at'])} AS DATE)" if p.get("posted_at") else "NULL"
    precise = (
        f"CAST({_sql_str(p['posted_at_precise'])} AS TIMESTAMP)"
        if p.get("posted_at_precise")
        else "NULL"
    )
    applicants = p.get("applicants")
    return (
        f"({_sql_str(p['posting_id'])}, {_sql_str(p.get('title'))}, {_sql_str(p.get('company'))}, "
        f"{_sql_str(p.get('location'))}, {_sql_str(p.get('job_url'))}, "
        f"{posted_at}, {precise}, "
        f"{int(applicants) if applicants is not None else 'NULL'}, "
        f"CAST({_sql_str(p['retrieved_at'])} AS TIMESTAMP), {_sql_str(p.get('source'))})"
    )


class DeltaSink:
    name = "delta"
    primary = False

    async def persist(self, postings: list[dict]) -> None:
        """MERGE rather than INSERT because Delta enforces no unique constraint.

        There is no ON CONFLICT to lean on. In practice the poller only hands
        us postings the store already judged new, so WHEN NOT MATCHED is the
        only branch that fires; the MERGE is belt-and-braces against a
        restart racing a poll before seed() completes.
        """
        if not postings:
            return
        values = ",\n      ".join(_row(p) for p in postings)
        await run_query(
            f"""
            MERGE INTO {LIVE_TABLE} AS t
            USING (
              SELECT * FROM VALUES
              {values}
              AS s(posting_id, title, company, location, job_url, posted_at,
                   posted_at_precise, applicants, retrieved_at, source)
            ) AS s
            ON t.posting_id = s.posting_id
            WHEN NOT MATCHED THEN INSERT *
            """
        )


delta_sink = DeltaSink()
