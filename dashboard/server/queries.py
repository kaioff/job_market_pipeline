"""SQL shared by the HTTP API and the MCP server, so both answer identically."""

import os

CATALOG = os.getenv("DATABRICKS_CATALOG", "job_market")
SCHEMA = os.getenv("DATABRICKS_SCHEMA", "gold")

GRAINS = ["daily", "weekly", "monthly"]


def trends_sql(top_n: int, grain: str) -> str:
    """Time series for the top N keywords at the given grain.

    Weekly/monthly use the "close" value: the last snapshot in each period.
    """
    period_expr = {
        "weekly": "date_trunc('week', t.snapshot_date)",
        "monthly": "date_trunc('month', t.snapshot_date)",
    }.get(grain, "t.snapshot_date")

    # For weekly/monthly, today always falls inside the still-open current
    # period, so its "close" is just today's raw daily value — identical to
    # the daily grain's latest point no matter which grain is selected. Drop
    # that in-progress period (unless it's the only data we have) so the
    # headline reflects the last *completed* week/month instead.
    current_period_expr = {
        "weekly": "date_trunc('week', current_date())",
        "monthly": "date_trunc('month', current_date())",
    }.get(grain)

    completed_cte = (
        f""",
      completed AS (
        SELECT COUNT(DISTINCT period) AS n
        FROM ranked
        WHERE period < {current_period_expr}
      )"""
        if current_period_expr
        else ""
    )
    completed_filter = (
        f"AND (period < {current_period_expr} OR (SELECT n FROM completed) = 0)"
        if current_period_expr
        else ""
    )

    return f"""
      WITH top_keywords AS (
        SELECT keyword
        FROM {CATALOG}.{SCHEMA}.gold_keyword_latest
        ORDER BY posting_count DESC
        LIMIT {top_n}
      ),
      joined AS (
        SELECT
          t.keyword,
          t.snapshot_date,
          {period_expr} AS period,
          t.pct,
          t.posting_count
        FROM {CATALOG}.{SCHEMA}.gold_keyword_trends t
        INNER JOIN top_keywords k ON t.keyword = k.keyword
      ),
      -- "close" = the last snapshot within each period, per keyword
      ranked AS (
        SELECT
          keyword,
          period,
          pct,
          posting_count,
          ROW_NUMBER() OVER (
            PARTITION BY keyword, period
            ORDER BY snapshot_date DESC
          ) AS rn
        FROM joined
      ){completed_cte}
      SELECT
        keyword,
        CAST(period AS DATE) AS snapshot_date,
        pct,
        posting_count
      FROM ranked
      WHERE rn = 1
      {completed_filter}
      ORDER BY period ASC, pct DESC
  """
