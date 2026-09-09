import { loadRecent, pruneAll } from "./sinks/index.js";

/**
 * The hot store: in-process memory, not a database.
 *
 * Why memory rather than reading back from a database — the poller is the
 * only writer, so it already knows what's new and never needs to query to
 * find out. Keeping reads in-process means no page load and no SSE event
 * waits on I/O.
 *
 * Durability lives in sinks/ (SQLite primary, Delta best-effort), and boot
 * rehydration reads from the local SQLite file, so nothing here depends on
 * Databricks being awake.
 *
 * Cost of that choice: state dies with the process (hence seed()), and it
 * assumes a single server instance. Two instances would each hold their
 * own view and double-write. That's the point where this should become
 * Redis — not before.
 */

const WINDOW_HOURS = Number(process.env.BOARD_WINDOW_HOURS || 48);

/**
 * Hard cap on how old a posting may be to appear on the board.
 *
 * Deliberately separate from the fetch window and from WINDOW_HOURS.
 * The fetch window is generous on purpose — it's 3x the poll interval so a
 * slow or failed poll can't miss anything — but "how far back do I look"
 * and "how old may a posting be" are different questions. Conflating them
 * meant a wide window leaked stale jobs onto a board whose entire purpose
 * is applying early.
 */
const MAX_AGE_HOURS = Number(process.env.BOARD_MAX_AGE_HOURS || 24);
const MAX_BUFFER = Number(process.env.BOARD_MAX_BUFFER || 5000);

// posting_id -> true, for O(1) "have I seen this?" without a query.
const seenIds = new Set();

// Newest-first list of postings inside the rolling window. Sorted by
// retrieved_at (when *we* found it), not posted_at — LinkedIn's posted_at
// is coarse ("2 days ago" rounds hard) and the board is about arrival.
let buffer = [];

const subscribers = new Set();

function windowCutoff() {
  return Date.now() - WINDOW_HOURS * 3600 * 1000;
}

/**
 * When the posting was published, best available.
 *
 * posted_at is date-only, so it reads as midnight — which makes a job look
 * up to 24h older than it is. Only used when precise is missing.
 */
function postedAtMs(p) {
  const t = p.posted_at_precise || p.posted_at || p.retrieved_at;
  return Date.parse(t);
}

function tooOld(p) {
  const ms = postedAtMs(p);
  if (Number.isNaN(ms)) return false; // unknown age: keep rather than silently drop
  return ms < Date.now() - MAX_AGE_HOURS * 3600 * 1000;
}

function prune() {
  const cutoff = windowCutoff();
  // Two independent bounds: retrieval age keeps the buffer small, posting
  // age keeps the board fresh. A row leaves when it fails either.
  buffer = buffer.filter((p) => Date.parse(p.retrieved_at) >= cutoff && !tooOld(p));
  if (buffer.length > MAX_BUFFER) buffer = buffer.slice(0, MAX_BUFFER);
}

/**
 * Filters a fetched batch down to postings we've never seen, stamps them
 * with retrieval time, and adds them to the buffer.
 *
 * This is where "new" is defined, and it's the whole reason the store has
 * to exist: newness is a statement about history, so it needs memory.
 * Returns only the genuinely-new postings, for the caller to persist and
 * broadcast.
 */
export function hasSeen(postingId) {
  return seenIds.has(postingId);
}

export function admit(postings) {
  const retrievedAt = new Date().toISOString();
  const fresh = [];

  for (const p of postings) {
    if (seenIds.has(p.posting_id)) continue;
    // Mark it seen even when it's too old, so a stale posting isn't
    // re-evaluated (and re-enriched) on every single poll.
    seenIds.add(p.posting_id);
    if (tooOld(p)) continue;
    fresh.push({ ...p, retrieved_at: retrievedAt });
  }

  if (fresh.length) {
    buffer = [...fresh, ...buffer];
    prune();
  }

  return fresh;
}

/** Newest-first postings inside the window, for GET /api/board/recent. */
export function recent(limit = 200) {
  prune();
  return buffer.slice(0, limit);
}

export function stats() {
  return {
    buffered: buffer.length,
    seen_ids: seenIds.size,
    window_hours: WINDOW_HOURS,
    max_age_hours: MAX_AGE_HOURS,
    newest: buffer[0]?.retrieved_at || null,
  };
}

/* ---------- SSE fan-out ---------- */

export function subscribe(res) {
  subscribers.add(res);
  return () => subscribers.delete(res);
}

export function broadcast(event, payload) {
  const frame = `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const res of subscribers) {
    // A client that vanished mid-write shouldn't take down the loop.
    try {
      res.write(frame);
    } catch {
      subscribers.delete(res);
    }
  }
}

export function subscriberCount() {
  return subscribers.size;
}

/* ---------- Boot ---------- */

/**
 * Rehydrate from the local SQLite file at startup, and drop rows that have
 * aged out of the window.
 *
 * Reading from disk rather than Databricks is the whole point of the sink
 * split: boot is fast, offline, and unaffected by warehouse availability.
 * A failure is still non-fatal — an empty store just means the first poll
 * looks like a burst of new postings.
 */
export async function seed() {
  try {
    pruneAll(WINDOW_HOURS);

    buffer = loadRecent(WINDOW_HOURS, MAX_BUFFER);
    for (const r of buffer) seenIds.add(r.posting_id);

    buffer = buffer.filter((p) => !tooOld(p));
    console.log(
      `[board] seeded ${buffer.length} postings from sqlite ` +
        `(max age ${MAX_AGE_HOURS}h)`
    );
  } catch (err) {
    console.warn(
      `[board] seed failed (${err.message}) — starting cold. ` +
        `First poll will look like a burst of new postings.`
    );
  }
}
