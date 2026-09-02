import "dotenv/config";
import express from "express";
import cors from "cors";
import NodeCache from "node-cache";
import { runQuery } from "./databricksClient.js";

const app = express();
app.use(cors());

const PORT = process.env.PORT || 4000;
const CATALOG = process.env.DATABRICKS_CATALOG || "job_market";
const SCHEMA = process.env.DATABRICKS_SCHEMA || "gold";

const cache = new NodeCache({
  stdTTL: Number(process.env.CACHE_TTL_SECONDS || 3600),
});

async function cachedQuery(cacheKey, sql) {
  const hit = cache.get(cacheKey);
  if (hit) return hit;
  const rows = await runQuery(sql);
  cache.set(cacheKey, rows);
  return rows;
}

// Latest snapshot: keyword, raw count, and TRUE percentage of postings
// (pct is computed correctly in the gold_keyword_latest model itself,
// against a real count of total postings — not approximated here).
app.get("/api/keywords/latest", async (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 40, 200);

  try {
    const rows = await cachedQuery(
      `latest:${limit}`,
      `SELECT keyword, posting_count, snapshot_date, pct
       FROM ${CATALOG}.${SCHEMA}.gold_keyword_latest
       ORDER BY posting_count DESC
       LIMIT ${limit}`
    );
    res.json(rows);
  } catch (err) {
    console.error("Error fetching latest keywords:", err);
    res.status(502).json({ error: "Failed to query Databricks. The warehouse may be starting up — try again shortly." });
  }
});

// Time series for top N keywords, at daily / weekly / monthly grain.
// Weekly/monthly use the "close" value: the last snapshot in each period.
// pct now comes straight from gold_keyword_trends (real denominator).
app.get("/api/keywords/trends", async (req, res) => {
  const topN = Math.min(Number(req.query.top) || 12, 100);
  const grain = ["daily", "weekly", "monthly"].includes(req.query.grain)
    ? req.query.grain
    : "daily";

  const periodExpr =
    grain === "weekly"
      ? "date_trunc('week', t.snapshot_date)"
      : grain === "monthly"
      ? "date_trunc('month', t.snapshot_date)"
      : "t.snapshot_date";

  // For weekly/monthly, today always falls inside the still-open current
  // period, so its "close" is just today's raw daily value — identical to
  // the daily grain's latest point no matter which grain is selected. Drop
  // that in-progress period (unless it's the only data we have) so the
  // headline reflects the last *completed* week/month instead.
  const currentPeriodExpr =
    grain === "weekly"
      ? "date_trunc('week', current_date())"
      : grain === "monthly"
      ? "date_trunc('month', current_date())"
      : null;

  try {
    const sql = `
      WITH top_keywords AS (
        SELECT keyword
        FROM ${CATALOG}.${SCHEMA}.gold_keyword_latest
        ORDER BY posting_count DESC
        LIMIT ${topN}
      ),
      joined AS (
        SELECT
          t.keyword,
          t.snapshot_date,
          ${periodExpr} AS period,
          t.pct,
          t.posting_count
        FROM ${CATALOG}.${SCHEMA}.gold_keyword_trends t
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
      )${
        currentPeriodExpr
          ? `,
      completed AS (
        SELECT COUNT(DISTINCT period) AS n
        FROM ranked
        WHERE period < ${currentPeriodExpr}
      )`
          : ""
      }
      SELECT
        keyword,
        CAST(period AS DATE) AS snapshot_date,
        pct,
        posting_count
      FROM ranked
      WHERE rn = 1
      ${
        currentPeriodExpr
          ? `AND (period < ${currentPeriodExpr} OR (SELECT n FROM completed) = 0)`
          : ""
      }
      ORDER BY period ASC, pct DESC
    `;

    const rows = await cachedQuery(`trends:${topN}:${grain}`, sql);
    res.json(rows);
  } catch (err) {
    console.error("Error fetching keyword trends:", err);
    res.status(502).json({ error: "Failed to query Databricks. The warehouse may be starting up — try again shortly." });
  }
});

app.get("/api/health", (req, res) => res.json({ status: "ok" }));

// Experience-level distribution across all current postings.
app.get("/api/experience", async (req, res) => {
  try {
    const rows = await cachedQuery(
      "experience",
      `SELECT experience_band, posting_count, pct
       FROM ${CATALOG}.${SCHEMA}.gold_experience_distribution`
    );
    res.json(rows);
  } catch (err) {
    console.error("Error fetching experience distribution:", err);
    res.status(502).json({ error: "Failed to query Databricks. The warehouse may be starting up — try again shortly." });
  }
});

app.listen(PORT, () => {
  console.log(`API server running on http://localhost:${PORT}`);
});