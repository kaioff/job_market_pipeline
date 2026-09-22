import { useState, useEffect, useRef } from "react";

const API_BASE = import.meta.env.VITE_API_BASE || "http://localhost:4000";

/**
 * Live posting feed: a backfill fetch followed by an open SSE stream.
 *
 * Both halves are needed. The stream alone would leave the board empty on
 * load — the live window often contains zero postings — and the fetch
 * alone would go stale the moment it landed.
 */
export function useJobFeed() {
  const [postings, setPostings] = useState(null);
  const [status, setStatus] = useState("loading");
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState(null);

  // IDs already on screen. A posting can arrive twice — once in the
  // backfill, once on the stream — if the poller fires mid-load.
  const seen = useRef(new Set());

  useEffect(() => {
    let cancelled = false;
    let source;

    async function start() {
      try {
        const res = await fetch(`${API_BASE}/api/board/recent?limit=200`);
        if (!res.ok) throw new Error(`API returned ${res.status}`);
        const rows = await res.json();
        if (cancelled) return;

        for (const p of rows) seen.current.add(p.posting_id);
        setPostings(rows);
        setStatus("ready");
      } catch (err) {
        if (cancelled) return;
        setError(err.message);
        setStatus("error");
        return;
      }

      // EventSource reconnects on its own after a drop, so there's no
      // retry logic here on purpose — it would fight the built-in backoff.
      source = new EventSource(`${API_BASE}/api/board/stream`);

      source.onopen = () => !cancelled && setConnected(true);
      source.onerror = () => !cancelled && setConnected(false);

      source.addEventListener("postings", (evt) => {
        if (cancelled) return;
        const incoming = JSON.parse(evt.data).filter(
          (p) => !seen.current.has(p.posting_id)
        );
        if (!incoming.length) return;

        for (const p of incoming) seen.current.add(p.posting_id);
        // Newest first, and flagged so the UI can animate arrivals.
        setPostings((prev) => [
          ...incoming.map((p) => ({ ...p, isNew: true })),
          ...(prev || []),
        ]);
      });
    }

    start();

    return () => {
      cancelled = true;
      source?.close();
    };
  }, []);

  return { postings, status, connected, error };
}
