import { sqliteSink } from "./sqliteSink.js";
import { deltaSink } from "./deltaSink.js";

/**
 * Fan-out to durable sinks, in priority order.
 *
 * The distinction that matters is `primary`. A primary sink failing is a
 * real problem and propagates; a secondary one failing is logged and
 * ignored, so a dead SQL Warehouse can never take down the feed.
 */

const DELTA_ENABLED = process.env.BOARD_DELTA_SINK !== "false";

const SINKS = [sqliteSink, ...(DELTA_ENABLED ? [deltaSink] : [])];

export async function persistAll(postings) {
  if (!postings.length) return;

  for (const sink of SINKS) {
    try {
      await sink.persist(postings);
    } catch (err) {
      if (sink.primary) throw err;
      console.warn(
        `[board] secondary sink "${sink.name}" failed: ${err.message} — ` +
          `postings are still durable in ${sqliteSink.name}`
      );
    }
  }
}

/** Boot rehydration, always from the primary. Local file, no cold start. */
export function loadRecent(windowHours, limit) {
  return sqliteSink.recent(windowHours, limit);
}

export function pruneAll(windowHours) {
  sqliteSink.prune(windowHours);
}
