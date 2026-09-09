import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

/**
 * Company name -> ATS board, resolved once and cached forever.
 *
 * This is what makes the watch list self-building. LinkedIn is good at
 * breadth ("who is hiring?") and bad at speed; the ATS boards are the
 * reverse. Resolving names to boards lets each do what it's good at, so
 * the company list derives itself from search results instead of being
 * curated by hand.
 *
 * Misses are cached too. A company on Workday or an in-house system will
 * never resolve, and re-probing it on every run would be pure waste — it
 * simply stays on the LinkedIn path, which is where it would have been
 * anyway.
 */

const MAP_PATH = process.env.BOARD_ATS_MAP || "./data/ats-map.json";

// Re-check misses occasionally: companies do migrate onto a supported ATS.
const MISS_TTL_DAYS = Number(process.env.BOARD_MISS_TTL_DAYS || 30);

const PROVIDERS = [
  {
    ats: "greenhouse",
    url: (s) => `https://boards-api.greenhouse.io/v1/boards/${s}/jobs`,
    jobs: (j) => (Array.isArray(j.jobs) ? j.jobs : []),
    // Greenhouse echoes the employer name, which is what lets us verify a
    // resolution rather than trusting a guessed slug.
    company: (j) => j.jobs?.[0]?.company_name || null,
    host: "greenhouse.io",
  },
  {
    ats: "ashby",
    url: (s) => `https://api.ashbyhq.com/posting-api/job-board/${s}`,
    jobs: (j) => (Array.isArray(j.jobs) ? j.jobs : []),
    company: () => null,
    host: "ashbyhq.com",
  },
  {
    ats: "lever",
    url: (s) => `https://api.lever.co/v0/postings/${s}?mode=json`,
    jobs: (j) => (Array.isArray(j) ? j : []),
    company: () => null,
    host: "lever.co",
  },
  {
    ats: "smartrecruiters",
    url: (s) => `https://api.smartrecruiters.com/v1/companies/${s}/postings`,
    jobs: (j) => (Array.isArray(j.content) ? j.content : []),
    company: () => null,
    host: "smartrecruiters.com",
  },
  {
    ats: "workable",
    url: (s) => `https://apply.workable.com/api/v1/widget/accounts/${s}?details=true`,
    jobs: (j) => (Array.isArray(j.jobs) ? j.jobs : []),
    company: (j) => j.name || null,
    host: "workable.com",
  },
];

const BY_ATS = Object.fromEntries(PROVIDERS.map((p) => [p.ats, p]));

/* ---------- cache ---------- */

let cache = null;

function load() {
  if (cache) return cache;
  try {
    cache = JSON.parse(readFileSync(MAP_PATH, "utf8"));
  } catch {
    cache = {};
  }
  return cache;
}

function save() {
  mkdirSync(dirname(MAP_PATH), { recursive: true });
  writeFileSync(MAP_PATH, JSON.stringify(cache, null, 2));
}

const key = (name) => name.trim().toLowerCase();

/* ---------- matching helpers ---------- */

const squash = (s) => (s || "").toLowerCase().replace(/[^a-z0-9]/g, "");

/**
 * Loose company-name check.
 *
 * Needed because domain lookup is ambiguous — "Sigma" resolves to
 * sigmaaldrich.com, a chemical supplier, and without this guard we'd
 * happily poll their board and surface unrelated jobs under Sigma's name.
 * Substring either direction tolerates "Scale AI" vs "Scale".
 */
function namesAgree(a, b) {
  const x = squash(a);
  const y = squash(b);
  if (!x || !y) return true; // provider gave us nothing to check against
  return x.includes(y) || y.includes(x);
}

function slugCandidates(name) {
  const base = name.toLowerCase().trim();
  const stripped = base.replace(
    /\b(inc|llc|ltd|corp|corporation|labs?|technologies|technology|software|the)\b/g,
    ""
  );
  return [
    ...new Set(
      [base, stripped].flatMap((n) => [
        n.replace(/[^a-z0-9]/g, ""),
        n.replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, ""),
      ])
    ),
  ].filter(Boolean);
}

/* ---------- strategies ---------- */

// Path segments that appear after an ATS hostname but are never a slug.
const NOT_SLUGS = new Set([
  "jobs", "job", "embed", "job_board", "boards", "js", "v1", "api", "board",
  "search", "widget", "accounts", "companies", "postings", "app", "www",
]);

/**
 * Every plausible slug for one provider on a careers page, best-first.
 *
 * Includes the embed form (js.greenhouse.io/...?for=<slug>) because many
 * careers pages mount the board as a widget and never link the board URL
 * directly.
 */
function extractSlugs(html, provider) {
  const host = provider.host.replace(".", "\\.");
  const found = [];

  const forParam = html.match(new RegExp(`${host}[^"'<>]*?[?&]for=([a-z0-9_-]{2,})`, "gi")) || [];
  for (const m of forParam) found.push(m.split(/[?&]for=/i)[1]);

  const paths = html.match(new RegExp(`${host}/(?:[a-z_-]+/)*([a-z0-9_-]{2,})`, "gi")) || [];
  for (const m of paths) {
    for (const seg of m.split("/").slice(1)) {
      if (seg && !NOT_SLUGS.has(seg.toLowerCase())) found.push(seg);
    }
  }

  return [...new Set(found.map((s) => s.toLowerCase()))]
    .filter((s) => !NOT_SLUGS.has(s))
    .slice(0, 5);
}

async function tryBoard(ats, slug, expectedName) {
  const p = BY_ATS[ats];
  try {
    const res = await fetch(p.url(slug), { signal: AbortSignal.timeout(10000) });
    if (!res.ok) return null;
    const body = await res.json();
    const jobs = p.jobs(body);
    if (!jobs.length) return null;
    if (expectedName && !namesAgree(p.company(body), expectedName)) return null;
    return { ats, slug, jobs: jobs.length };
  } catch {
    return null;
  }
}

/** Strategy 1: guess the slug from the name. Cheap, and hits ~80%. */
async function byNameProbe(name) {
  for (const slug of slugCandidates(name)) {
    for (const p of PROVIDERS) {
      const hit = await tryBoard(p.ats, slug, name);
      if (hit) return { ...hit, method: "name-probe" };
    }
  }
  return null;
}

/**
 * Strategy 2: read the ATS link straight off the company's careers page.
 *
 * Slower, but exact — it's how "Sigma" resolves to greenhouse/sigmacomputing,
 * which no amount of name-guessing would find.
 */
async function byCareersPage(name) {
  let candidates = [];
  try {
    const res = await fetch(
      `https://autocomplete.clearbit.com/v1/companies/suggest?query=${encodeURIComponent(name)}`,
      { signal: AbortSignal.timeout(8000) }
    );
    // Not just the top hit: name lookup is ambiguous, and the company we
    // want is often not first. "Sigma" returns Sigma-Aldrich (a chemical
    // supplier) ahead of Sigma Computing. Checking a few and verifying the
    // board's employer name is what disambiguates them.
    candidates = ((await res.json()) || []).slice(0, 3).map((c) => c.domain);
  } catch {
    return null;
  }

  for (const domain of candidates.filter(Boolean)) {
    const hit = await scanCareersPages(domain, name);
    if (hit) return hit;
  }
  return null;
}

async function scanCareersPages(domain, name) {
  for (const path of ["/careers", "/jobs"]) {
    try {
      const res = await fetch(`https://${domain}${path}`, {
        redirect: "follow",
        headers: { "User-Agent": "Mozilla/5.0" },
        signal: AbortSignal.timeout(12000),
      });
      if (!res.ok) continue;
      const html = await res.text();

      for (const p of PROVIDERS) {
        for (const slug of extractSlugs(html, p)) {
          // Validate against the live API rather than trusting the scrape.
          // A careers page links to plenty of URLs on an ATS host that
          // aren't the board — /jobs, /embed, /job_board — so the only
          // reliable test is whether the slug actually serves postings
          // under a matching employer name.
          const hit = await tryBoard(p.ats, slug, name);
          if (hit) return { ...hit, method: `careers-page:${domain}` };
        }
      }
    } catch {
      /* try the next path */
    }
  }
  return null;
}

/* ---------- public ---------- */

export async function resolve(name) {
  const map = load();
  const k = key(name);
  const cached = map[k];

  if (cached && !cached.miss) return cached;
  if (cached?.miss) {
    const age = (Date.now() - Date.parse(cached.checkedAt)) / 86400000;
    if (age < MISS_TTL_DAYS) return null;
  }

  // Name-probe first: it's a handful of cheap API calls and no third party.
  // The careers-page route costs a lookup plus a page fetch, so it's the
  // fallback rather than the default.
  const hit = (await byNameProbe(name)) || (await byCareersPage(name));

  if (hit) {
    map[k] = { name, ats: hit.ats, slug: hit.slug, method: hit.method,
               resolvedAt: new Date().toISOString() };
  } else {
    map[k] = { name, miss: true, checkedAt: new Date().toISOString() };
  }
  save();

  return hit ? map[k] : null;
}

/** Every resolved board, grouped by ATS — this is what the poller reads. */
export function resolvedBoards() {
  const map = load();
  const out = {};
  for (const v of Object.values(map)) {
    if (v.miss) continue;
    (out[v.ats] ||= []).push(v.slug);
  }
  return out;
}

export function resolverStats() {
  const vals = Object.values(load());
  return {
    total: vals.length,
    resolved: vals.filter((v) => !v.miss).length,
    misses: vals.filter((v) => v.miss).length,
  };
}
