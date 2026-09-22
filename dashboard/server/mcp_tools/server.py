"""The job-market MCP server.

Shared by the stdio entry point (mcp_tools/stdio.py, for local Claude Code /
Desktop), the HTTP endpoint mounted at /mcp in main.py (for remote MCP
clients), and the "Ask the data" chat in ask.py.

(The folder is called mcp_tools, not mcp, so it doesn't shadow the `mcp`
library it imports.)
"""

import asyncio
import json
import os
from typing import Annotated, Literal

from mcp.server.mcpserver import MCPServer
from mcp.server.mcpserver.exceptions import ToolError
from pydantic import Field

from board.store import recent, stats
from databricks_client import run_query
from mcp_tools.sql_guard import guard_sql
from queries import trends_sql

CATALOG = os.getenv("DATABRICKS_CATALOG", "job_market")
SCHEMA = os.getenv("DATABRICKS_SCHEMA", "gold")
SILVER_SCHEMA = os.getenv("DATABRICKS_SILVER_SCHEMA", "silver")
ALLOWED = [f"{CATALOG}.{SCHEMA}", f"{CATALOG}.{SILVER_SCHEMA}"]

SQL_MAX_ROWS = int(os.getenv("MCP_SQL_MAX_ROWS", "500"))
SQL_TIMEOUT_SECONDS = float(os.getenv("MCP_SQL_TIMEOUT_SECONDS", "120"))
# Untrusted SQL runs as this principal. Give it SELECT-only grants on the
# gold/silver schemas; falls back to the dashboard token for local use.
SQL_TOKEN = os.getenv("MCP_DATABRICKS_TOKEN") or None

INSTRUCTIONS = f"""Job market data: scraped job postings processed into
Databricks (medallion layout). Gold tables ({CATALOG}.{SCHEMA}) are
aggregates: keyword/skill demand, trends over time, skill co-occurrence,
skill profiles, experience-level distribution. Silver tables
({CATALOG}.{SILVER_SCHEMA}) are per-posting: postings, extracted keywords,
experience requirements, and the curated skills vocabulary.

Prefer the curated tools (top_keywords, keyword_trends) when they fit.
For anything else, call describe_tables first, then run_sql with a single
read-only SELECT using fully qualified catalog.schema.table names.
pct columns are the percentage of postings mentioning a keyword.
recent_postings / board_stats reflect the live board, not the warehouse."""

WAREHOUSE_HINT = "The warehouse may be starting up — try again shortly."

mcp = MCPServer(name="job-market", version="1.0.0", instructions=INSTRUCTIONS)


def _json(data) -> str:
    return json.dumps(data, indent=2)


async def _warehouse(statement: str) -> list[dict]:
    """Databricks errors go back to the client as a tool error instead of
    crashing the call; a cold warehouse is the usual cause."""
    try:
        return await run_query(statement)
    except Exception as err:
        raise ToolError(f"Databricks query failed: {err}. {WAREHOUSE_HINT}") from err


@mcp.tool(structured_output=False)
async def top_keywords(limit: Annotated[int, Field(ge=1, le=200)] = 20) -> str:
    """Most in-demand skills in the latest snapshot: keyword, posting count, and % of postings mentioning it."""
    return _json(await _warehouse(
        f"""SELECT keyword, posting_count, pct, snapshot_date
            FROM {CATALOG}.{SCHEMA}.gold_keyword_latest
            ORDER BY posting_count DESC
            LIMIT {limit}"""
    ))


@mcp.tool(structured_output=False)
async def keyword_trends(
    top: Annotated[int, Field(ge=1, le=100)] = 12,
    grain: Literal["daily", "weekly", "monthly"] = "weekly",
) -> str:
    """Time series of % of postings for the top N keywords, at daily, weekly or monthly grain (weekly/monthly use the last snapshot of each completed period)."""
    return _json(await _warehouse(trends_sql(top, grain)))


# Schema rarely changes; one information_schema scan per process is plenty.
_schema_cache: dict | None = None


@mcp.tool(structured_output=False)
async def describe_tables() -> str:
    """List every queryable table (gold aggregates and silver per-posting data) with its columns and types. Call this before writing SQL for run_sql."""
    global _schema_cache
    if _schema_cache is None:
        rows = await _warehouse(
            f"""SELECT table_schema, table_name, column_name, data_type, comment
                FROM {CATALOG}.information_schema.columns
                WHERE table_schema IN ('{SCHEMA}', '{SILVER_SCHEMA}')
                ORDER BY table_schema, table_name, ordinal_position"""
        )
        tables: dict[str, list[str]] = {}
        for r in rows:
            column = f"{r['column_name']} {r['data_type']}"
            if r["comment"]:
                column += f" -- {r['comment']}"
            tables.setdefault(f"{CATALOG}.{r['table_schema']}.{r['table_name']}", []).append(column)
        _schema_cache = tables
    return _json(_schema_cache)


@mcp.tool(
    structured_output=False,
    description=(
        "Run one read-only Databricks SQL SELECT (or WITH ... SELECT) against the job market tables "
        f"and return the rows. Tables must be fully qualified (e.g. {CATALOG}.{SCHEMA}.gold_keyword_latest) "
        f"and live in {' or '.join(ALLOWED)}. Results are capped at {SQL_MAX_ROWS} rows — aggregate in SQL "
        "rather than pulling raw rows. Use explicit JOIN ... ON, not comma joins."
    ),
)
async def run_sql(sql: Annotated[str, Field(description="A single Databricks SQL SELECT statement.")]) -> str:
    checked, error = guard_sql(sql, ALLOWED, SQL_MAX_ROWS)
    if error:
        raise ToolError(f"Query rejected: {error}")
    try:
        rows = await asyncio.wait_for(run_query(checked, token=SQL_TOKEN), SQL_TIMEOUT_SECONDS)
    except asyncio.TimeoutError as err:
        raise ToolError(f"Query failed: timed out after {SQL_TIMEOUT_SECONDS:g}s") from err
    except Exception as err:
        # SQL errors are usually fixable by the model (bad column, typo), so
        # return the message verbatim.
        raise ToolError(f"Query failed: {err}") from err
    return _json({"row_count": len(rows), "truncated": len(rows) == SQL_MAX_ROWS, "rows": rows})


@mcp.tool(structured_output=False)
async def recent_postings(limit: Annotated[int, Field(ge=1, le=200)] = 20) -> str:
    """Newest job postings picked up by the live board, newest first."""
    return _json(recent(limit))


@mcp.tool(structured_output=False)
async def board_stats() -> str:
    """Live board status: buffered postings, time window, newest retrieval time."""
    return _json(stats())
