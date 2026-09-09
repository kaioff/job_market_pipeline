import { COMPANIES } from "./companies.js";

/**
 * Workable public widget API.
 *
 * The one weak spot in the ATS set: `published_on` is date-only, so a job
 * posted this morning is indistinguishable from one posted at midnight.
 * We deliberately leave posted_at_precise null rather than fabricating a
 * time — the board falls back to the date, and the age filter treats it as
 * midnight, which errs toward showing a job slightly too long rather than
 * hiding a fresh one.
 */

const API = "https://apply.workable.com/api/v1/widget/accounts";

function normalize(job, slug) {
  const published = job.published_on || job.created_at || null;
  return {
    posting_id: `wk:${slug}:${job.shortcode}`,
    title: job.title,
    company: slug,
    location:
      [job.city, job.state, job.country].filter(Boolean).join(", ") || null,
    job_url: job.application_url || job.shortlink || job.url,
    posted_at: published || null,
    posted_at_precise: null,
    applicants: null,
  };
}

export const workableSource = {
  name: "workable",

  async fetchRecent({ windowSeconds }) {
    // Date-only timestamps, so compare on whole days and round up: better
    // to admit a borderline posting than to silently drop a fresh one.
    const cutoffDay = new Date(Date.now() - windowSeconds * 1000)
      .toISOString()
      .slice(0, 10);
    const out = [];

    for (const slug of COMPANIES.workable) {
      try {
        const res = await fetch(`${API}/${slug}?details=true`);
        if (!res.ok) {
          console.warn(`[board] workable/${slug} -> HTTP ${res.status}, skipped`);
          continue;
        }
        const { jobs = [] } = await res.json();

        for (const job of jobs) {
          const p = normalize(job, slug);
          if (!p.posted_at) continue;
          if (p.posted_at < cutoffDay) continue;
          out.push(p);
        }
      } catch (err) {
        console.warn(`[board] workable/${slug} failed: ${err.message}`);
      }
    }

    return out;
  },

  async enrich(posting) {
    return posting;
  },

  get sliceCount() {
    return COMPANIES.workable.length;
  },
};
