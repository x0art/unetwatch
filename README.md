# uNetWatch

[![CI](https://github.com/x0art/unetwatch/actions/workflows/ci.yml/badge.svg)](https://github.com/x0art/unetwatch/actions/workflows/ci.yml)
[![PyPI](https://img.shields.io/pypi/v/unetwatch)](https://pypi.org/project/unetwatch/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

**uNetWatch** is a FastAPI + React service that watches Elasticsearch proxy logs
for URLs matching blocked patterns, turns hits into actionable findings, and
tracks redirect chains hop-by-hop — all through a single-process web admin
console.

```
[] url1  final_url1 []
[] url2  [] url2_1  [] url2_2  final_url2 []
```

## Features

- **Elasticsearch polling** — periodically queries ES for log entries matching
  blocked URL patterns and forwards aggregated findings to a webhook.
- **Pattern management** — full CRUD for block and whitelist patterns, stored in
  SQLite (no hardcoded lists). Bulk import supported.
- **Layered redirect tracking** — follows redirect chains hop-by-hop, auto-adds
  every destination to the watch list, records when a URL's target changes over
  time, and visualizes the chains as an alluvial diagram (not just the final hop).
- **Admin console** — a clean web dashboard built with React + TypeScript +
  Tailwind, served directly by FastAPI (no separate server, no CDN).
- **Authentication** — dashboard login with session tokens; API-key or Basic
  auth for programmatic access.
- **Poll countdown** — real-time countdown widget showing time until the next
  ES query.
- **Serve API + UI from one process** — the built frontend is served at `/`.

## Tech Stack

| Layer      | Technology                                        |
|------------|---------------------------------------------------|
| Backend    | FastAPI, Uvicorn, Pydantic                        |
| Database   | SQLite (aiosqlite)                                |
| Scheduler  | APScheduler                                       |
| ES client  | elasticsearch (async)                             |
| Frontend   | React + TypeScript, Vite, Tailwind CSS v4, Radix  |

## Quickstart

### Docker (recommended)

```bash
# App only (uses an existing Elasticsearch — set ELASTIC_HOST/... via env or .env)
docker compose up --build

# App + a bundled single-node Elasticsearch (turnkey demo)
docker compose --profile es up --build
```

Open <http://localhost:8000> — the admin console loads at `/`, API docs at `/docs`.

### Manual

```bash
# 1. Install & configure
python3 -m venv .venv
source .venv/bin/activate
pip install -e ".[dev]"
cp .env.example .env   # then edit credentials

# 2. Build the admin UI (Node 20+)
cd admin-ui
npm install
npm run build
cd ..

# 3. Run
uvicorn app.main:app --host 0.0.0.0 --port 8000
```

Or, once installed as a package: `unetwatch`.

## Configuration

Configuration lives in the `.env` file (copy from `.env.example`). All variables
are optional and have safe defaults for development.

| Variable                          | Default                          | Description                          |
|-----------------------------------|----------------------------------|--------------------------------------|
| `APP_ENV`                         | `development`                    | `development` / `production`; production refuses weak/default creds |
| `ELASTIC_HOST`                    | `http://localhost:9200`          | Elasticsearch endpoint               |
| `ELASTIC_INDEX`                   | `logstash-proxy-*`               | Index pattern to search              |
| `ELASTIC_USER`                    | `elastic`                        | ES username                          |
| `ELASTIC_PASS`                    | `changeme`                       | ES password                          |
| `WEBHOOK_URL`                     | _(empty)_                        | Webhook to POST aggregated findings  |
| `POLL_INTERVAL_MINUTES`           | `10`                             | How often to poll ES                 |
| `ES_QUERY_SIZE`                   | `5000`                           | Max documents per ES query           |
| `REDIRECT_CHECK_INTERVAL_MINUTES` | `60`                             | How often to re-check tracked URLs   |
| `REDIRECT_TIMEOUT_SECONDS`        | `10`                             | HTTP timeout per redirect hop        |
| `LOG_RETENTION_DAYS`              | `30`                             | Prune monitor-log rows older than N days |
| `LOG_MAX_ROWS`                    | `1000`                           | Max monitor-log rows kept (newest wins) |
| `DATABASE_URL`                    | `sqlite:///./unetwatch.db`       | SQLite location                      |
| `ADMIN_USER`                      | `admin`                          | Dashboard login username             |
| `ADMIN_PASS`                      | `changeme`                       | Dashboard login password             |
| `API_KEY`                         | _(empty)_                        | Static API key for programmatic use  |
| `CORS_ORIGINS`                    | `http://localhost:5173,...`      | Comma-separated allowed CORS origins |

> **Production:** set `APP_ENV=production` and provide a **strong `ADMIN_PASS`**,
> a **non-empty `API_KEY`**, and an explicit (non-localhost) `ELASTIC_HOST`.
> The app fails fast at startup otherwise.

## API

The API is documented interactively at `http://localhost:8000/docs` (Swagger UI).
All endpoints except `/health` and the auth flow require a valid `X-API-Key`
header, Basic Auth, or a dashboard session token.

### URL Patterns

| Method | Path                          | Description                          |
|--------|-------------------------------|--------------------------------------|
| GET    | `/api/patterns/`              | List patterns (filter/search/paginate) |
| GET    | `/api/patterns/{id}`          | Get a single pattern                 |
| POST   | `/api/patterns/`              | Create a pattern                     |
| PUT    | `/api/patterns/{id}`          | Update a pattern                     |
| DELETE | `/api/patterns/{id}`          | Delete a pattern                     |
| POST   | `/api/patterns/bulk`          | Bulk import patterns                 |
| GET    | `/api/patterns/stats/counts`  | Pattern counts by type               |

Pattern types: `block` (URLs to flag) and `whitelist` (URLs to allow). Patterns
are **substring globs**, not regexes: `*` matches any run of characters, `?`
matches a single character, and everything else is literal.

### Monitor

| Method | Path                 | Description                  |
|--------|----------------------|------------------------------|
| GET    | `/api/monitor/status`| Service & pattern counts     |
| POST   | `/api/monitor/run`   | Trigger a manual ES poll     |

### Redirects

| Method | Path                     | Description                               |
|--------|--------------------------|-------------------------------------------|
| GET    | `/api/redirects/`        | List tracked URLs (search/sort/paginate)  |
| POST   | `/api/redirects/`        | Add a URL to track                        |
| DELETE | `/api/redirects/{id}`    | Stop tracking a URL (history is kept)     |
| POST   | `/api/redirects/check`   | Re-check all tracked URLs (or a subset)   |
| GET    | `/api/redirects/graph`   | Full chain graph (every hop, active flag) |
| GET    | `/api/redirects/{id}/history` | Per-URL redirect history             |

### Findings / Blacklist / Query / Logs

| Method | Path                            | Description                        |
|--------|---------------------------------|------------------------------------|
| GET    | `/api/findings/`                | List persisted findings            |
| GET    | `/api/findings/graph`           | Client → server → URL flow graph   |
| GET    | `/api/blacklist/`               | List blacklisted URLs / IPs        |
| POST   | `/api/blacklist/`               | Add a blacklist entry              |
| DELETE | `/api/blacklist/{kind}/{value}` | Remove a blacklist entry           |
| POST   | `/api/query/`                   | Run an ad-hoc ES query             |
| GET    | `/api/logs/`                    | Monitor-log audit trail            |
| GET    | `/health`                       | Liveness + dependency status       |

## Health

`GET /health` returns liveness plus per-dependency status:

```json
{
  "status": "ok",
  "version": "1.0.0",
  "dependencies": {
    "elasticsearch": "ok",
    "database": "ok"
  }
}
```

## Security

- **Auth:** dashboard sessions (token), `X-API-Key`, or Basic Auth.
- **Production fail-fast:** weak/default `ADMIN_PASS`, empty `API_KEY`, or a
  localhost `ELASTIC_HOST` prevent startup when `APP_ENV=production`.
- **CSP + headers:** strict Content-Security-Policy (with an inline-script hash),
  `X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy`.
- **Request correlation:** every response carries an `X-Request-ID`, echoed in
  structured request logs.

## Development

```bash
# Backend
uv sync --dev
uv run ruff check app/ tests/
uv run pytest -q

# Frontend
cd admin-ui
npm install
npm run build
```

## Contributing

Contributions are welcome! Please open an issue for bugs/ideas or a pull
request. Keep changes focused, add tests, and run the linter.

## License

[MIT](LICENSE) © 2026 Yusuf Umar
