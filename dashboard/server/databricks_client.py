"""Runs SQL against the Databricks SQL Warehouse.

Opens and closes a fresh connection per call — simplest correct approach for
a low-traffic dashboard; not optimized for high concurrency.

Note on cold starts: if the SQL Warehouse has been idle, the underlying
cluster may take 30s-3min to spin up on the first query. Callers should show
a loading state rather than assuming a fast response.
"""

import asyncio
import os
from datetime import date, datetime, timezone
from decimal import Decimal

from databricks import sql


def _iso(value: datetime) -> str:
    """Same shape JavaScript's Date.toISOString() produced: ms precision, Z."""
    if value.tzinfo is not None:
        value = value.astimezone(timezone.utc).replace(tzinfo=None)
    return value.strftime("%Y-%m-%dT%H:%M:%S.") + f"{value.microsecond // 1000:03d}Z"


def _to_json(value):
    """Converts driver types into what the dashboard has always received.

    The old Node driver returned DECIMAL as a number and DATE/TIMESTAMP as a
    JS Date (serialized as "2026-09-21T00:00:00.000Z"); the React page
    parses exactly that, so the Python server keeps the same wire format.
    """
    if isinstance(value, Decimal):
        return float(value)
    if isinstance(value, datetime):
        return _iso(value)
    if isinstance(value, date):
        return _iso(datetime(value.year, value.month, value.day))
    return value


def _run_sync(statement: str, token: str | None) -> list[dict]:
    with sql.connect(
        server_hostname=os.environ["DATABRICKS_SERVER_HOSTNAME"],
        http_path=os.environ["DATABRICKS_HTTP_PATH"],
        access_token=token or os.environ["DATABRICKS_TOKEN"],
    ) as conn:
        with conn.cursor() as cursor:
            cursor.execute(statement)
            columns = [c[0] for c in cursor.description or []]
            return [
                {col: _to_json(val) for col, val in zip(columns, row)}
                for row in cursor.fetchmany(10000)
            ]


async def run_query(statement: str, token: str | None = None) -> list[dict]:
    """Returns the rows of one SQL statement as plain dicts.

    `token` overrides DATABRICKS_TOKEN — the MCP SQL tool passes a read-only
    one so untrusted queries can't write even if a guard slips.

    The Databricks driver is blocking, so it runs on a worker thread to keep
    the server responsive while the warehouse wakes up.
    """
    return await asyncio.to_thread(_run_sync, statement, token)
