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

## Network Traffic Monitor — NOC/SOC

The admin console is organized as a five-page NOC/SOC workflow —
**observe → click to filter → inspect → generate a rule → simulate & deploy**
(spec §7). Every visual element (Sankey node, metric card, log row) is
clickable and applies a global context filter without navigating away, so an
analyst can chase a host or domain from the Live Monitor straight through to a
deployed pattern.

### Information Architecture

```
Network Traffic Monitor
├── Live Log Monitor
│   └── Live Monitor — 4 KPI Metric Cards + Sankey (Sources → Patterns → Domains → Destinations)
│                      + Log Inspector + Inspection Drawer
├── Host Inspector
│   ├── Host lookup bar + Host Entity & Risk Card
│   ├── Visual Traffic Timeline & Anomaly Heatmap
│   ├── Top Destinations & Rule Matches
│   └── Chronological Kibana Request Logs (paginated)
├── Pattern Manager
│   ├── Summary Cards (Total Active / Flagged 24h / High-Risk / Pending Drafts)
│   ├── Search + Category / Action / Status filter bar
│   ├── Patterns table (edit / delete / bulk select)
│   └── Run Pattern Test — Live Kibana Simulation drawer (preview before Save & Deploy)
├── Analytics & Reports
│   ├── Range / Compare / Host Group controls
│   ├── 4 high-level metric cards
│   ├── Daily Bandwidth (area) + Daily Policy Enforcements (stacked bar)
│   ├── Top Bandwidth Domains + Top Denied Domains tables
│   └── Export CSV / PDF
└── System Settings
    ├── Kibana Connection (host, index pattern, auth) + Test Connection
    ├── Field Mapping (app attribute ↔ Kibana log field, sample values)
    ├── Alert Rules (DENY-ratio threshold, rolling window, webhook)
    └── User Access Control
```

### Page Inventory

| Page | Key Components | Source Files |
|------|----------------|--------------|
| Live Monitor | MetricCards (4 KPIs), SankeyDiagram (4-column, click-to-filter), LogInspector (live stream + action filter + export), InspectionDrawer (matched rule + quick actions) | `LiveMonitorPage.tsx`, `MetricCards.tsx`, `SankeyDiagram.tsx`, `LogInspector.tsx`, `InspectionDrawer.tsx` |
| Host Inspector | HostEntityCard (identity + risk score), TrafficTimeline (spike annotation), TopDestinations (domains + triggered patterns), host log table (paginated) | `HostInspectorPage.tsx`, `HostEntityCard.tsx`, `TrafficTimeline.tsx`, `TopDestinations.tsx` |
| Pattern Manager | PatternSummaryCards, PatternTable (search + category/action/status filters), PatternSimulationDrawer (Rule Definition → Run Pattern Test → Match Preview → Save & Deploy) | `PatternTable.tsx`, `PatternSummaryCards.tsx`, `PatternSimulationDrawer.tsx` |
| Analytics | Range/compare/host-group controls, 4 metric cards, TrendCharts (bandwidth area + enforcements stacked bar), two top tables, CSV/PDF export | `AnalyticsPage.tsx`, `TrendCharts.tsx` |
| System Settings | Kibana Connection form + Test Connection, FieldMapper (app attribute ↔ Kibana field, sample values), Alert Rules (threshold 5.0% / 15-min window + webhook) | `SystemSettingsPage.tsx`, `FieldMapper.tsx` |

Shared infrastructure: `contexts/FilterContext.tsx` (global click-to-filter
state + URL sync), `lib/echartsTheme.ts` (theme-aware ECharts color
resolution), `components/DataTable.tsx` (sortable/paginated tables), and
`lib/logRow.ts` (row accessors used by every page).

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
| `BLACKLIST_DIR`                   | `./data`                         | Directory for the static blacklist feed files (`urls.txt`/`ips.txt`) |
| `ADMIN_USER`                      | `admin`                          | Dashboard login username             |
| `ADMIN_PASS`                      | `changeme`                       | Dashboard login password             |
| `API_KEY`                         | _(empty)_                        | Static API key for programmatic use  |
| `CORS_ORIGINS`                    | `http://localhost:5173,...`      | Comma-separated allowed CORS origins |

> **Production:** set `APP_ENV=production` and provide a **strong `ADMIN_PASS`**,
> a **non-empty `API_KEY`**, and an explicit (non-localhost) `ELASTIC_HOST`.
> The app fails fast at startup otherwise.

## API

The API is documented interactively at `http://localhost:8000/docs` (Swagger UI).
All endpoints except `/health`, the auth flow, and the blacklist `.txt` feeds
require a valid `X-API-Key` header, Basic Auth, or a dashboard session token.
The feeds (`/api/blacklist/urls.txt` and `/api/blacklist/ips.txt`) are public
so external integrations (nginx, fail2ban, firewall scripts) can consume them
without credentials.

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
| GET    | `/api/blacklist/urls.txt`       | Public plain-text URL feed (real file) |
| GET    | `/api/blacklist/ips.txt`        | Public plain-text IP feed (real file)  |
| POST   | `/api/blacklist/`               | Add a blacklist entry              |
| POST   | `/api/blacklist/bulk`           | Add many blacklist entries at once |
| POST   | `/api/blacklist/bulk-delete`    | Delete many blacklist entries at once |
| DELETE | `/api/blacklist/{kind}/{value}` | Remove a blacklist entry           |
| POST   | `/api/query/`                   | Run an ad-hoc ES query             |
| GET    | `/api/logs/`                    | Monitor-log audit trail            |
| GET    | `/health`                       | Liveness + dependency status       |

### Pattern Simulation / Analytics / Settings (NOC/SOC)

| Method | Path                              | Description                                       |
|--------|-----------------------------------|---------------------------------------------------|
| POST   | `/api/patterns/simulate`          | Sandbox a wildcard/regex pattern against recent logs → `{matchCount, preview}` |
| GET    | `/api/analytics/summary`          | High-level usage metrics (volume, blocked, top host, peak time; optional previous-period compare) |
| GET    | `/api/analytics/bandwidth`        | Daily inbound/outbound bandwidth buckets           |
| GET    | `/api/analytics/enforcements`     | Daily ALLOW vs DENY enforcement buckets            |
| GET    | `/api/analytics/top-domains`      | Top bandwidth-consuming domains (volume + % total) |
| GET    | `/api/analytics/top-denied`       | Top denied target domains (blocks + primary rule)  |
| GET    | `/api/settings/kibana`            | Current Kibana connection form                     |
| PUT    | `/api/settings/kibana`            | Persist Kibana connection form                     |
| POST   | `/api/settings/test-connection`   | Ping the configured Kibana host with credentials   |
| GET    | `/api/settings/field-map`         | App-attribute ↔ Kibana-field mapping               |
| PUT    | `/api/settings/field-map`         | Persist the field mapping                          |
| GET    | `/api/settings/alerts`            | DENY-ratio threshold + webhook alert rules         |
| PUT    | `/api/settings/alerts`            | Persist alert rules                                |

The analytics endpoints share the `range` / `compare` / `hostGroup` query
params and aggregate the persisted findings table (falling back to live
Elasticsearch when the rich fields exist). `compare=previous` returns honest
previous-period deltas.

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
