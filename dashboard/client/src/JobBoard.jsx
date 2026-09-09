import { useState, useEffect } from "react";
import { useJobFeed } from "./useJobFeed";

/**
 * Relative age, e.g. "4m ago". The board's whole value is recency, so an
 * absolute timestamp would make the reader do the arithmetic.
 */
function timeAgo(iso, now) {
  const secs = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (secs < 60) return "just now";
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.round(hrs / 24)}d ago`;
}

/**
 * When the posting was published, not when we found it.
 *
 * These differ by a lot: LinkedIn's search index lags publication, so a
 * job can be 40 minutes old the first time it appears to us. Showing
 * retrieved_at made every posting read "just now", which was wrong in the
 * one dimension this page exists to get right.
 *
 * posted_at_precise comes from the detail page and is what we display.
 * posted_at is the search card's date-only fallback — better than nothing,
 * but it rounds to midnight, so it's used only when enrichment failed.
 */
function postedAt(p) {
  return p.posted_at_precise || p.posted_at || p.retrieved_at;
}

export default function JobBoard() {
  const { postings, status, connected, error } = useJobFeed();

  // Re-render on a timer so "4m ago" doesn't freeze at whatever it said on
  // mount. Cheap: the list is capped at a few hundred rows.
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30000);
    return () => clearInterval(t);
  }, []);

  return (
    <>
      <section className="panel">
        <div className="panel-header">
          <h2>Incoming postings</h2>
          <span className={`feed-status ${connected ? "live" : "offline"}`}>
            <span className="pulse-dot" />
            {connected ? "LIVE" : "RECONNECTING"}
          </span>
        </div>

        {status === "loading" && (
          <div className="status-panel">
            <div className="pulse-dot" />
            Loading the last 48 hours…
          </div>
        )}

        {status === "error" && (
          <div className="status-panel status-error">
            {error || "Couldn't reach the feed."}
          </div>
        )}

        {status === "ready" && postings.length === 0 && (
          <div className="status-panel">
            Nothing in the window yet. New postings appear here automatically.
          </div>
        )}

        {status === "ready" && postings.length > 0 && (
          <ol className="job-list">
            {/* Sorted by publication time, not arrival. A backfilled job
                posted 10 minutes ago belongs above one posted an hour ago,
                even if we happened to see the older one first. */}
            {[...postings]
              .sort((a, b) => Date.parse(postedAt(b)) - Date.parse(postedAt(a)))
              .map((p) => (
                <li
                  key={p.posting_id}
                  className={p.isNew ? "job-row is-new" : "job-row"}
                >
                {/* The whole row is the apply link — the point of the board
                    is one click from "this is new" to the application. */}
                <a
                  className="job-link"
                  href={p.job_url}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  <div className="job-main">
                    <span className="job-title">{p.title}</span>
                    <span className="job-meta">
                      {p.company}
                      {p.location ? ` · ${p.location}` : ""}
                      {p.applicants != null ? ` · ${p.applicants} applicants` : ""}
                    </span>
                  </div>
                  <time
                    className="job-age"
                    dateTime={postedAt(p)}
                    title={`Posted ${timeAgo(postedAt(p), now)} · first seen ${timeAgo(p.retrieved_at, now)}`}
                  >
                    {timeAgo(postedAt(p), now)}
                  </time>
                </a>
                </li>
              ))}
          </ol>
        )}
      </section>
    </>
  );
}
