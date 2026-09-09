import { COMPANIES } from "./companies.js";

/**
 * Greenhouse public job board API.
 *
 * The reason to prefer this over LinkedIn: `first_published` is an exact
 * ISO timestamp set at publication, and the endpoint reflects it
 * immediately — a live probe found a Stripe posting 0.0 hours old. LinkedIn
 * gives "3 hours ago" on a page it only indexes some time after the fact,
 * so this is both more precise and genuinely earlier.
 *
 * Public, documented, and meant to be consumed, so there's no rate-limit
 * or ToS exposure of the kind the LinkedIn adapter carries.
 */

const API = "https://boards-api.greenhouse.io/v1/boards";

function normalize(job, slug) {
  const published = job.first_published || job.updated_at;
  return {
    // Namespaced so IDs can't collide across ATSs or companies.
    posting_id: `gh:${slug}:${job.id}`,
    title: job.title,
    company: job.company_name || slug,
    location: job.location?.name || null,
    // Straight to the company's own application form — one hop fewer than
    // routing through LinkedIn.
    job_url: job.absolute_url,
    posted_at: published ? published.slice(0, 10) : null,
    posted_at_precise: published ? new Date(published).toISOString() : null,
    applicants: null,
  };
}

export const greenhouseSource = {
  name: "greenhouse",

  async fetchRecent({ windowSeconds }) {
    const cutoff = Date.now() - windowSeconds * 1000;
    const out = [];

    for (const slug of COMPANIES.greenhouse) {
      try {
        const res = await fetch(`${API}/${slug}/jobs`);
        if (!res.ok) {
          console.warn(`[board] greenhouse/${slug} -> HTTP ${res.status}, skipped`);
          continue;
        }
        const { jobs = [] } = await res.json();

        for (const job of jobs) {
          const p = normalize(job, slug);
          // The endpoint returns the entire board (hundreds of roles), so
          // the window filter is what makes this a feed rather than a dump.
          if (!p.posted_at_precise) continue;
          if (Date.parse(p.posted_at_precise) < cutoff) continue;
          out.push(p);
        }
      } catch (err) {
        console.warn(`[board] greenhouse/${slug} failed: ${err.message}`);
      }
    }

    return out;
  },

  // Timestamps arrive complete; nothing to enrich.
  async enrich(posting) {
    return posting;
  },

  get sliceCount() {
    return COMPANIES.greenhouse.length;
  },
};
