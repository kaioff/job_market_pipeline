import { COMPANIES } from "./companies.js";

/**
 * Ashby public job board API. Same bargain as Greenhouse: exact
 * `publishedAt`, a direct `applyUrl`, no auth, no ban risk.
 */

const API = "https://api.ashbyhq.com/posting-api/job-board";

function normalize(job, slug) {
  return {
    posting_id: `ashby:${slug}:${job.id}`,
    title: job.title,
    company: slug,
    location: job.location || null,
    // applyUrl lands on the form itself; jobUrl is the description page.
    job_url: job.applyUrl || job.jobUrl,
    posted_at: job.publishedAt ? job.publishedAt.slice(0, 10) : null,
    posted_at_precise: job.publishedAt
      ? new Date(job.publishedAt).toISOString()
      : null,
    applicants: null,
  };
}

export const ashbySource = {
  name: "ashby",

  async fetchRecent({ windowSeconds }) {
    const cutoff = Date.now() - windowSeconds * 1000;
    const out = [];

    for (const slug of COMPANIES.ashby) {
      try {
        const res = await fetch(`${API}/${slug}`);
        if (!res.ok) {
          console.warn(`[board] ashby/${slug} -> HTTP ${res.status}, skipped`);
          continue;
        }
        const { jobs = [] } = await res.json();

        for (const job of jobs) {
          // isListed false means pulled from the public board.
          if (job.isListed === false) continue;
          const p = normalize(job, slug);
          if (!p.posted_at_precise) continue;
          if (Date.parse(p.posted_at_precise) < cutoff) continue;
          out.push(p);
        }
      } catch (err) {
        console.warn(`[board] ashby/${slug} failed: ${err.message}`);
      }
    }

    return out;
  },

  async enrich(posting) {
    return posting;
  },

  get sliceCount() {
    return COMPANIES.ashby.length;
  },
};
