import { useState } from "react";
import { useKeywordData } from "./useKeywordData";
import BubbleChart from "./BubbleChart";
import SmallMultiples from "./SmallMultiples";
import TopSignals from "./TopSignals";
import ExperienceBars from "./ExperienceBars";
import "./App.scoped.css";

const GRAINS = ["daily", "weekly", "monthly"];

export default function App() {
  const [grain, setGrain] = useState("daily");
  const { latest, trends, experience, status, trendStatus, error } = useKeywordData(grain);

  const latestSnapshotDate = latest?.[0]?.snapshot_date
    ? String(latest[0].snapshot_date).slice(0, 10)
    : null;
  const signalsTracked = latest ? new Set(latest.map((r) => r.keyword)).size : null;

  return (
    <div className="app">
      <header className="hero">
        <div className="hero-scanline" aria-hidden="true" />
        <div className="hero-content">
          <span className="eyebrow">SAN FRANCISCO · DATA ENGINEER · LIVE SCAN</span>
          <h1>
            Signal, not noise.
            <br />
            <span className="accent">What the market is actually asking for.</span>
          </h1>
          <p className="hero-sub">
            Every listing scraped, parsed, and cross-referenced daily. This is the
            frequency of every skill mentioned across active postings — ranked,
            tracked, and stripped of the boilerplate.
          </p>
          {latestSnapshotDate && (
            <div className="hero-meta">
              <span>LAST SCAN: {latestSnapshotDate}</span>
              {signalsTracked && <span>{signalsTracked} SIGNALS TRACKED</span>}
            </div>
          )}
        </div>
      </header>

      <main className="content">
        {status === "loading" && (
          <div className="status-panel">
            <div className="pulse-dot" />
            Scanning warehouse — this can take up to a minute if it's cold.
          </div>
        )}

        {status === "error" && (
          <div className="status-panel status-error">
            {error || "Something went wrong reaching the data source."}
          </div>
        )}

        {status === "ready" && (
          <>
            <section className="panel">
              <div className="panel-header">
                <h2>Skill landscape</h2>
                <span className="panel-caption">Bubble size = share of postings mentioning the term</span>
              </div>
              <BubbleChart rows={latest} />
            </section>

            <section className="panel">
              <div className="panel-header">
                <h2>Top signals</h2>
                <span className="panel-caption">Ranked by share of active postings</span>
              </div>
              <TopSignals rows={latest} />
            </section>

            <section className="panel">
              <div className="panel-header">
                <h2>Experience required</h2>
                <span className="panel-caption">Minimum years mentioned, across all active postings</span>
              </div>
              <ExperienceBars rows={experience} />
            </section>

            <section className="panel">
              <div className="panel-header">
                <h2>Signal over time</h2>
                <div className="grain-toggle" role="tablist" aria-label="Time grain">
                  {GRAINS.map((g) => (
                    <button
                      key={g}
                      role="tab"
                      aria-selected={grain === g}
                      className={`grain-btn ${grain === g ? "active" : ""}`}
                      onClick={() => setGrain(g)}
                    >
                      {g}
                    </button>
                  ))}
                </div>
              </div>
              {trendStatus === "loading" ? (
                <div className="status-panel">
                  <div className="pulse-dot" />
                  Loading {grain} view…
                </div>
              ) : (
                <SmallMultiples rows={trends} grain={grain} />
              )}
            </section>
          </>
        )}
      </main>

      <footer className="footer">
        Pipeline: LinkedIn scrape → Databricks medallion → dbt Gold → this dashboard.
      </footer>
    </div>
  );
}