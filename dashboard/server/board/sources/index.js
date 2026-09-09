import { greenhouseSource } from "./greenhouse.js";
import { ashbySource } from "./ashby.js";
import { leverSource } from "./lever.js";
import { smartrecruitersSource } from "./smartrecruiters.js";
import { workableSource } from "./workable.js";
import { linkedinSource } from "./linkedin.js";

/**
 * Multi-source aggregation.
 *
 * ATS boards first, LinkedIn last — and LinkedIn off by default. The point
 * of going upstream is that Greenhouse/Ashby/Lever publish the moment a
 * job goes live, with an exact timestamp, while LinkedIn ingests from them
 * and shows it later. Polling the source is how you're early; polling
 * LinkedIn is how you compete with everyone else watching LinkedIn.
 *
 * LinkedIn stays available (BOARD_LINKEDIN=true) for coverage of employers
 * who post nowhere else, at the cost of ToS exposure and ban risk the ATS
 * adapters don't carry.
 */

const ALL = [
  greenhouseSource,
  ashbySource,
  leverSource,
  smartrecruitersSource,
  workableSource,
  ...(process.env.BOARD_LINKEDIN === "true" ? [linkedinSource] : []),
];

const BY_NAME = Object.fromEntries(ALL.map((s) => [s.name, s]));

// Re-evaluated per poll: the resolver map grows as discovery runs, so a
// source with zero companies now may have some by the next tick.
const enabled = () => ALL.filter((s) => s.sliceCount > 0);

/**
 * Fetches every source concurrently. Sources are independent HTTP calls to
 * unrelated hosts, so there's nothing to gain from serializing them — and
 * one slow board shouldn't hold up the rest.
 */
export async function fetchAll({ windowSeconds }) {
  const sources = enabled();
  const results = await Promise.allSettled(
    sources.map((s) => s.fetchRecent({ windowSeconds }))
  );

  const out = [];
  const seen = new Set();

  results.forEach((r, i) => {
    const source = sources[i];
    if (r.status === "rejected") {
      console.warn(`[board] source ${source.name} failed: ${r.reason?.message}`);
      return;
    }
    for (const p of r.value) {
      // posting_id is namespaced per source, so this only guards against a
      // board listing the same role twice.
      if (seen.has(p.posting_id)) continue;
      seen.add(p.posting_id);
      out.push({ ...p, source: source.name });
    }
  });

  return out;
}

/** Dispatches enrichment to the source that produced the posting. */
export async function enrich(posting) {
  const source = BY_NAME[posting.source];
  return source?.enrich ? source.enrich(posting) : posting;
}

export const activeSources = () =>
  enabled().map((s) => `${s.name}(${s.sliceCount})`);
