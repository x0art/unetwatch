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

## Developing

### Backend tests

```bash
source .venv/bin/activate
pytest            # 20 tests covering the full CRUD + validation surface
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
│   │   └── monitor.py     # status + manual run
│   └── services/
│       ├── seed.py        # Default pattern seeding
│       └── monitor.py     # Elasticsearch polling logic
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
- The admin UI ships with no authentication by default — add a reverse-proxy
  (or app-level auth) in front of it when exposing to the internet.

## License

MIT
