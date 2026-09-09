import * as cheerio from "cheerio";

/**
 * Source adapter for LinkedIn's public guest job-search endpoint.
 *
 * Every source adapter exports the same shape — `name` and an async
 * `fetchRecent({ windowSeconds })` returning normalized postings — so the
 * poller never knows which upstream it's talking to. Swapping in an ATS
 * board (Greenhouse/Lever) or a paid webhook feed means adding a sibling
 * file, not touching the poller, the store, or the page.
 */

const SEARCH_URL =
  "https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search";

// Slices to watch, as "keywords|location" pairs. Kept deliberately small:
// request volume is the only real ban risk, and it scales with this list.
const SLICES = (
  process.env.BOARD_SLICES || "data engineer|San Francisco Bay Area"
)
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean)
  .map((s) => {
    const [keywords, location] = s.split("|").map((p) => p.trim());
    return { keywords, location: location || "United States" };
  });

// A browser-ish UA. The guest endpoint serves empty results to obviously
// scripted clients, and an empty 200 is indistinguishable from "no new
// jobs" — see the consecutive-empty alarm in poller.js.
const HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
    "(KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
  "Accept-Language": "en-US,en;q=0.9",
};

/**
 * Pull the stable numeric posting ID off a card.
 *
 * This is the single most important function in the file. The card's href
 * carries per-request tracking params (refId, trackingId) that differ on
 * every fetch, so the same job yields a different URL each poll. Keying
 * dedup on the URL would make every posting look new forever and flood the
 * feed. The ID is stable; that's what we key on, and what we rebuild a
 * clean apply link from.
 *
 * Prefer data-entity-urn ("urn:li:jobPosting:4464656181") over parsing the
 * href — it's an explicit ID field rather than a slug we'd be reverse
 * engineering, so it survives title/company changes in the URL text.
 */
function extractPostingId($card) {
  const urn = $card.attr("data-entity-urn");
  const fromUrn = urn && urn.match(/jobPosting:(\d+)/);
  if (fromUrn) return fromUrn[1];

  const href = $card.find("a.base-card__full-link").attr("href");
  const fromHref = href && href.match(/-(\d{6,})(?:\?|$)/);
  return fromHref ? fromHref[1] : null;
}

function text($el) {
  return $el.text().replace(/\s+/g, " ").trim();
}

function parseCards(html) {
  const $ = cheerio.load(html);
  const out = [];

  $("div.base-search-card").each((_, el) => {
    const $card = $(el);
    const postingId = extractPostingId($card);
    if (!postingId) return;

    const title = text($card.find("h3.base-search-card__title"));
    if (!title) return;

    out.push({
      posting_id: postingId,
      title,
      company: text($card.find("h4.base-search-card__subtitle")) || null,
      location: text($card.find(".job-search-card__location")) || null,
      // Canonical apply link, tracking params stripped. This is what the
      // board links to — clicking it goes straight to the application.
      job_url: `https://www.linkedin.com/jobs/view/${postingId}/`,
      // LinkedIn's own posted date (YYYY-MM-DD). Coarse, which is why the
      // board sorts on retrieved_at instead.
      posted_at: $card.find("time").attr("datetime") || null,
    });
  });

  return out;
}

const DETAIL_URL = "https://www.linkedin.com/jobs-guest/jobs/api/jobPosting";

/**
 * Turn LinkedIn's relative posting age ("40 minutes ago", "22 hours ago")
 * into an absolute timestamp.
 *
 * Coarse by construction — "22 hours ago" could be anywhere in a 30-minute
 * band — but far better than the search card's `datetime` attribute, which
 * is date-only and rounds a 40-minute-old job to midnight.
 */
export function parseRelativeAge(txt, now = Date.now()) {
  if (!txt) return null;
  const m = txt.trim().toLowerCase().match(
    /(\d+)\s+(minute|hour|day|week|month)s?\s+ago/
  );
  if (!m) return null;

  const n = Number(m[1]);
  const unit = { minute: 6e4, hour: 36e5, day: 864e5, week: 6048e5, month: 2592e6 };
  return new Date(now - n * unit[m[2]]).toISOString();
}

/**
 * Second request, for postings we've decided to keep.
 *
 * Deliberately not run over every search result — only over new postings
 * that already passed the title filter, which is a handful per poll. That
 * keeps the added request volume small, which is the only thing standing
 * between this and a rate limit.
 */
async function fetchDetail(postingId) {
  const res = await fetch(`${DETAIL_URL}/${postingId}`, { headers: HEADERS });
  if (!res.ok) return {};

  const $ = cheerio.load(await res.text());

  const agoText = text($(".posted-time-ago__text").first());
  const applicantsText = text($(".num-applicants__caption").first());
  const applicants = applicantsText.match(/(\d+)/);

  return {
    posted_at_precise: parseRelativeAge(agoText),
    posted_age_text: agoText || null,
    applicants: applicants ? Number(applicants[1]) : null,
  };
}

async function fetchSlice(slice, windowSeconds) {
  const url =
    `${SEARCH_URL}?keywords=${encodeURIComponent(slice.keywords)}` +
    `&location=${encodeURIComponent(slice.location)}` +
    `&f_TPR=r${windowSeconds}&start=0`;

  const res = await fetch(url, { headers: HEADERS });

  // 429 is an explicit rate-limit; surface it so the poller can back off
  // rather than treating it as an empty result.
  if (res.status === 429) {
    const err = new Error("LinkedIn rate-limited the request (429)");
    err.rateLimited = true;
    throw err;
  }
  if (!res.ok) throw new Error(`LinkedIn returned HTTP ${res.status}`);

  return parseCards(await res.text());
}

export const linkedinSource = {
  name: "linkedin-guest",

  /**
   * Returns every posting visible in the last `windowSeconds`, across all
   * configured slices, deduped within the batch. Newness across polls is
   * the store's job, not ours — this always returns the full window.
   */
  async fetchRecent({ windowSeconds }) {
    const seen = new Set();
    const all = [];

    for (const slice of SLICES) {
      const cards = await fetchSlice(slice, windowSeconds);
      for (const card of cards) {
        if (seen.has(card.posting_id)) continue;
        seen.add(card.posting_id);
        all.push(card);
      }
    }

    return all;
  },

  /**
   * Enrich one posting with detail-page fields. Failures are swallowed:
   * a missing posted time degrades the row to its search-card date, which
   * is worse but not broken.
   */
  async enrich(posting) {
    try {
      return { ...posting, ...(await fetchDetail(posting.posting_id)) };
    } catch {
      return posting;
    }
  },

  sliceCount: SLICES.length,
};
