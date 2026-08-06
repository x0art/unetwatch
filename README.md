# ELK Monitoring

A FastAPI-based URL pattern monitoring and admin console that watches Elasticsearch
logs for blocked content patterns, and provides a web admin UI to manage those
patterns through a full REST API.

## Features

- **Elasticsearch polling** — periodically queries ES for log entries matching blocked
  URL patterns and forwards aggregated findings to a webhook.
- **Pattern management** — full CRUD for block patterns and whitelist patterns, stored
  in SQLite (no hardcoded lists).
- **Bulk import** — add many patterns at once via the UI or API.
- **Admin console** — a clean web dashboard built with React + TypeScript + Tailwind,
  served directly by FastAPI (no separate server, no CDN).
- **Authentication** — dashboard login with session tokens, API key or Basic Auth for
  programmatic access. Credentials stored in `.env`.
- **Poll countdown** — real-time countdown widget showing time until next ES query.
- **Redirect tracker** — monitor URLs for redirects: an HTTP checker follows redirect
  chains hop-by-hop, auto-adds every destination to the watch list, records when a URL's
  target changes over time, and visualizes the relations as a layered graph.
- **Serve API + UI from one process** — the built frontend is served at `/`.

## Tech Stack

| Layer      | Technology                                         |
|------------|----------------------------------------------------|
| Backend    | FastAPI, Uvicorn, Pydantic                         |
| Database   | SQLite (aiosqlite)                                 |
| Scheduler  | APScheduler                                        |
| ES client  | elasticsearch (async)                              |
| Frontend   | React + TypeScript, Vite, Tailwind CSS v4, Radix   |

## Getting Started

### Prerequisites

- Python 3.12+
- Node.js 20+ (only needed to rebuild the admin UI)
- An Elasticsearch instance with proxy/firewall logs

### 1. Install & configure

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -e ".[dev]"

# Create your local environment file from the template
cp .env.example .env
# then edit .env with your real credentials
```

### 2. Build the admin UI

```bash
cd admin-ui
npm install
npm run build    # output goes to admin-ui/dist, served by FastAPI at /
cd ..
```

### 3. Run the server

```bash
uvicorn app.main:app --host 0.0.0.0 --port 8000 --reload
```

Open http://localhost:8000 — the admin console loads at `/` and the API docs at
`/docs`.

## Configuration

Configuration lives in the `.env` file (copy from `.env.example`). All variables are
optional and have sensible defaults.

| Variable                | Default                 | Description                          |
|-------------------------|-------------------------|--------------------------------------|
| `ELASTIC_HOST`          | `http://localhost:9200` | Elasticsearch endpoint               |
| `ELASTIC_INDEX`         | `logstash-proxy-*`      | Index pattern to search              |
| `ELASTIC_USER`          | `elastic`               | ES username                          |
| `ELASTIC_PASS`          | `changeme`              | ES password                          |
| `WEBHOOK_URL`           | _(empty)_               | Webhook to POST aggregated findings  |
| `POLL_INTERVAL_MINUTES` | `10`                    | How often to poll ES                 |
| `ES_QUERY_SIZE`         | `5000`                  | Max documents per ES query           |
| `DATABASE_URL`          | `sqlite:///./elk_monitoring.db` | SQLite location               |
| `ADMIN_USER`            | `admin`                 | Dashboard login username             |
| `ADMIN_PASS`            | `changeme`              | Dashboard login password             |
| `API_KEY`               | _(empty)_               | Static API key for programmatic use  |
| `REDIRECT_CHECK_INTERVAL_MINUTES` | `60`          | How often to re-check tracked URLs   |
| `REDIRECT_TIMEOUT_SECONDS` | `10`               | HTTP timeout per redirect hop        |

## API

The API is documented interactively at `http://localhost:8000/docs` (Swagger UI).

### URL Patterns

| Method | Path                    | Description                       |
|--------|-------------------------|-----------------------------------|
| GET    | `/api/patterns/`        | List patterns (filter/search/paginate) |
| GET    | `/api/patterns/{id}`    | Get a single pattern              |
| POST   | `/api/patterns/`        | Create a pattern                  |
| PUT    | `/api/patterns/{id}`    | Update a pattern                  |
| DELETE | `/api/patterns/{id}`    | Delete a pattern                  |
| POST   | `/api/patterns/bulk`    | Bulk import patterns              |
| GET    | `/api/patterns/stats/counts` | Pattern counts by type        |

Pattern types: `block` (URLs to flag) and `whitelist` (URLs to allow). Query params
for list: `?pattern_type=block&search=porn&limit=50&offset=0`.

### Monitor

| Method | Path               | Description                      |
|--------|--------------------|----------------------------------|
| GET    | `/api/monitor/status` | Service & pattern counts      |
| POST   | `/api/monitor/run` | Trigger a manual ES poll          |

### Redirects

| Method | Path                    | Description                                    |
|--------|-------------------------|------------------------------------------------|
| GET    | `/api/redirects/`       | List tracked URLs (search/sort/paginate)       |
| POST   | `/api/redirects/`       | Add a URL to track                             |
| DELETE | `/api/redirects/{id}`   | Stop tracking a URL (history is kept)          |
| POST   | `/api/redirects/check`  | Re-check all tracked URLs — or one, via `{"url": "..."}` |
| GET    | `/api/redirects/graph`  | Nodes + edges for the relations graph          |
| GET    | `/api/redirects/{id}/history` | Full redirect history for one URL         |

Field reference:

- `source` — how the URL entered the list: `manual` (typed in the UI/API),
  `finding` (added from the Findings page), or `auto` (discovered while following a chain).
- `status` — last check outcome: `unknown`, `ok`, `redirect`, or `error`.
- Graph edges carry an `active` flag: `true` = the current live redirect,
  `false` = a historical relation (URL's target changed).

All redirect endpoints require authentication (`X-API-Key`, session token, or Basic Auth).

### Example

```bash
# List block patterns
curl "http://localhost:8000/api/patterns/?pattern_type=block&limit=10"

# Add a pattern
curl -X POST http://localhost:8000/api/patterns/ \
  -H "Content-Type: application/json" \
  -d '{"pattern": "*porn*", "pattern_type": "block"}'
```

## How the monitoring flow works

1. On startup, the database is created and seeded with default block/whitelist
   patterns from the SQLite schema.
2. APScheduler runs `fetch_logs()` every `POLL_INTERVAL_MINUTES`.
3. `fetch_logs()` queries Elasticsearch for entries whose `url` field matches any
   **block** pattern within the last 10 minutes.
4. Results are filtered against the **whitelist** and for `action == "ALLOW"`.
5. Aggregated results (grouped by client IP) are POSTed to the configured webhook.

## How redirect tracking works

1. URLs are added to the watch list manually, from a **Finding**, or are auto-discovered
   as redirect destinations.
2. APScheduler runs `check_all()` every `REDIRECT_CHECK_INTERVAL_MINUTES` — the same
   job is triggered on demand by the "Check now" button.
3. Each URL is requested with `HEAD` (falling back to `GET` when the server rejects it)
   and redirects are followed hop-by-hop with no hop cap — loop detection (a seen-URL set)
   terminates self-loops and cycles.
4. Every observed hop is stored as a `redirect_edges` row. When a URL's target changes
   (e.g. url1 used to point at url2, now points at url3), the old edge is marked
   inactive and kept for history; the new edge becomes active.
5. Every destination is added to `tracked_urls` (source `auto`) so the whole chain is
   monitored transitively.
6. The **Redirects** page lists all tracked URLs (status, current target, history count)
   and visualizes the relations as a depth-layered graph — sources on the left, each hop
   in its own column — with a toggle to show historical (dashed) edges.

## Developing

### Backend tests

```bash
source .venv/bin/activate
pytest            # full test suite (CRUD, validation, redirects)
```

### Lint

```bash
ruff check .
```

### Frontend dev (hot reload)

```bash
cd admin-ui
npm run dev       # runs on :5173 with /api proxied to :8000
```

Keep `uvicorn` running on :8000 and `npm run dev` on :5173, then open
http://localhost:5173.

## Project Structure

```
elk-monitoring/
├── app/
│   ├── config.py          # Pydantic settings, .env loading
│   ├── database.py        # SQLite init + connection
│   ├── models.py          # Pydantic schemas
│   ├── main.py            # FastAPI app, lifespan, static serving
│   ├── routes/
│   │   ├── patterns.py    # CRUD + bulk endpoints
│   │   ├── monitor.py     # status + manual run
│   │   ├── findings.py    # findings list + traffic graph
│   │   ├── blacklist.py   # URL/IP blacklist feeds
│   │   └── redirects.py   # redirect tracker endpoints
│   └── services/
│       ├── seed.py        # Default pattern seeding
│       ├── monitor.py     # Elasticsearch polling logic
│       └── redirects.py   # Hop-by-hop redirect checking
├── admin-ui/              # React admin console
├── tests/                 # pytest suite
├── .env.example           # Config template (commit this)
└── pyproject.toml
```

## Security Notes

- **Never commit `.env`** — it holds real credentials and is gitignored.
- Commit only `.env.example` with placeholder values.
- The legacy `main.py` script containing hardcoded credentials has been removed;
  all configuration is read from environment variables / `.env`.
- The admin UI requires login — configure `ADMIN_USER`/`ADMIN_PASS` in `.env` before
  exposing to the internet. A static `API_KEY` can also be configured for programmatic
  access without Basic Auth.

## License

MIT
