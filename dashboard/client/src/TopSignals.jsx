export default function TopSignals({ rows }) {
  if (!rows || rows.length === 0) return null;

  const max = rows[0]?.pct || rows[0]?.posting_count || 1;

  return (
    <ol className="signals-list">
      {rows.slice(0, 15).map((row, i) => {
        const value = row.pct ?? row.posting_count;
        const pct = Math.round((value / max) * 100);
        return (
          <li key={row.keyword} className="signals-row">
            <span className="signals-rank">{String(i + 1).padStart(2, "0")}</span>
            <span className="signals-keyword">{row.keyword}</span>
            <span className="signals-bar-track">
              <span className="signals-bar-fill" style={{ width: `${pct}%` }} />
            </span>
            <span className="signals-count">
              {row.pct != null ? `${row.pct}%` : row.posting_count}
            </span>
          </li>
        );
      })}
    </ol>
  );
}
