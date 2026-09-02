import { ResponsiveLine } from "@nivo/line";
import { useMemo } from "react";

// Group flat rows into per-keyword series, sorted by date, ranked by
// latest percentage so the grid reads high-to-low.
function shapeSmallMultiples(rows) {
  const byKeyword = new Map();

  for (const row of rows) {
    const date = String(row.snapshot_date).slice(0, 10);
    if (!byKeyword.has(row.keyword)) byKeyword.set(row.keyword, []);
    byKeyword.get(row.keyword).push({ x: date, y: row.pct ?? row.posting_count });
  }

  const series = Array.from(byKeyword.entries()).map(([keyword, data]) => {
    const sorted = data.sort((a, b) => a.x.localeCompare(b.x));
    return {
      keyword,
      data: sorted,
      latest: sorted[sorted.length - 1]?.y ?? 0,
      // Previous *period's* close, not the earliest point in the whole
      // window — a "weekly change" must mean one week, not however many
      // weeks of history the API happens to return.
      previous: sorted.length > 1 ? sorted[sorted.length - 2].y : sorted[0]?.y ?? 0,
    };
  });

  // Rank by latest value, highest first.
  series.sort((a, b) => b.latest - a.latest);
  return series;
}

function MiniChart({ keyword, data, latest, previous, yMax, grain }) {
  const delta = latest - previous;
  const trend =
    data.length < 2 ? "flat" : delta > 0.5 ? "up" : delta < -0.5 ? "down" : "flat";

  const trendColor =
    trend === "up" ? "#67b99a" : trend === "down" ? "#d9634a" : "#7c87a0";

  // Daily shows the current absolute reading. Weekly/monthly show the
  // change vs. the immediately preceding period instead — the absolute
  // close alone didn't tell the "how much did this change" story the
  // toggle is for.
  const showDelta = grain !== "daily" && data.length >= 2;
  const deltaLabel = `${delta > 0 ? "+" : ""}${delta.toFixed(1)}pp`;

  return (
    <div className="mini-card">
      <div className="mini-header">
        <span className="mini-keyword">{keyword}</span>
        <span className="mini-value" style={{ color: trendColor }}>
          {showDelta ? deltaLabel : `${latest}%`}
          {trend === "up" && " ▲"}
          {trend === "down" && " ▼"}
        </span>
      </div>
      <div className="mini-chart">
        <ResponsiveLine
          data={[{ id: keyword, data }]}
          margin={{ top: 6, right: 8, bottom: 6, left: 8 }}
          xScale={{ type: "point" }}
          yScale={{ type: "linear", min: 0, max: yMax }}
          curve="monotoneX"
          colors={[trendColor]}
          lineWidth={2}
          pointSize={data.length < 4 ? 5 : 0}
          pointColor={trendColor}
          enableGridX={false}
          enableGridY={false}
          axisTop={null}
          axisRight={null}
          axisBottom={null}
          axisLeft={null}
          enableSlices={false}
          isInteractive={false}
          animate={true}
          motionConfig="gentle"
        />
      </div>
    </div>
  );
}

export default function SmallMultiples({ rows, grain = "daily" }) {
  const series = useMemo(() => shapeSmallMultiples(rows), [rows]);

  if (!rows || rows.length === 0) {
    return <div className="empty-state">No trend data yet — charts fill in as daily scans accumulate.</div>;
  }

  // Shared y-scale across all minis so heights are comparable.
  const yMax = Math.max(...series.map((s) => Math.max(...s.data.map((d) => d.y)))) * 1.1;
  const maxPoints = Math.max(...series.map((s) => s.data.length));

  const periodLabel = grain === "weekly" ? "weeks" : grain === "monthly" ? "months" : "days";

  return (
    <>
      {maxPoints < 2 && (
        <div className="chart-note">
          Only one {grain === "daily" ? "scan" : grain.replace("ly", "")} on record so far —
          lines take shape once there are at least two {periodLabel} of data.
          The number shown is the latest close.
        </div>
      )}
      <div className="mini-grid">
        {series.map((s) => (
          <MiniChart key={s.keyword} {...s} yMax={yMax} grain={grain} />
        ))}
      </div>
    </>
  );
}