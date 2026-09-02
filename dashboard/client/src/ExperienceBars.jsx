const BAND_LABELS = {
  "0-2": "0–2 years",
  "3-5": "3–5 years",
  "5-8": "5–8 years",
  "8+": "8+ years",
  not_specified: "Not specified",
};

const BAND_ORDER = ["0-2", "3-5", "5-8", "8+", "not_specified"];

export default function ExperienceBars({ rows }) {
  if (!rows || rows.length === 0) {
    return <div className="empty-state">No experience data yet.</div>;
  }

  const byBand = new Map(rows.map((r) => [r.experience_band, r]));
  const ordered = BAND_ORDER.map((band) => byBand.get(band)).filter(Boolean);
  const maxPct = Math.max(...ordered.map((r) => r.pct));

  return (
    <div className="exp-bars">
      {ordered.map((row) => {
        const isUnspecified = row.experience_band === "not_specified";
        const widthPct = Math.round((row.pct / maxPct) * 100);
        return (
          <div key={row.experience_band} className="exp-row">
            <span className="exp-label">{BAND_LABELS[row.experience_band]}</span>
            <span className="exp-bar-track">
              <span
                className={`exp-bar-fill ${isUnspecified ? "muted" : ""}`}
                style={{ width: `${widthPct}%` }}
              />
            </span>
            <span className="exp-value">{row.pct}%</span>
            <span className="exp-count">({row.posting_count})</span>
          </div>
        );
      })}
    </div>
  );
}