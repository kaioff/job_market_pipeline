import { COMPANIES } from "./companies.js";

/**
 * Lever public postings API.
 *
 * `createdAt` is epoch milliseconds rather than ISO — the only shape
 * difference worth noting across the three ATSs.
 */

const API = "https://api.lever.co/v0/postings";

function normalize(job, slug) {
  const published = job.createdAt ? new Date(job.createdAt).toISOString() : null;
  return {
    posting_id: `lever:${slug}:${job.id}`,
    title: job.text,
    company: slug,
    location: job.categories?.location || null,
    job_url: job.applyUrl || job.hostedUrl,
    posted_at: published ? published.slice(0, 10) : null,
    posted_at_precise: published,
    applicants: null,
  };
}

export const leverSource = {
  name: "lever",

  async fetchRecent({ windowSeconds }) {
    const cutoff = Date.now() - windowSeconds * 1000;
    const out = [];

    for (const slug of COMPANIES.lever) {
      try {
        const res = await fetch(`${API}/${slug}?mode=json`);
        if (!res.ok) {
          console.warn(`[board] lever/${slug} -> HTTP ${res.status}, skipped`);
          continue;
        }
        const jobs = await res.json();

        for (const job of Array.isArray(jobs) ? jobs : []) {
          const p = normalize(job, slug);
          if (!p.posted_at_precise) continue;
          if (Date.parse(p.posted_at_precise) < cutoff) continue;
          out.push(p);
        }
      } catch (err) {
        console.warn(`[board] lever/${slug} failed: ${err.message}`);
      }
    }

    return out;
  },

  async enrich(posting) {
    return posting;
  },

  get sliceCount() {
    return COMPANIES.lever.length;
  },
};
