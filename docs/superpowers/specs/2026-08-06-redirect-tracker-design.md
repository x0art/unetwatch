# ELK Monitoring — URL Redirect Tracker

**Date:** 2026-08-06
**Status:** Approved (user) — spec written, awaiting review
**Scope:** FastAPI backend + React admin UI (`admin-ui/`)

## Goal

A new page that manages URLs which redirect / change target over time. Tracked URLs are
periodically re-checked with an HTTP request; redirect destinations are auto-appended to the
list and monitored transitively (url1 → url2 → url3 ⇒ all three are watched). When a URL's
target changes (url1 used to point at url2, now points at url3), the change is recorded and
the URL relations are visualized as a layered flow graph like the Traffic Graph. URLs can
also be added from the Findings page.

## Decisions (user-confirmed)

- **Detection:** hybrid — an automatic background checker plus manual add + "Check now".
- **History:** full edge history (`first_seen_at` / `last_seen_at`); the graph shows active
  edges with a toggle to render historical (deactivated) edges dashed.
- **Scope:** independent tracking — findings and block patterns are untouched.
- **Graph:** layered flow in the Traffic Graph style (sources column left, destinations right).

## Backend

### DB (`app/database.py`)

Two new tables, created in `init_db()`:

```sql
CREATE TABLE IF NOT EXISTS tracked_urls (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    url TEXT NOT NULL UNIQUE,
    source TEXT NOT NULL DEFAULT 'manual',   -- 'manual' | 'finding' | 'auto'
    status TEXT NOT NULL DEFAULT 'unknown',  -- 'unknown' | 'ok' | 'redirect' | 'error'
    http_status INTEGER,
    final_url TEXT,
    last_checked_at TIMESTAMP,
    last_error TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS redirect_edges (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source_url TEXT NOT NULL,
    target_url TEXT NOT NULL,
    http_status INTEGER NOT NULL,
    first_seen_at TIMESTAMP NOT NULL,
    last_seen_at TIMESTAMP NOT NULL,
    active INTEGER NOT NULL DEFAULT 1,
    UNIQUE (source_url, target_url)
);
```

`UNIQUE(source_url, target_url)` + upsert means repeated checks update `last_seen_at` instead
of duplicating rows. `active` marks the currently-live edge; old edges are kept for history.

### Config (`app/config.py`)

```python
redirect_check_interval_minutes: int = 60
redirect_timeout_seconds: int = 10
redirect_max_hops: int = 10
```

### Service (`app/services/redirects.py`)

- `is_valid_url(value) -> bool` — must start with `http://` or `https://`, no whitespace.
- `async check_url(session, url) -> CheckResult` — HEAD request with `allow_redirects=False`,
  follow the `Location` header hop-by-hop (relative targets resolved with `urljoin`), GET
  fallback when HEAD returns 405/501, max hops cap, loop protection, timeout from settings.
  Returns `(hops, final_status, final_url, error)` where `hops` is a list of
  `(source_url, target_url, http_status)` tuples.
- `async check_all(db) -> dict` — for every tracked URL: run `check_url`, then:
  1. Upsert each detected hop edge (set `active=1`, `last_seen_at=now`, keep `first_seen_at`).
  2. Deactivate edges from that source no longer observed (`active=0`).
  3. Auto-add every hop target to `tracked_urls` (`source='auto'`, `INSERT OR IGNORE`) so the
     whole chain is monitored transitively.
  4. Update the tracked row: `status`, `http_status`, `final_url`, `last_checked_at`,
     `last_error`. Status rules: no hops + 2xx/3xx → `ok`; hops → `redirect`; network error /
     timeout / bad status → `error`.
- `async check_one(db, url)` — same for a single URL (used by "Check now" on one entry).

`aiohttp` is already a dependency (used by `send_logs`) — no new libraries.

### Scheduler (`app/main.py`)

- Add `redirects.router` (prefix `/api/redirects`) mounted with `verify_admin`.
- Add a second APScheduler job alongside `fetch_logs`: `check_all`, interval
  `settings.redirect_check_interval_minutes`, `kwargs={"minutes": ...}`.

### Routes (`app/routes/redirects.py`)

- `GET /api/redirects/` — paginated list `{items, total}`. Query: `search` (url LIKE),
  `limit` (1–500), `offset`, `sort_by` (`id|url|source|status|last_checked_at`),
  `sort_order` (`asc|desc`), all regex/range validated. Each item includes a `history_count`
  = number of distinct targets the URL has ever pointed at (from `redirect_edges`).
- `POST /api/redirects/` — body `{url, source}` (`source` ∈ `manual|finding`); 400 invalid
  URL, 409 duplicate, 201 with the created row.
- `DELETE /api/redirects/{id}` — stop tracking (edges kept for history), 404 if absent.
- `POST /api/redirects/check` — body `{url?}`; checks all tracked URLs (or one). Returns
  `{checked: N, updated: [...]}` with per-URL results.
- `GET /api/redirects/graph` — `{nodes, links}`: node `id` is the URL string itself (URLs
  are unique in `tracked_urls`, and `redirect_edges` already stores raw URLs), plus `label`,
  `status`, `history_count`. Links are all edges as `{source: url, target: url, http_status,
  active}`. The client omits links whose endpoints are not in the node list (same guard as
  the Traffic Graph), so deleting a tracked URL removes it and its edges from view.
- `GET /api/redirects/{id}/history` — all edges for one URL:
  `{url, edges: [{target_url, http_status, first_seen_at, last_seen_at, active}]}`.

## Frontend

### `api.ts`
Types `TrackedUrl`, `RedirectEdge`, `RedirectGraph`; functions `listTrackedUrls`,
`addTrackedUrl`, `deleteTrackedUrl`, `checkRedirects`, `getRedirectGraph`,
`getUrlRedirectHistory`.

### `Sidebar.tsx`
Add `"redirects"` to the `View` union and a nav item (lucide `GitBranch`).

### `App.tsx`
Route `view === "redirects"` → `<RedirectsPage />`.

### `RedirectsPage.tsx` (new)
- Header: title, add-URL input, **Check now** button, Refresh.
- Summary chips: total tracked / redirecting / ok / errors.
- Sortable table: URL, status pill (ok=success, redirect=warning, error=danger,
  unknown=muted), HTTP status, current target (active edge target or `final_url`), source
  badge (`manual`/`finding`/`auto`), last checked, history count, actions (history dialog,
  delete).
- **Graph section**: layered two-column SVG in the Traffic Graph style — sources (URLs with
  outgoing active edges) on the left, destinations on the right; arrow edges whose width
  scales with freshness of the relation (or uniform), hover to highlight neighbors, click a
  node to filter the table by that URL. A **"show historical edges"** toggle renders
  deactivated edges dashed with reduced opacity.
- **History dialog**: lists every target the URL has pointed at with
  first-seen / last-seen / active badge.

### `FindingsPage.tsx`
- Fetch the tracked-URL index once (reuse `listTrackedUrls({limit: 5000})`) like the
  whitelist/blacklist indexes.
- New **Track** button per row (lucide `CornerUpRight`): adds `f.url` to the tracker,
  disabled + "tracked" indicator once present.

## Tests (`tests/test_redirects.py`)

- Add URL: valid → 201; duplicate → 409; invalid (no scheme, whitespace) → 400/422;
  unauthenticated → 401.
- List: empty, search hit/miss, sort + pagination.
- Delete: removes from tracked list but keeps `redirect_edges` rows.
- Check endpoint (monkeypatched `check_url`): produces hops → edges upserted, targets
  auto-added, stale edges deactivated, tracked row status/final_url updated; no hops → `ok`.
- Graph: empty shape; after seeded edges → nodes + links with `active` flag.
- History endpoint: multiple targets over time, correct `active` flags.

## Validation gates

1. `pytest` — all pass (including existing suites).
2. `cd admin-ui && npx tsc --noEmit` — zero type errors.
3. `npm run build` — production build succeeds.
4. `npm run lint` — oxlint clean.
5. Code review (code-reviewer-deepseek-flash) before commit.
