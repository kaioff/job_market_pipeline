/**
 * Title allowlist.
 *
 * LinkedIn's keyword search matches description text, not just the title,
 * so "data engineer" pulls back things like "Staff+ Software Engineer,
 * Databases" — the phrase appears somewhere in the body. Nothing in the
 * query params fixes this; the filtering has to happen on our side.
 *
 * An allowlist rather than a blocklist, for the same reason
 * silver_posting_keywords.sql uses a curated seed: blocklisting adjacent
 * roles is endless whack-a-mole, and every new batch invents a new title.
 */

const DEFAULT_TITLES = ["data engineer", "analytics engineer"];

const TITLES = (process.env.BOARD_TITLE_MATCH || DEFAULT_TITLES.join(","))
  .split(",")
  .map((t) => t.trim().toLowerCase())
  .filter(Boolean);

/**
 * Word-boundary matching so "data engineer" catches "Senior Data Engineer
 * II" and "Data & Analytics Engineer", but a title merely *mentioning*
 * data elsewhere doesn't slip through on a substring.
 */
const PATTERNS = TITLES.map(
  (t) => new RegExp(`\\b${t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i")
);

export function titleMatches(title) {
  if (!title) return false;
  return PATTERNS.some((re) => re.test(title));
}

export function filterByTitle(postings) {
  return postings.filter((p) => titleMatches(p.title));
}

export const activeTitles = TITLES;
