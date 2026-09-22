"""Local MCP entry point over stdio, for Claude Code / Claude Desktop (see
.mcp.json at the repo root). Run from dashboard/server:

    .venv/bin/python -m mcp_tools.stdio

stdout is the protocol channel, so all logging goes to stderr.
"""

import asyncio
import logging
import sys

from dotenv import load_dotenv

load_dotenv()
logging.basicConfig(stream=sys.stderr, level=logging.INFO, format="%(message)s")

from board.store import seed  # noqa: E402  (env must load before these read it)
from mcp_tools.server import mcp  # noqa: E402


async def main() -> None:
    # Load the board from the local SQLite sink the poller writes to.
    await seed()
    await mcp.run_stdio_async()


if __name__ == "__main__":
    asyncio.run(main())
