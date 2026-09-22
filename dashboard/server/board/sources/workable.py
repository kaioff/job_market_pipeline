"""Workable public widget API.

The one weak spot in the ATS set: `published_on` is date-only, so a job
posted this morning is indistinguishable from one posted at midnight. We
deliberately leave posted_at_precise null rather than fabricating a time —
the board falls back to the date, and the age filter treats it as midnight,
which errs toward showing a job slightly too long rather than hiding a fresh
one.
"""

import logging

from board.sources.companies import companies
from board.sources.http import client
from board.timeutil import iso_from_ms, now_ms

log = logging.getLogger("board")

API = "https://apply.workable.com/api/v1/widget/accounts"


def _normalize(job: dict, slug: str) -> dict:
    published = job.get("published_on") or job.get("created_at")
    return {
        "posting_id": f"wk:{slug}:{job['shortcode']}",
        "title": job.get("title"),
        "company": slug,
        "location": ", ".join(filter(None, [job.get("city"), job.get("state"), job.get("country")])) or None,
        "job_url": job.get("application_url") or job.get("shortlink") or job.get("url"),
        "posted_at": published or None,
        "posted_at_precise": None,
        "applicants": None,
    }


class WorkableSource:
    name = "workable"

    async def fetch_recent(self, window_seconds: int) -> list[dict]:
        # Date-only timestamps, so compare on whole days and round up: better
        # to admit a borderline posting than to silently drop a fresh one.
        cutoff_day = iso_from_ms(now_ms() - window_seconds * 1000)[:10]
        out = []
        for slug in companies("workable"):
            try:
                res = await client.get(f"{API}/{slug}?details=true")
                if res.status_code != 200:
                    log.warning("[board] workable/%s -> HTTP %d, skipped", slug, res.status_code)
                    continue
                for job in res.json().get("jobs", []):
                    p = _normalize(job, slug)
                    if not p["posted_at"]:
                        continue
                    if p["posted_at"] < cutoff_day:
                        continue
                    out.append(p)
            except Exception as err:
                log.warning("[board] workable/%s failed: %s", slug, err)
        return out

    async def enrich(self, posting: dict) -> dict:
        return posting

    @property
    def slice_count(self) -> int:
        return len(companies("workable"))


workable_source = WorkableSource()
