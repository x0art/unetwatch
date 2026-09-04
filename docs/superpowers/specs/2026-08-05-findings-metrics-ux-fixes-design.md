# ELK Monitoring — Findings Persistence, URL Metrics & UX Fixes

**Date:** 2026-08-05
**Status:** Approved (user) — implementing
**Scope:** FastAPI backend + React admin UI (`admin-ui/`)

## Goal

Resolve six items in one pass:

1. **fix** Findings never show data (matches are only POSTed to the webhook, never stored).
2. **feat** Manual run range selector (default 1m, up to 10m) — manual runs only.
3. **chore** Status pill shows **Online** when Elasticsearch is reachable, **Idle** otherwise.
4. **fix** Sidebar theme toggle + logout disappear on tall pages (Patterns table).
5. **feat** Pattern table columns sortable.
6. **feat** Dashboard URL metrics charts: how many times each flagged URL was accessed + who accesses them most.

## Decisions (user-confirmed)

- Findings: **store locally in SQLite + new API endpoint**.
- Metrics location: **Dashboard page**.
- Metrics scope: **flagged URLs only** (same block-pattern + whitelist + `ALLOW` filter as findings).
- Charting: **hand-rolled CSS bars** (no new dependencies).

## Backend

### DB (`app/database.py`)
New `findings` table:

```sql
CREATE TABLE IF NOT EXISTS findings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    client_ip TEXT NOT NULL,
    url TEXT NOT NULL,
    base_url TEXT NOT NULL,
    log_timestamp TEXT NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (client_ip, url, log_timestamp)
)
```

`UNIQUE` + `INSERT OR IGNORE` dedupe overlapping poll windows.

### Service (`app/services/monitor.py`)
- `fetch_logs(minutes: int = 10)` — range becomes `now-{minutes}m`; scheduler passes
  `poll_interval_minutes`, manual run passes the selected value.
- Persist each filtered match (`store_findings`) after the whitelist/`ALLOW` filter and
  before webhook delivery; DB errors never break webhook delivery.
- `build_es_client(settings, *, timeout, retry_on_timeout, max_retries)` helper shared by
  `fetch_logs`, `is_es_online()`, and `fetch_metrics()`.
- `is_es_online() -> bool` — short-timeout `es.ping()`.
- `fetch_metrics(minutes) -> dict` — same filter as findings; aggregates in pandas:
  `total_requests`, `unique_ips`, `top_urls` (10), `top_ips` (10), `es_online`.

### Routes
- **`app/routes/findings.py`** (new): `GET /api/findings/` →
  `{ items: [...], total: N }` with `limit` (1–500), `offset`, `search` (client_ip/url/base_url LIKE).
  Newest first. Registered with `verify_admin`.
- **`app/routes/monitor.py`**:
  - `GET /api/monitor/status` — adds `es_online: bool` and `findings_count: int`; uses
    `settings.poll_interval_minutes` instead of hardcoded 10; keeps `status: "active"`.
  - `POST /api/monitor/run?minutes=N` — default **1**, `ge=1 le=10` (422 outside).
  - `GET /api/monitor/metrics?minutes=N` — default 60, `ge=1 le=1440`.
- **`app/routes/patterns.py`** — `list_patterns` gains `sort_by`
  (`id|pattern|pattern_type|created_at`, default `id`) and `sort_order` (`asc|desc`, default `desc`),
  both regex-validated; interpolated into `ORDER BY` only after validation.

## Frontend

### `api.ts`
- `MonitorStatus` += `es_online: boolean`, `findings_count: number`.
- `Finding` → `{ id, client_ip, url, base_url, log_timestamp, created_at }`.
- `getFindings(params)` → `{ items, total }` (replaces stub).
- `triggerManualRun(minutes?)`.
- `getMonitorMetrics(minutes)`.
- `listPatterns` params += `sort_by`, `sort_order`.

### `Sidebar.tsx`
`<aside>` gains `md:h-screen md:sticky md:top-0` so the footer (theme toggle + logout) stays
pinned in the viewport regardless of main-content height.

### `PatternTable.tsx`
Clickable column headers (ID, Pattern, Type, Created) with lucide asc/desc/neutral arrows;
server-side sort via API params; resets to page 0 on sort change.

### `FindingsPage.tsx`
Real table (ID, Client IP, URL, Base URL, Detected), debounced search, `Pagination` with `total`.

### `DashboardPage.tsx`
- Status pill: green **Online** when `es_online`, amber **Idle** otherwise.
- Findings card: live total (`status.findings_count`) + "View findings" → navigates to Findings.
- Manual Run card: range `Select` (1–10m, default 1m) sent with the run.
- New **URL Metrics** section: window `Select` (15m/1h/6h/24h), stat chips (total requests,
  unique IPs), two animated horizontal bar charts — Top URLs & Top client IPs. Refetches when
  stats refresh / after manual run. Graceful "Elasticsearch unreachable" / "no flagged traffic"
  states.

### `App.tsx`
- Pass `onNavigate` to `DashboardPage`.
- `handleManualRun(minutes)` forwards the selected range.

### `index.css`
Add `metric-bar` animation keyframes (grow from 0 width) for the bar charts.

## Tests (`tests/test_patterns.py` additions)
- `GET /api/findings/` empty + after direct insert + search/no-match.
- `POST /api/monitor/run?minutes=0` / `minutes=11` → 422 (no ES dependency).
- `GET /api/patterns/?sort_by=pattern&sort_order=asc` ordering; invalid `sort_by` → 422.
- `GET /api/monitor/status` still `active`, now includes `es_online` + `findings_count`.
- `GET /api/monitor/metrics` shape (env-agnostic: no assertion on `es_online` value).

## Validation gates
1. `pytest` — all pass.
2. `cd admin-ui && npx tsc --noEmit` — zero type errors.
3. `npm run build` — production build succeeds.
4. `npm run lint` — oxlint clean.
5. Code review (code-reviewer-deepseek-flash) before commit.
