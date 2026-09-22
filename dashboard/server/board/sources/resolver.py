"""Company name -> ATS board, resolved once and cached forever.

This is what makes the watch list self-building. LinkedIn is good at breadth
("who is hiring?") and bad at speed; the ATS boards are the reverse.
Resolving names to boards lets each do what it's good at, so the company
list derives itself from search results instead of being curated by hand.

Misses are cached too. A company on Workday or an in-house system will never
resolve, and re-probing it on every run would be pure waste — it simply
stays on the LinkedIn path, which is where it would have been anyway.
"""

import json
import os
import re
from pathlib import Path
from urllib.parse import quote

from board.sources.http import client
from board.timeutil import now_iso, now_ms, parse_ms

MAP_PATH = os.getenv("BOARD_ATS_MAP", "./data/ats-map.json")

# Re-check misses occasionally: companies do migrate onto a supported ATS.
MISS_TTL_DAYS = float(os.getenv("BOARD_MISS_TTL_DAYS", "30"))


def _first_job(key):
    def get(body):
        jobs = body.get("jobs") if isinstance(body, dict) else None
        return jobs[0].get(key) if jobs else None
    return get


def _list_at(key):
    def get(body):
        value = body.get(key) if isinstance(body, dict) else None
        return value if isinstance(value, list) else []
    return get


PROVIDERS = [
    {
        "ats": "greenhouse",
        "url": lambda s: f"https://boards-api.greenhouse.io/v1/boards/{s}/jobs",
        "jobs": _list_at("jobs"),
        # Greenhouse echoes the employer name, which is what lets us verify a
        # resolution rather than trusting a guessed slug.
        "company": _first_job("company_name"),
        "host": "greenhouse.io",
    },
    {
        "ats": "ashby",
        "url": lambda s: f"https://api.ashbyhq.com/posting-api/job-board/{s}",
        "jobs": _list_at("jobs"),
        "company": lambda body: None,
        "host": "ashbyhq.com",
    },
    {
        "ats": "lever",
        "url": lambda s: f"https://api.lever.co/v0/postings/{s}?mode=json",
        "jobs": lambda body: body if isinstance(body, list) else [],
        "company": lambda body: None,
        "host": "lever.co",
    },
    {
        "ats": "smartrecruiters",
        "url": lambda s: f"https://api.smartrecruiters.com/v1/companies/{s}/postings",
        "jobs": _list_at("content"),
        "company": lambda body: None,
        "host": "smartrecruiters.com",
    },
    {
        "ats": "workable",
        "url": lambda s: f"https://apply.workable.com/api/v1/widget/accounts/{s}?details=true",
        "jobs": _list_at("jobs"),
        "company": lambda body: body.get("name") if isinstance(body, dict) else None,
        "host": "workable.com",
    },
]

BY_ATS = {p["ats"]: p for p in PROVIDERS}

# ---------- cache ----------

_cache: dict | None = None


def _load() -> dict:
    global _cache
    if _cache is None:
        try:
            _cache = json.loads(Path(MAP_PATH).read_text("utf8"))
        except (OSError, ValueError):
            _cache = {}
    return _cache


def _save() -> None:
    Path(MAP_PATH).parent.mkdir(parents=True, exist_ok=True)
    Path(MAP_PATH).write_text(json.dumps(_cache, indent=2))


def _key(name: str) -> str:
    return name.strip().lower()


# ---------- matching helpers ----------


def _squash(s: str | None) -> str:
    return re.sub(r"[^a-z0-9]", "", (s or "").lower())


def _names_agree(a: str | None, b: str | None) -> bool:
    """Loose company-name check.

    Needed because domain lookup is ambiguous — "Sigma" resolves to
    sigmaaldrich.com, a chemical supplier, and without this guard we'd
    happily poll their board and surface unrelated jobs under Sigma's name.
    Substring either direction tolerates "Scale AI" vs "Scale".
    """
    x, y = _squash(a), _squash(b)
    if not x or not y:
        return True  # provider gave us nothing to check against
    return y in x or x in y


def _slug_candidates(name: str) -> list[str]:
    base = name.lower().strip()
    stripped = re.sub(
        r"\b(inc|llc|ltd|corp|corporation|labs?|technologies|technology|software|the)\b", "", base
    )
    out = []
    for n in (base, stripped):
        out.append(re.sub(r"[^a-z0-9]", "", n))
        out.append(re.sub(r"[^a-z0-9]+", "-", n).strip("-"))
    return [s for s in dict.fromkeys(out) if s]


# ---------- strategies ----------

# Path segments that appear after an ATS hostname but are never a slug.
NOT_SLUGS = {
    "jobs", "job", "embed", "job_board", "boards", "js", "v1", "api", "board",
    "search", "widget", "accounts", "companies", "postings", "app", "www",
}


def _extract_slugs(html: str, provider: dict) -> list[str]:
    """Every plausible slug for one provider on a careers page, best-first.

    Includes the embed form (js.greenhouse.io/...?for=<slug>) because many
    careers pages mount the board as a widget and never link the board URL
    directly.
    """
    host = re.escape(provider["host"])
    found = []

    for m in re.finditer(rf"{host}[^\"'<>]*?[?&]for=([a-z0-9_-]{{2,}})", html, re.IGNORECASE):
        found.append(m.group(1))

    for m in re.finditer(rf"{host}/(?:[a-z_-]+/)*([a-z0-9_-]{{2,}})", html, re.IGNORECASE):
        for seg in m.group(0).split("/")[1:]:
            if seg and seg.lower() not in NOT_SLUGS:
                found.append(seg)

    slugs = [s for s in dict.fromkeys(s.lower() for s in found) if s not in NOT_SLUGS]
    return slugs[:5]


async def _try_board(ats: str, slug: str, expected_name: str | None) -> dict | None:
    p = BY_ATS[ats]
    try:
        res = await client.get(p["url"](slug), timeout=10)
        if res.status_code != 200:
            return None
        body = res.json()
        jobs = p["jobs"](body)
        if not jobs:
            return None
        if expected_name and not _names_agree(p["company"](body), expected_name):
            return None
        return {"ats": ats, "slug": slug, "jobs": len(jobs)}
    except Exception:
        return None


async def _by_name_probe(name: str) -> dict | None:
    """Strategy 1: guess the slug from the name. Cheap, and hits ~80%."""
    for slug in _slug_candidates(name):
        for p in PROVIDERS:
            hit = await _try_board(p["ats"], slug, name)
            if hit:
                return {**hit, "method": "name-probe"}
    return None


async def _by_careers_page(name: str) -> dict | None:
    """Strategy 2: read the ATS link straight off the company's careers page.

    Slower, but exact — it's how "Sigma" resolves to
    greenhouse/sigmacomputing, which no amount of name-guessing would find.
    """
    try:
        res = await client.get(
            f"https://autocomplete.clearbit.com/v1/companies/suggest?query={quote(name)}",
            timeout=8,
        )
        # Not just the top hit: name lookup is ambiguous, and the company we
        # want is often not first. "Sigma" returns Sigma-Aldrich (a chemical
        # supplier) ahead of Sigma Computing. Checking a few and verifying
        # the board's employer name is what disambiguates them.
        candidates = [c.get("domain") for c in (res.json() or [])[:3]]
    except Exception:
        return None

    for domain in filter(None, candidates):
        hit = await _scan_careers_pages(domain, name)
        if hit:
            return hit
    return None


async def _scan_careers_pages(domain: str, name: str) -> dict | None:
    for path in ("/careers", "/jobs"):
        try:
            res = await client.get(
                f"https://{domain}{path}", headers={"User-Agent": "Mozilla/5.0"}, timeout=12
            )
            if res.status_code != 200:
                continue
            html = res.text
            for p in PROVIDERS:
                for slug in _extract_slugs(html, p):
                    # Validate against the live API rather than trusting the
                    # scrape. A careers page links to plenty of URLs on an
                    # ATS host that aren't the board — /jobs, /embed,
                    # /job_board — so the only reliable test is whether the
                    # slug actually serves postings under a matching
                    # employer name.
                    hit = await _try_board(p["ats"], slug, name)
                    if hit:
                        return {**hit, "method": f"careers-page:{domain}"}
        except Exception:
            continue  # try the next path
    return None


# ---------- public ----------


async def resolve(name: str) -> dict | None:
    cache = _load()
    k = _key(name)
    cached = cache.get(k)

    if cached and not cached.get("miss"):
        return cached
    if cached and cached.get("miss"):
        checked = parse_ms(cached.get("checkedAt")) or 0
        if (now_ms() - checked) / 86400000 < MISS_TTL_DAYS:
            return None

    # Name-probe first: it's a handful of cheap API calls and no third party.
    # The careers-page route costs a lookup plus a page fetch, so it's the
    # fallback rather than the default.
    hit = await _by_name_probe(name) or await _by_careers_page(name)

    if hit:
        cache[k] = {"name": name, "ats": hit["ats"], "slug": hit["slug"],
                    "method": hit["method"], "resolvedAt": now_iso()}
    else:
        cache[k] = {"name": name, "miss": True, "checkedAt": now_iso()}
    _save()

    return cache[k] if hit else None


def resolved_boards() -> dict[str, list[str]]:
    """Every resolved board, grouped by ATS — this is what the poller reads."""
    out: dict[str, list[str]] = {}
    for v in _load().values():
        if v.get("miss"):
            continue
        out.setdefault(v["ats"], []).append(v["slug"])
    return out


def resolver_stats() -> dict:
    vals = list(_load().values())
    misses = sum(1 for v in vals if v.get("miss"))
    return {"total": len(vals), "resolved": len(vals) - misses, "misses": misses}
