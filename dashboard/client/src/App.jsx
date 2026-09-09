import { useState, useEffect } from "react";
import SkillsPage from "./SkillsPage";
import JobBoard from "./JobBoard";
import "./App.scoped.css";

/**
 * Two pages over two very different data paths:
 *
 *   /#/skills — dbt gold in Databricks, batch, hour-cached. Slow-moving
 *               aggregates; a cold warehouse is acceptable here.
 *   /#/board  — the in-memory hot store over SSE. Never touches Databricks
 *               on the request path, so it stays fast and the warehouse
 *               stays asleep.
 *
 * Hash routing rather than react-router: two pages don't justify a
 * dependency, and this keeps the deploy a static bundle with no server
 * rewrite rules. Worth revisiting at the third page.
 */

const PAGES = [
  { id: "board", label: "Job board" },
  { id: "skills", label: "Skills" },
];

function currentPage() {
  const id = window.location.hash.replace(/^#\/?/, "");
  return PAGES.some((p) => p.id === id) ? id : "board";
}

export default function App() {
  const [page, setPage] = useState(currentPage);

  useEffect(() => {
    const onHash = () => setPage(currentPage());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  return (
    <div className="app">
      <nav className="page-nav" aria-label="Sections">
        {PAGES.map((p) => (
          <a
            key={p.id}
            href={`#/${p.id}`}
            className={`page-tab ${page === p.id ? "active" : ""}`}
            aria-current={page === p.id ? "page" : undefined}
          >
            {p.label}
          </a>
        ))}
      </nav>

      {page === "board" ? (
        <>
          <header className="hero hero--compact">
            <div className="hero-scanline" aria-hidden="true" />
            <div className="hero-content">
              <span className="eyebrow">SAN FRANCISCO · DATA ENGINEER · LIVE FEED</span>
              <h1>
                Fresh postings.
                <br />
                <span className="accent">Click straight through to apply.</span>
              </h1>
              <p className="hero-sub">
                Polled continuously and pushed here the moment they appear.
                Newest first, with the time we found it — not the day
                LinkedIn rounds it to.
              </p>
            </div>
          </header>
          <main className="content">
            <JobBoard />
          </main>
        </>
      ) : (
        <SkillsPage />
      )}

      <footer className="footer">
        {page === "board"
          ? "Live path: LinkedIn poll → dedupe → in-memory feed → this page. Durable copy lands in Delta."
          : "Batch path: LinkedIn scrape → Databricks medallion → dbt Gold → this dashboard."}
      </footer>
    </div>
  );
}
