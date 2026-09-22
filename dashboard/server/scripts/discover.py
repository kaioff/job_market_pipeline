"""Discovery pass: company names in, ATS boards out.

This is the bootstrap for the self-building watch list. LinkedIn knows which
employers are hiring; this maps as many of them as possible onto a board we
can poll in seconds instead of hours. Whatever doesn't resolve keeps
arriving through LinkedIn, so a miss costs latency, not coverage.

Run from dashboard/server:

    .venv/bin/python -m scripts.discover --bronze            # from the warehouse backlog
    .venv/bin/python -m scripts.discover --linkedin          # from a live search
    .venv/bin/python -m scripts.discover --names "Brex,Figma"
    .venv/bin/python -m scripts.discover --bronze --limit 100

Safe to re-run: results are cached, and misses aren't re-probed for
BOARD_MISS_TTL_DAYS.
"""

import argparse
import asyncio
import os
import re
import sys
from urllib.parse import quote

from dotenv import load_dotenv

load_dotenv()

from board.sources.http import client  # noqa: E402  (env must load first)
from board.sources.resolver import resolve, resolved_boards, resolver_stats  # noqa: E402

CATALOG = os.getenv("DATABRICKS_CATALOG", "job_market")


async def from_bronze() -> list[str]:
    from databricks_client import run_query

    rows = await run_query(
        f"""SELECT DISTINCT company
            FROM {CATALOG}.silver.silver_linkedin_postings
            WHERE company IS NOT NULL AND trim(company) <> ''"""
    )
    return [r["company"] for r in rows]


async def from_linkedin() -> list[str]:
    from bs4 import BeautifulSoup

    keywords = os.getenv("BOARD_DISCOVERY_KEYWORDS", "data engineer")
    location = os.getenv("BOARD_DISCOVERY_LOCATION", "San Francisco Bay Area")
    names: dict[str, None] = {}

    # Three pages is plenty for discovery — we want the breadth of employers,
    # not every posting. This runs rarely, so the request volume stays low.
    for start in (0, 25, 50):
        url = (
            "https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search"
            f"?keywords={quote(keywords)}&location={quote(location)}"
            f"&f_TPR=r604800&start={start}"
        )
        res = await client.get(url, headers={"User-Agent": "Mozilla/5.0"})
        if res.status_code != 200:
            break
        for el in BeautifulSoup(res.text, "html.parser").select("h4.base-search-card__subtitle"):
            name = re.sub(r"\s+", " ", el.get_text()).strip()
            if name:
                names[name] = None
    return list(names)


async def main() -> None:
    parser = argparse.ArgumentParser(description="Map company names onto ATS job boards.")
    source = parser.add_mutually_exclusive_group(required=True)
    source.add_argument("--bronze", action="store_true", help="companies from the warehouse")
    source.add_argument("--linkedin", action="store_true", help="companies from a live search")
    source.add_argument("--names", help="comma-separated company names")
    parser.add_argument("--limit", type=int, help="only resolve the first N names")
    args = parser.parse_args()

    if args.bronze:
        names = await from_bronze()
    elif args.linkedin:
        names = await from_linkedin()
    else:
        names = [s.strip() for s in args.names.split(",") if s.strip()]

    # Resolution is a few seconds per company (misses are slowest, since they
    # exhaust every strategy), so a full backlog run is an hours-long
    # background job. --limit makes it resumable: cached names are skipped
    # instantly on the next pass.
    if args.limit:
        names = names[: args.limit]

    print(f"resolving {len(names)} companies…\n")
    for name in names:
        r = await resolve(name)
        target = f"{r['ats']}/{r['slug']}" if r else ""
        print(f"  {'✅' if r else '❌'} {name[:34]:<35}{target}")

    s = resolver_stats()
    pct = round(s["resolved"] / s["total"] * 100) if s["total"] else 0
    print(f"\nresolved {s['resolved']}/{s['total']} ({pct}%), {s['misses']} on LinkedIn fallback")
    for ats, slugs in resolved_boards().items():
        print(f"  {ats:<16} {len(slugs)} boards")

    await client.aclose()


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except Exception as err:
        print(err, file=sys.stderr)
        sys.exit(1)
