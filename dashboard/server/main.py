"""API server for the job market dashboard.

Run from dashboard/server:

    .venv/bin/uvicorn main:app --port 4000 --reload

Serves the React dashboard's API (/api/...), the live job board feed, the
MCP endpoint (/mcp) and the "Ask the data" chat (/api/ask).
"""

import asyncio
import json
import logging
import os
import re
from contextlib import asynccontextmanager

from dotenv import load_dotenv

load_dotenv()
logging.basicConfig(level=logging.INFO, format="%(message)s")
# The Databricks driver and httpx log every call at INFO; keep the console readable.
logging.getLogger("databricks").setLevel(logging.WARNING)
logging.getLogger("httpx").setLevel(logging.WARNING)

import anthropic  # noqa: E402  (env must load before the modules below read it)
from cachetools import TTLCache  # noqa: E402
from fastapi import FastAPI, Request  # noqa: E402
from fastapi.middleware.cors import CORSMiddleware  # noqa: E402
from fastapi.responses import JSONResponse, StreamingResponse  # noqa: E402

from ask import ask  # noqa: E402
from board.poller import poller_status, start_poller, stop_poller  # noqa: E402
from board.sources.http import client as http_client  # noqa: E402
from board.store import recent, subscribe, subscriber_count, unsubscribe  # noqa: E402
from databricks_client import run_query  # noqa: E402
from mcp_tools.server import mcp  # noqa: E402
from queries import GRAINS, trends_sql  # noqa: E402

log = logging.getLogger("api")

CATALOG = os.getenv("DATABRICKS_CATALOG", "job_market")
SCHEMA = os.getenv("DATABRICKS_SCHEMA", "gold")
SILVER_SCHEMA = os.getenv("DATABRICKS_SILVER_SCHEMA", "silver")

WAREHOUSE_ERROR = {"error": "Failed to query Databricks. The warehouse may be starting up — try again shortly."}

# Built before the app so its routes can be added below; the session manager
# it creates has to run for the app's lifetime (see lifespan).
mcp_app = mcp.streamable_http_app(stateless_http=True)


@asynccontextmanager
async def lifespan(app: FastAPI):
    if os.getenv("BOARD_POLLER_ENABLED") != "false":
        await start_poller()
    async with mcp.session_manager.run():
        yield
    await stop_poller()
    await http_client.aclose()


app = FastAPI(lifespan=lifespan)
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])

_cache: TTLCache = TTLCache(maxsize=1024, ttl=float(os.getenv("CACHE_TTL_SECONDS", "3600")))


async def cached_query(cache_key: str, statement: str) -> list[dict]:
    if cache_key in _cache:
        return _cache[cache_key]
    rows = await run_query(statement)
    _cache[cache_key] = rows
    return rows


def int_param(value: str | None, default: int, maximum: int) -> int:
    """Query-string number with the old server's rules: missing, zero or
    unparseable falls back to the default; anything larger is capped."""
    try:
        n = int(float(value)) if value is not None else 0
    except ValueError:
        n = 0
    return min(n or default, maximum)


# Latest snapshot: keyword, raw count, and TRUE percentage of postings (pct
# is computed correctly in the gold_keyword_latest model itself, against a
# real count of total postings — not approximated here).
@app.get("/api/keywords/latest")
async def keywords_latest(limit: str | None = None):
    n = int_param(limit, 40, 200)
    try:
        return await cached_query(
            f"latest:{n}",
            f"""SELECT keyword, posting_count, snapshot_date, pct
                FROM {CATALOG}.{SCHEMA}.gold_keyword_latest
                ORDER BY posting_count DESC
                LIMIT {n}""",
        )
    except Exception:
        log.exception("Error fetching latest keywords")
        return JSONResponse(WAREHOUSE_ERROR, status_code=502)


# Time series for top N keywords, at daily / weekly / monthly grain.
# Weekly/monthly use the "close" value: the last snapshot in each period.
# pct now comes straight from gold_keyword_trends (real denominator).
@app.get("/api/keywords/trends")
async def keywords_trends(top: str | None = None, grain: str | None = None):
    top_n = int_param(top, 12, 100)
    grain = grain if grain in GRAINS else "daily"
    try:
        return await cached_query(f"trends:{top_n}:{grain}", trends_sql(top_n, grain))
    except Exception:
        log.exception("Error fetching keyword trends")
        return JSONResponse(WAREHOUSE_ERROR, status_code=502)


@app.get("/api/health")
async def health():
    return {"status": "ok"}


# Experience-level distribution across all current postings.
@app.get("/api/experience")
async def experience():
    try:
        return await cached_query(
            "experience",
            f"""SELECT experience_band, posting_count, pct
                FROM {CATALOG}.{SCHEMA}.gold_experience_distribution""",
        )
    except Exception:
        log.exception("Error fetching experience distribution")
        return JSONResponse(WAREHOUSE_ERROR, status_code=502)


# ---------------------------------------------------------------------
# Skill lookup: "tell me about <skill>"
# ---------------------------------------------------------------------


async def load_skill_index() -> dict[str, dict]:
    """The searchable vocabulary comes from the curated seed, so every name we
    ever put into SQL below originates from our own tables — never straight
    from the query string. That's both how free-text resolves to a canonical
    skill and why the interpolation here is safe.
    """
    rows = await cached_query(
        "skill-index",
        f"SELECT skill, category, aliases FROM {CATALOG}.{SILVER_SCHEMA}.skills",
    )
    index: dict[str, dict] = {}
    for row in rows:
        terms = [row["skill"], *(row["aliases"].split("|") if row["aliases"] else [])]
        for term in terms:
            key = str(term).strip().lower()
            if key:
                index[key] = {"skill": row["skill"], "category": row["category"]}
    return index


def resolve_skill(index: dict[str, dict], raw_query: str) -> dict | None:
    """Resolves free text ("I want to know about JS", "python") to a
    canonical skill. Deterministic on purpose: exact match, then alias, then a
    contained-term scan, preferring the longest match so "spark streaming"
    beats "spark" in a sentence mentioning both.
    """
    normalized = re.sub(r"[^\w\s.+#/-]", " ", str(raw_query or "").lower())
    normalized = re.sub(r"\s+", " ", normalized).strip()
    if not normalized:
        return None
    if normalized in index:
        return index[normalized]

    best_term, best_entry = None, None
    for term, entry in index.items():
        if re.search(rf"(^|\s){re.escape(term)}($|\s)", normalized):
            if best_term is None or len(term) > len(best_term):
                best_term, best_entry = term, entry
    return best_entry


def sql_string(value) -> str:
    return "'" + str(value).replace("'", "''") + "'"


# Full searchable list — powers autocomplete in the dashboard.
@app.get("/api/skills")
async def skills():
    try:
        return await cached_query(
            "skills-list",
            f"""SELECT keyword AS skill, category, posting_count, pct
                FROM {CATALOG}.{SCHEMA}.gold_skill_profile p
                LEFT JOIN {CATALOG}.{SILVER_SCHEMA}.skills s ON p.keyword = s.skill
                ORDER BY posting_count DESC""",
        )
    except Exception:
        log.exception("Error fetching skill list")
        return JSONResponse(WAREHOUSE_ERROR, status_code=502)


# Everything the overview panel needs for one skill, in a single call.
@app.get("/api/skills/{query}/overview")
async def skill_overview(query: str):
    try:
        index = await load_skill_index()
        resolved = resolve_skill(index, query)

        if not resolved:
            suggestions = list(dict.fromkeys(e["skill"] for e in index.values()))[:10]
            return JSONResponse(
                {"error": f'No skill matched "{query}".', "suggestions": suggestions},
                status_code=404,
            )

        skill = resolved["skill"]
        quoted = sql_string(skill)

        profile, related, breakdown = await asyncio.gather(
            cached_query(
                f"skill-profile:{skill}",
                f"""SELECT keyword, posting_count, pct, avg_years_min, median_years_min,
                           postings_with_experience_stated
                    FROM {CATALOG}.{SCHEMA}.gold_skill_profile
                    WHERE keyword = {quoted}""",
            ),
            cached_query(
                f"skill-related:{skill}",
                f"""SELECT related_keyword, co_posting_count, pct_of_skill_postings
                    FROM {CATALOG}.{SCHEMA}.gold_skill_cooccurrence
                    WHERE keyword = {quoted}
                    ORDER BY co_posting_count DESC""",
            ),
            cached_query(
                f"skill-breakdown:{skill}",
                f"""SELECT dimension, value, posting_count, pct_of_skill_postings
                    FROM {CATALOG}.{SCHEMA}.gold_skill_breakdown
                    WHERE keyword = {quoted}
                    ORDER BY dimension, posting_count DESC""",
            ),
        )

        if not profile:
            return JSONResponse(
                {"error": f"\"{skill}\" isn't mentioned in any posting we've collected yet."},
                status_code=404,
            )

        def by_dimension(name):
            return [r for r in breakdown if r["dimension"] == name]

        return {
            "skill": skill,
            "category": resolved["category"],
            **profile[0],
            "related_skills": related,
            "top_titles": by_dimension("title"),
            "top_companies": by_dimension("company"),
            "top_locations": by_dimension("location"),
            "experience_bands": by_dimension("experience_band"),
        }
    except Exception:
        log.exception("Error fetching skill overview")
        return JSONResponse(WAREHOUSE_ERROR, status_code=502)


# ---------- Live job board ----------
#
# These routes are deliberately unlike the ones above: they never touch
# Databricks. The poller holds the last 48h in process memory, so a board
# request costs microseconds instead of waiting on a SQL Warehouse that may
# be cold. No cache either — the store IS the cache.


# Initial paint. Without this the board would be empty on load most of the
# time, since the live window frequently contains zero postings.
@app.get("/api/board/recent")
async def board_recent(limit: str | None = None):
    return recent(int_param(limit, 200, 1000))


# Live tail. SSE rather than WebSockets: the feed is server-to-client only,
# EventSource reconnects on its own, and it survives proxies.
@app.get("/api/board/stream")
async def board_stream():
    queue = subscribe()

    async def frames():
        try:
            yield "retry: 5000\n\n"
            while True:
                try:
                    yield await asyncio.wait_for(queue.get(), timeout=25)
                except asyncio.TimeoutError:
                    # Idle proxies drop quiet connections; a comment frame
                    # keeps it open without reaching the client's handler.
                    yield ": ping\n\n"
        finally:
            unsubscribe(queue)

    return StreamingResponse(
        frames(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache, no-transform",
            # Stops nginx and friends from buffering the stream into uselessness.
            "X-Accel-Buffering": "no",
        },
    )


# Operational view: mainly for spotting a silent block, where polls keep
# succeeding but return nothing.
@app.get("/api/board/status")
async def board_status():
    return {**poller_status(), "subscribers": subscriber_count()}


# ---------- MCP + Ask the data (local only) ----------
#
# Local-only until auth exists: the SQL tool hands the warehouse to whoever
# can reach these routes, and every question spends Anthropic credits.
# Origin is checked too because the open CORS policy above would otherwise
# let any website a local user visits call them.

LOCAL_ADDRS = {"127.0.0.1", "::1", "::ffff:127.0.0.1"}
LOCAL_ORIGIN = re.compile(r"^https?://(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$")
LOCAL_ONLY_PATHS = ("/mcp", "/api/ask")


@app.middleware("http")
async def local_only(request: Request, call_next):
    if request.url.path.startswith(LOCAL_ONLY_PATHS):
        origin = request.headers.get("origin")
        host = request.client.host if request.client else None
        if host not in LOCAL_ADDRS or (origin and not LOCAL_ORIGIN.match(origin)):
            return JSONResponse({"error": "This endpoint only accepts local connections."}, status_code=403)
    return await call_next(request)


# Remote MCP endpoint (Streamable HTTP, stateless). Its route comes from the
# MCP library's own app, which also rejects non-local Host headers.
app.router.routes.extend(mcp_app.routes)


# "Ask the data" chat: Claude answers using the MCP tools, streamed back as
# SSE. Stops spending tokens if the reader closes the tab mid-answer, since
# the server then cancels the stream.
@app.post("/api/ask")
async def ask_route(request: Request):
    try:
        body = await request.json()
    except ValueError:
        body = {}
    if not isinstance(body, dict):
        body = {}

    question = str(body.get("question") or "").strip()
    history = [
        m for m in (body.get("history") if isinstance(body.get("history"), list) else [])
        if isinstance(m, dict) and m.get("role") in ("user", "assistant")
        and isinstance(m.get("content"), str) and m["content"]
    ]
    if not question or len(question) > 2000:
        return JSONResponse({"error": "Ask a question of up to 2000 characters."}, status_code=400)
    if not os.getenv("API_CLAUDE_KEY"):
        return JSONResponse({"error": "API_CLAUDE_KEY is not set on the server."}, status_code=503)

    def frame(event: str, payload: dict) -> str:
        return f"event: {event}\ndata: {json.dumps(payload)}\n\n"

    async def events():
        try:
            async for event, payload in ask(question, history):
                yield frame(event, payload)
            yield frame("done", {})
        except anthropic.AuthenticationError:
            yield frame("error", {"message": "The Claude API key was rejected — check API_CLAUDE_KEY."})
        except anthropic.RateLimitError:
            yield frame("error", {"message": "Claude is rate limited right now — try again in a minute."})
        except anthropic.APIStatusError as err:
            log.exception("Ask failed")
            yield frame("error", {"message": f"Claude API error ({err.status_code}). Try again."})
        except Exception:
            log.exception("Ask failed")
            yield frame("error", {"message": "Something went wrong answering that. Try again."})

    return StreamingResponse(events(), media_type="text/event-stream", headers={"Cache-Control": "no-cache"})


if __name__ == "__main__":
    import uvicorn

    uvicorn.run("main:app", port=int(os.getenv("PORT", "4000")), reload=True)
