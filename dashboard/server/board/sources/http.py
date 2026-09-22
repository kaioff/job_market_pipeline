"""One shared HTTP client for every source adapter.

A timeout is set so a single hung job board can't stall the whole poll.
"""

import httpx

client = httpx.AsyncClient(timeout=20.0, follow_redirects=True)
