"""The "Ask the data" chat: answers a natural-language question with Claude,
using the job-market MCP server's tools.

The MCP server runs in-process (an in-memory MCP client connected straight
to it), so the chat sees exactly the tools remote MCP clients get — same SQL
guard, same read-only token — with no network hop.
"""

import asyncio
import os
from collections.abc import AsyncIterator

from anthropic import AsyncAnthropic
from mcp import Client

from mcp_tools.server import mcp

MODEL = "claude-sonnet-5"
# A runaway question shouldn't be able to run the warehouse all afternoon.
MAX_TOOL_ROUNDS = 12
MAX_HISTORY = 10
# Warehouse cold starts take minutes; don't abandon run_sql mid-query.
TOOL_TIMEOUT_SECONDS = 5 * 60

SYSTEM = """You answer questions about a job market dataset for people
browsing its dashboard. The data comes from scraped LinkedIn job postings
(mainly San Francisco data engineering roles), processed in Databricks.

Use the tools to get real numbers — never guess or invent figures. Prefer
top_keywords / keyword_trends when they fit; otherwise call describe_tables
once, then write SQL for run_sql. If a query errors, read the message, fix
the SQL and retry. If the data can't answer the question, say so plainly and
suggest what it can answer.

Answer concisely in Markdown: lead with the direct answer, then supporting
numbers (a small table when comparing several items). Mention the snapshot
date or time range the numbers cover. Don't describe your SQL unless asked."""

# Created on first use so a missing key fails one request, not server boot.
_anthropic: AsyncAnthropic | None = None


def _client() -> AsyncAnthropic:
    global _anthropic
    if _anthropic is None:
        _anthropic = AsyncAnthropic(api_key=os.environ["API_CLAUDE_KEY"])
    return _anthropic


def _result_text(result) -> str:
    return "\n".join(c.text for c in result.content if c.type == "text")


async def ask(question: str, history: list[dict]) -> AsyncIterator[tuple[str, dict]]:
    """Runs the tool loop for one question, yielding (event, payload) pairs.

    Events: "text" (a chunk of the answer), "tool" (a tool call started),
    "tool_done" (it finished). `history` is prior turns as
    [{"role", "content"}] with plain-text content.
    """
    messages = [
        *({"role": m["role"], "content": m["content"]} for m in history[-MAX_HISTORY:]),
        {"role": "user", "content": question},
    ]

    async with Client(mcp) as client:
        tools = [
            {"name": t.name, "description": t.description, "input_schema": t.input_schema}
            for t in (await client.list_tools()).tools
        ]

        for _ in range(MAX_TOOL_ROUNDS + 1):
            async with _client().beta.messages.stream(
                model=MODEL,
                max_tokens=16000,
                system=SYSTEM,
                tools=tools,
                messages=messages,
                cache_control={"type": "ephemeral"},
                betas=["server-side-fallback-2026-07-01"],
                fallbacks="default",
            ) as stream:
                async for text in stream.text_stream:
                    yield "text", {"delta": text}
                message = await stream.get_final_message()

            if message.stop_reason == "refusal":
                yield "text", {"delta": "\n\nSorry — I can't help with that question."}
                return
            if message.stop_reason == "max_tokens":
                yield "text", {"delta": "\n\n_(Answer cut off — try a narrower question.)_"}
                return

            tool_uses = [b for b in message.content if b.type == "tool_use"]
            if message.stop_reason != "tool_use" or not tool_uses:
                return

            messages.append({"role": "assistant", "content": message.content})

            for call in tool_uses:
                yield "tool", {"id": call.id, "name": call.name, "input": call.input}

            async def run(call):
                try:
                    result = await client.call_tool(
                        call.name, call.input, read_timeout_seconds=TOOL_TIMEOUT_SECONDS
                    )
                    return call, _result_text(result), bool(result.is_error)
                except Exception as err:
                    return call, f"Tool failed: {err}", True

            # Run this turn's calls in parallel, report each as it lands, and
            # return every result together in one message.
            results = {}
            for finished in asyncio.as_completed([run(c) for c in tool_uses]):
                call, content, is_error = await finished
                results[call.id] = {
                    "type": "tool_result",
                    "tool_use_id": call.id,
                    "content": content,
                    "is_error": is_error,
                }
                yield "tool_done", {"id": call.id, "error": content[:300] if is_error else None}

            messages.append({"role": "user", "content": [results[c.id] for c in tool_uses]})
            yield "text", {"delta": "\n\n"}

    yield "text", {"delta": "_(Stopped after too many lookups — try a more specific question.)_"}
