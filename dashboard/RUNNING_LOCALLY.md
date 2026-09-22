# Running the dashboard locally

## Check what's running
```bash
lsof -ti:4000,5173
```
Prints PIDs if something's listening on either port. Nothing printed = both free.

## Kill everything
```bash
lsof -ti:4000,5173 | xargs kill -9
```
Safe to run even if nothing's up — xargs just no-ops.

## First-time setup (once)
The server is Python. Create its virtual environment and install packages:
```bash
cd ~/Developer/job_market_pipeline/dashboard/server
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
```

## Start the server (API + poller) — Terminal 1
```bash
cd ~/Developer/job_market_pipeline/dashboard/server
.venv/bin/uvicorn main:app --port 4000 --reload
```
Leave this terminal open. First boot takes ~20-30s (it polls every resolved board before answering requests).

## Start the client — Terminal 2
```bash
cd ~/Developer/job_market_pipeline/dashboard/client
npm run dev
```

Then open **http://localhost:5173/#/board**

## One-liner clean restart

**Tab 1:**
```bash
lsof -ti:4000,5173 | xargs kill -9 2>/dev/null; cd ~/Developer/job_market_pipeline/dashboard/server && .venv/bin/uvicorn main:app --port 4000 --reload
```

**Tab 2:**
```bash
cd ~/Developer/job_market_pipeline/dashboard/client && npm run dev
```

## What healthy looks like

Server log:
```
[board] seeded N postings from sqlite (max age 24h)
[board] polling greenhouse(X), ashby(X), ... every 300s over a 86400s window
INFO:     Uvicorn running on http://127.0.0.1:4000
```

Client log:
```
VITE vX.X.X  ready
➜  Local:   http://localhost:5173/
```

## Troubleshooting

**"Failed to load page"** — almost always the client (:5173) died silently while the server kept running.
```bash
lsof -ti:5173   # empty? client is dead
```
Just re-run `npm run dev` in the client folder (the client is still the React app, so it still uses npm).

**Board looks empty / thin** — check status:
```bash
curl -s localhost:4000/api/board/status | python3 -m json.tool
```

## Notes

- The SQLite store (`dashboard/server/data/board.sqlite`) persists across restarts — you won't lose history by stopping/starting.
- The background company-discovery job (`.venv/bin/python -m scripts.discover --bronze`, run from `dashboard/server`) runs independently of the dashboard — restarting the server/client does not affect it, and it keeps growing the resolved company list on its own.
