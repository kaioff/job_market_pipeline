import "dotenv/config";
import { resolve, resolverStats, resolvedBoards } from "../board/sources/resolver.js";

/**
 * Discovery pass: company names in, ATS boards out.
 *
 * This is the bootstrap for the self-building watch list. LinkedIn knows
 * which employers are hiring; this maps as many of them as possible onto a
 * board we can poll in seconds instead of hours. Whatever doesn't resolve
 * keeps arriving through LinkedIn, so a miss costs latency, not coverage.
 *
 *   node scripts/discover.js --bronze          # from the warehouse backlog
 *   node scripts/discover.js --linkedin        # from a live search
 *   node scripts/discover.js --names "Brex,Figma"
 *   node scripts/discover.js --bronze --limit 100
 *
 * Safe to re-run: results are cached, and misses aren't re-probed for
 * BOARD_MISS_TTL_DAYS.
 */

const CATALOG = process.env.DATABRICKS_CATALOG || "job_market";

async function fromBronze() {
  const { runQuery } = await import("../databricksClient.js");
  const rows = await runQuery(
    `SELECT DISTINCT company
     FROM ${CATALOG}.silver.silver_linkedin_postings
     WHERE company IS NOT NULL AND trim(company) <> ''`
  );
  return rows.map((r) => r.company);
}

async function fromLinkedIn() {
  const cheerio = await import("cheerio");
  const keywords = process.env.BOARD_DISCOVERY_KEYWORDS || "data engineer";
  const location = process.env.BOARD_DISCOVERY_LOCATION || "San Francisco Bay Area";
  const names = new Set();

  // Three pages is plenty for discovery — we want the breadth of employers,
  // not every posting. This runs rarely, so the request volume stays low.
  for (const start of [0, 25, 50]) {
    const url =
      `https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search` +
      `?keywords=${encodeURIComponent(keywords)}&location=${encodeURIComponent(location)}` +
      `&f_TPR=r604800&start=${start}`;
    const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
    if (!res.ok) break;
    const $ = cheerio.load(await res.text());
    $("h4.base-search-card__subtitle").each((_, el) => {
      const t = $(el).text().replace(/\s+/g, " ").trim();
      if (t) names.add(t);
    });
  }
  return [...names];
}

async function main() {
  const args = process.argv.slice(2);
  let names = [];

  if (args.includes("--bronze")) names = await fromBronze();
  else if (args.includes("--linkedin")) names = await fromLinkedIn();
  else {
    const i = args.indexOf("--names");
    if (i === -1) {
      console.error("usage: discover.js --bronze | --linkedin | --names 'A,B'");
      process.exit(1);
    }
    names = args[i + 1].split(",").map((s) => s.trim()).filter(Boolean);
  }

  // Resolution is a few seconds per company (misses are slowest, since
  // they exhaust every strategy), so a full backlog run is an hours-long
  // background job. --limit makes it resumable: cached names are skipped
  // instantly on the next pass.
  const li = args.indexOf("--limit");
  if (li !== -1) names = names.slice(0, Number(args[li + 1]));

  console.log(`resolving ${names.length} companies…\n`);

  for (const name of names) {
    const r = await resolve(name);
    console.log(`  ${r ? "✅" : "❌"} ${name.slice(0, 34).padEnd(35)}` +
                `${r ? `${r.ats}/${r.slug}` : ""}`);
  }

  const s = resolverStats();
  console.log(
    `\nresolved ${s.resolved}/${s.total} ` +
      `(${Math.round((s.resolved / s.total) * 100)}%), ${s.misses} on LinkedIn fallback`
  );

  const boards = resolvedBoards();
  for (const [ats, slugs] of Object.entries(boards)) {
    console.log(`  ${ats.padEnd(16)} ${slugs.length} boards`);
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
