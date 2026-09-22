"""Title allowlist.

LinkedIn's keyword search matches description text, not just the title, so
"data engineer" pulls back things like "Staff+ Software Engineer, Databases"
— the phrase appears somewhere in the body. Nothing in the query params
fixes this; the filtering has to happen on our side.

An allowlist rather than a blocklist, for the same reason
silver_posting_keywords.sql uses a curated seed: blocklisting adjacent roles
is endless whack-a-mole, and every new batch invents a new title.
"""

import os
import re

DEFAULT_TITLES = ["data engineer", "analytics engineer"]

TITLES = [
    t.strip().lower()
    for t in os.getenv("BOARD_TITLE_MATCH", ",".join(DEFAULT_TITLES)).split(",")
    if t.strip()
]


def _pattern(title: str) -> re.Pattern:
    """Word-boundary matching so "data engineer" catches "Senior Data
    Engineer II" and "Data & Analytics Engineer", but a title merely
    *mentioning* data elsewhere doesn't slip through on a substring.

    "engineer" is treated as interchangeable with "engineering", since a
    plain \\b boundary treats them as different words — "Data Engineering
    Intern" and "Analytics Engineering Intern" are both real, common titles
    that a strict "data engineer" match would silently drop. This also means
    intern/co-op titles pass without listing them separately: nothing
    requires the match to be the *whole* title, just present as whole words,
    so "Data Engineer Intern" and "Data Engineering Intern" both already
    clear the bar.
    """
    # Split on "engineer" (not "engineering") so the pieces can be escaped
    # separately, then rejoined with an optional "ing".
    parts = re.split(r"engineer(?!ing)", title)
    body = "engineer(?:ing)?".join(re.escape(p) for p in parts)
    return re.compile(rf"\b{body}\b", re.IGNORECASE)


PATTERNS = [_pattern(t) for t in TITLES]

# Treating "engineering" as equivalent to "engineer" (above) has a side
# effect: "data engineering" now also matches "Data Engineering Manager" or
# "...Director", which the plain "engineer" form never did. Those are
# management titles, not the IC/intern roles this board is for.
#
# A small blocklist here — unlike the allowlist for job titles above — is
# safe because seniority/management words are a closed, stable set. Job
# titles invent new variants constantly (why TITLES is an allowlist);
# "Manager" and "Director" are not going to need updating next quarter.
SENIORITY_EXCLUDE = re.compile(
    r"\b(manager|director|vp|vice president|head of|chief)\b", re.IGNORECASE
)


def title_matches(title: str | None) -> bool:
    if not title:
        return False
    if SENIORITY_EXCLUDE.search(title):
        return False
    return any(p.search(title) for p in PATTERNS)


def filter_by_title(postings: list[dict]) -> list[dict]:
    return [p for p in postings if title_matches(p.get("title"))]


active_titles = TITLES
