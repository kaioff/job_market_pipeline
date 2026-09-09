import { fetchAll, enrich, activeSources } from "./sources/index.js";
import { admit, broadcast, hasSeen, seed, stats } from "./store.js";
import { persistAll } from "./sinks/index.js";
import { filterByTitle, activeTitles } from "./filter.js";

/**
 * The loop that makes the board live.
 *
 * Deliberately a plain setTimeout in the API process, not a streaming
 * cluster or a scheduled job: at one or two slices this is ~12 requests an
 * hour, and the whole point of the design is that nothing has to run 24/7
 * beyond the server that was already running.
 */

const INTERVAL_MS = Number(process.env.BOARD_POLL_SECONDS || 300) * 1000;

/**
 * How far back each poll looks.
 *
 * At least 3x the poll interval, so a slow or failed poll can't punch a
 * hole in coverage — but never less than the board's display age, or a
 * fresh start could never fill: the store would happily show 24h of
 * postings while the fetch only ever asked for the last 15 minutes.
 *
 * Widening this is close to free. The ATS endpoints return an entire board
 * on every request no matter what, so the window is a client-side filter
 * over a response we already paid for; only LinkedIn's f_TPR changes the
 * request at all, and it's still one call. Re-seeing a posting costs
 * nothing either — the store drops it on posting_id.
 */
const MAX_AGE_SECONDS = Number(process.env.BOARD_MAX_AGE_HOURS || 24) * 3600;
const WINDOW_SECONDS = Math.max(
  Math.round((INTERVAL_MS / 1000) * 3),
  MAX_AGE_SECONDS
);

// A block from LinkedIn is silent: you keep getting HTTP 200 with an empty
// result set, which is indistinguishable from a quiet market. Without this
// alarm a dead feed looks exactly like a slow hiring week, for days.
const EMPTY_ALARM_THRESHOLD = Number(process.env.BOARD_EMPTY_ALARM || 12);

const state = {
  running: false,
  lastPollAt: null,
  lastError: null,
  consecutiveEmpty: 0,
  pollCount: 0,
  consecutiveFailures: 0,
  suspectBlocked: false,
  totalAdmitted: 0,
};

function backoffMs() {
  // Exponential, capped at 30min. Applied on transport errors and 429s.
  return Math.min(INTERVAL_MS * 2 ** state.consecutiveFailures, 30 * 60 * 1000);
}

async function pollOnce() {
  const all = await fetchAll({ windowSeconds: WINDOW_SECONDS });

  // Keyword search matches description text, so most of what comes back
  // isn't the role. Filter before anything else — it's what keeps the
  // enrichment request count (and the ban risk) low.
  const found = filterByTitle(all);

  // Enrich only postings we haven't seen, so any extra request happens
  // once per posting rather than once per poll. ATS sources are already
  // complete and no-op here; only LinkedIn actually fetches.
  const candidates = found.filter((p) => !hasSeen(p.posting_id));
  const enriched = [];
  for (const p of candidates) {
    enriched.push(await enrich(p));
    if (p.source === "linkedin-guest" && candidates.length > 1) {
      await new Promise((r) => setTimeout(r, 800));
    }
  }

  const fresh = admit(enriched);

  state.lastPollAt = new Date().toISOString();
  state.consecutiveFailures = 0;
  state.lastError = null;

  if (all.length === 0) {
    state.consecutiveEmpty += 1;
    if (state.consecutiveEmpty >= EMPTY_ALARM_THRESHOLD && !state.suspectBlocked) {
      state.suspectBlocked = true;
      console.error(
        `[board] ${state.consecutiveEmpty} consecutive empty polls — ` +
          `likely rate-limited or blocked, NOT a quiet market. ` +
          `Check egress IP; datacenter ranges get blocked fastest.`
      );
    }
  } else {
    state.consecutiveEmpty = 0;
    state.suspectBlocked = false;
  }

  if (!fresh.length) return;

  state.totalAdmitted += fresh.length;

  // The first poll after boot backfills everything already inside the
  // window, so it is not a burst of new jobs — it's the board catching up.
  // Flagged so notifications can stay quiet for it; without this you'd get
  // pinged about 24h of postings every time the process restarts.
  const isBackfill = state.pollCount === 0;
  state.pollCount += 1;

  broadcast("postings", fresh.map((p) => ({ ...p, backfill: isBackfill })));

  try {
    await persistAll(fresh);
  } catch (err) {
    // Only a primary-sink failure reaches here; secondary sinks log and
    // continue inside persistAll. Still non-fatal: the postings are live
    // in memory and on screen, and losing durability for one batch beats
    // crashing the feed.
    console.error(`[board] persist failed: ${err.message}`);
  }

  console.log(
    `[board] ${isBackfill ? "backfill " : "+"}${fresh.length} new ` +
      `(${found.length} matched title of ${all.length} in window)`
  );
}

async function tick() {
  let delay = INTERVAL_MS;

  try {
    await pollOnce();
  } catch (err) {
    state.consecutiveFailures += 1;
    state.lastError = err.message;
    delay = backoffMs();
    console.error(
      `[board] poll failed (${err.message}) — retrying in ${Math.round(delay / 1000)}s`
    );
  }

  setTimeout(tick, delay).unref?.();
}

export async function startPoller() {
  if (state.running) return;
  state.running = true;

  await seed();

  console.log(
    `[board] polling ${activeSources().join(", ")} ` +
      `every ${INTERVAL_MS / 1000}s over a ${WINDOW_SECONDS}s window`
  );
  console.log(`[board] title filter: ${activeTitles.join(" | ")}`);

  tick();
}

export function pollerStatus() {
  return { sources: activeSources(), ...state, ...stats() };
}
