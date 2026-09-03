import { useEffect, useMemo, useRef, useState } from "react";

const API_BASE = import.meta.env.VITE_API_BASE || "http://localhost:4000";

const EXPERIENCE_ORDER = ["0-2", "3-5", "5-8", "8+", "not_specified"];

function StatTile({ label, value, suffix }) {
  return (
    <div className="skill-stat">
      <span className="skill-stat-value">
        {value ?? "—"}
        {value != null && suffix ? <span className="skill-stat-suffix">{suffix}</span> : null}
      </span>
      <span className="skill-stat-label">{label}</span>
    </div>
  );
}

function RankedList({ rows, valueKey = "pct_of_skill_postings", labelKey = "value" }) {
  if (!rows || rows.length === 0) {
    return <p className="skill-empty">No data for this breakdown.</p>;
  }
  const max = Math.max(...rows.map((r) => r[valueKey] ?? 0)) || 1;

  return (
    <ol className="signals-list">
      {rows.map((row, i) => (
        <li key={`${row[labelKey]}-${i}`} className="signals-row skill-row">
          <span className="signals-rank">{String(i + 1).padStart(2, "0")}</span>
          <span className="signals-keyword" title={row[labelKey]}>
            {row[labelKey]}
          </span>
          <span className="signals-bar-track">
            <span
              className="signals-bar-fill"
              style={{ width: `${Math.round(((row[valueKey] ?? 0) / max) * 100)}%` }}
            />
          </span>
          <span className="signals-count">{row[valueKey]}%</span>
        </li>
      ))}
    </ol>
  );
}

export default function SkillLookup() {
  const [query, setQuery] = useState("");
  const [skills, setSkills] = useState([]);
  const [overview, setOverview] = useState(null);
  const [status, setStatus] = useState("idle");
  const [error, setError] = useState(null);
  const requestRef = useRef(0);

  // Vocabulary for autocomplete — the same curated seed the matcher uses,
  // so anything suggested here is guaranteed to resolve.
  useEffect(() => {
    let cancelled = false;
    fetch(`${API_BASE}/api/skills`)
      .then((res) => (res.ok ? res.json() : []))
      .then((data) => {
        if (!cancelled) setSkills(Array.isArray(data) ? data : []);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  async function lookup(term) {
    const trimmed = String(term || "").trim();
    if (!trimmed) return;

    const requestId = ++requestRef.current;
    setStatus("loading");
    setError(null);

    try {
      const res = await fetch(
        `${API_BASE}/api/skills/${encodeURIComponent(trimmed)}/overview`
      );
      const data = await res.json();
      if (requestId !== requestRef.current) return; // superseded by a newer search

      if (!res.ok) {
        setOverview(null);
        setError(data.error || "Couldn't look that up.");
        setStatus("error");
        return;
      }
      setOverview(data);
      setStatus("ready");
    } catch {
      if (requestId !== requestRef.current) return;
      setOverview(null);
      setError("Failed to reach the API.");
      setStatus("error");
    }
  }

  const experienceRows = useMemo(() => {
    if (!overview?.experience_bands) return [];
    return [...overview.experience_bands].sort(
      (a, b) => EXPERIENCE_ORDER.indexOf(a.value) - EXPERIENCE_ORDER.indexOf(b.value)
    );
  }, [overview]);

  return (
    <section className="panel">
      <div className="panel-header">
        <h2>Ask about a skill</h2>
        <span className="panel-caption">
          Type a skill — how common it is, what it pairs with, who's hiring for it
        </span>
      </div>

      <form
        className="skill-search"
        onSubmit={(e) => {
          e.preventDefault();
          lookup(query);
        }}
      >
        <input
          className="skill-input"
          list="skill-options"
          value={query}
          placeholder="e.g. python, airflow, dbt, kubernetes…"
          onChange={(e) => setQuery(e.target.value)}
          aria-label="Skill to look up"
        />
        <datalist id="skill-options">
          {skills.map((s) => (
            <option key={s.skill} value={s.skill} />
          ))}
        </datalist>
        <button className="skill-submit" type="submit">
          Look up
        </button>
      </form>

      {skills.length > 0 && status === "idle" && (
        <div className="skill-suggestions">
          {skills.slice(0, 8).map((s) => (
            <button
              key={s.skill}
              type="button"
              className="skill-chip"
              onClick={() => {
                setQuery(s.skill);
                lookup(s.skill);
              }}
            >
              {s.skill}
            </button>
          ))}
        </div>
      )}

      {status === "loading" && (
        <div className="status-panel">
          <div className="pulse-dot" />
          Querying…
        </div>
      )}

      {status === "error" && <div className="status-panel status-error">{error}</div>}

      {status === "ready" && overview && (
        <div className="skill-overview">
          <div className="skill-title-row">
            <h3 className="skill-name">{overview.skill}</h3>
            {overview.category && (
              <span className="skill-category">{overview.category.replace(/_/g, " ")}</span>
            )}
          </div>

          <div className="skill-stats">
            <StatTile label="postings mentioning it" value={overview.posting_count} />
            <StatTile label="of all postings" value={overview.pct} suffix="%" />
            <StatTile label="median years asked" value={overview.median_years_min} />
            <StatTile label="avg years asked" value={overview.avg_years_min} />
          </div>

          <div className="skill-grid">
            <div className="skill-block">
              <h4>Appears alongside</h4>
              <RankedList
                rows={overview.related_skills?.slice(0, 10)}
                labelKey="related_keyword"
              />
            </div>

            <div className="skill-block">
              <h4>Experience asked for</h4>
              <RankedList rows={experienceRows} />
            </div>

            <div className="skill-block">
              <h4>Top titles</h4>
              <RankedList rows={overview.top_titles} />
            </div>

            <div className="skill-block">
              <h4>Top companies</h4>
              <RankedList rows={overview.top_companies} />
            </div>

            <div className="skill-block">
              <h4>Top locations</h4>
              <RankedList rows={overview.top_locations} />
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
