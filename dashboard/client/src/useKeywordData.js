import { useState, useEffect } from "react";

const API_BASE = import.meta.env.VITE_API_BASE || "http://localhost:4000";

export function useKeywordData(grain = "daily") {
  const [latest, setLatest] = useState(null);
  const [trends, setTrends] = useState(null);
  const [experience, setExperience] = useState(null);
  const [status, setStatus] = useState("loading");
  const [trendStatus, setTrendStatus] = useState("loading");
  const [error, setError] = useState(null);

  // Latest data + experience distribution load once on mount.
  useEffect(() => {
    let cancelled = false;
    async function load() {
      setStatus("loading");
      try {
        const [latestRes, expRes] = await Promise.all([
          fetch(`${API_BASE}/api/keywords/latest?limit=40`),
          fetch(`${API_BASE}/api/experience`),
        ]);
        if (!latestRes.ok) throw new Error("The data source didn't respond. It may be waking up — retry in a moment.");
        const data = await latestRes.json();
        const expData = expRes.ok ? await expRes.json() : null;
        if (!cancelled) {
          setLatest(data);
          setExperience(expData);
          setStatus("ready");
        }
      } catch (err) {
        if (!cancelled) {
          setError(err.message);
          setStatus("error");
        }
      }
    }
    load();
    return () => { cancelled = true; };
  }, []);

  // Trends refetch whenever grain changes.
  useEffect(() => {
    let cancelled = false;
    async function loadTrends() {
      setTrendStatus("loading");
      try {
        const res = await fetch(`${API_BASE}/api/keywords/trends?top=12&grain=${grain}`);
        if (!res.ok) throw new Error("Failed to load trends.");
        const data = await res.json();
        if (!cancelled) {
          setTrends(data);
          setTrendStatus("ready");
        }
      } catch (err) {
        if (!cancelled) setTrendStatus("error");
      }
    }
    loadTrends();
    return () => { cancelled = true; };
  }, [grain]);

  return { latest, trends, experience, status, trendStatus, error };
}