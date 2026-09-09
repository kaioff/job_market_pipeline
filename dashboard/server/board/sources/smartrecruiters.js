import { COMPANIES } from "./companies.js";

/**
 * SmartRecruiters public postings API.
 *
 * `releasedDate` is a full ISO timestamp, so this sits alongside
 * Greenhouse and Ashby in the top freshness tier.
 */

const API = "https://api.smartrecruiters.com/v1/companies";

function normalize(job, slug) {
  const published = job.releasedDate || null;
  return {
    posting_id: `sr:${slug}:${job.id}`,
    title: job.name,
    company: job.company?.name || slug,
    location: job.location?.fullLocation || job.location?.city || null,
    job_url: `https://jobs.smartrecruiters.com/${slug}/${job.id}`,
    posted_at: published ? published.slice(0, 10) : null,
    posted_at_precise: published ? new Date(published).toISOString() : null,
    applicants: null,
  };
}

export const smartrecruitersSource = {
  name: "smartrecruiters",

  async fetchRecent({ windowSeconds }) {
    const cutoff = Date.now() - windowSeconds * 1000;
    const out = [];

    for (const slug of COMPANIES.smartrecruiters) {
      try {
        const res = await fetch(`${API}/${slug}/postings`);
        if (!res.ok) {
          console.warn(`[board] smartrecruiters/${slug} -> HTTP ${res.status}, skipped`);
          continue;
        }
        const { content = [] } = await res.json();

        for (const job of content) {
          const p = normalize(job, slug);
          if (!p.posted_at_precise) continue;
          if (Date.parse(p.posted_at_precise) < cutoff) continue;
          out.push(p);
        }
      } catch (err) {
        console.warn(`[board] smartrecruiters/${slug} failed: ${err.message}`);
      }
    }

    return out;
  },

  async enrich(posting) {
    return posting;
  },

  get sliceCount() {
    return COMPANIES.smartrecruiters.length;
  },
};
