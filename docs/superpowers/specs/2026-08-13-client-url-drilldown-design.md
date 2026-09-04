# Per-Client URL Drill-Down — Design Spec

**Date:** 2026-08-13
**Status:** Approved
**Scope:** Frontend (`admin-ui` Traffic page) + backend (`app/routes/findings.py`, `app/routes/query.py`, `app/services/monitor.py`, `app/database.py`)

## 1. Goal

Let the user pick one client IP and see **which URLs that client accessed, and how many times each** — as a fully animated radial visualization. The question this answers is: *"client_ip 10.0.0.7 → which URLs, in what proportions?"*

The feature lives on the **Traffic page** (approved decision). It drills into data that already exists (the persisted `findings` table — now indexed on `url`/`base_url` — and the live ES query path) and adds **no new dependencies** (ECharts is already the charting layer; no new Python packages).

## 2. Context — what exists today

| Surface | What it shows |
|---|---|
| Traffic page (`GraphPage`) | Sankey client → server → host-merged URL, Top URLs / Top client IPs ranked tables, "Access flows" triple table |
| Query page | Live-ES flow client → **host** (not full URLs), Top URLs / Top IPs, documents table |
| Findings page | Searchable persisted table (`client_ip`, `url`, `base_url`) |

There is **no per-client URL breakdown with counts** anywhere today. The data lives in the persisted `findings` table (per the perf pass it now has `url`/`base_url` indexes) and in ES (via `build_logs_query` + `apply_filters` in `app/services/monitor.py`).

Two data sources are used in this app today: **persisted findings** (Traffic page, `/api/findings/graph`) and **live ES** (Query page, `/api/query/run`, degrades to `es_online: false`). The drill-down supports **both**, user-toggleable.

## 3. Interaction model

### 3a. Drill-down bar (top of Traffic page, below the header)

A new control strip rendered only when the user has **not** selected a client:

- **Searchable client picker** — autocomplete over client IPs (sourced from the new `top-clients` endpoint, `search=` narrows). Each suggestion shows the IP and its total access count. Selecting one enters drill-down mode.
- **Top clients list** — the existing "Top client IPs" `RankedTable` becomes **clickable** (row click = select that client). This is the fastest path to the big offenders.
- The drill-down bar carries the filters (3c) once a client is selected.

### 3b. Focused mode (client selected)

Selecting a client **replaces** the aggregate Traffic view (approved decision):

- The sankey panel, Top URLs panel, and Top client IPs panel are hidden.
- In their place: the **radial diagram** (Section 4) + the **Access flows table** pre-filtered to the selected client.
- The four stat cards and the page header stay (they describe the global window and remain useful context).
- A **Clear** button in the drill-down bar exits focused mode and restores the aggregate view.

### 3c. Filters (all re-query + re-animate the diagram)

| Filter | Values | Applies to |
|---|---|---|
| Source | **Persisted findings** (default) ⟷ **Live ES** | both paths |
| Time window | 24h / 7d / 30d / All | findings `log_timestamp`, ES `@timestamp` |
| URL substring | free text | `url` `LIKE` in SQL, ES `q`-param |
| Top-N cap | 6 / 12 (default) / 24 | number of URL satellites rendered |

All four filters reshape the diagram; every change refetches (or hits the TTL cache for identical ES ticks — the 2s cache from the perf pass already covers duplicate live ticks) and the radial re-animates its data-change transition.

### 3d. URL interaction

- **Hover** a URL node: that node's edge highlights (others dim), tooltip shows the **full URL** + exact access count.
- **Click** a URL node: the Access flows table below narrows to that URL — a removable **URL chip** appears in the drill-down bar (chip × clears it). The chip is the single source of the table filter.
- Clicking the URL chip's clear (or re-clicking the node) restores the full per-client table.

## 4. Radial diagram (`RadialDiagram.tsx`, new)

Built on **ECharts** — same pattern as `SankeyDiagram.tsx`: tree-shaken `echarts/core` registration, theme-aware palette via `resolveColor` (reuse the `resolveAllColors` cache pattern), data-change diff to skip no-op `setOption`, expo-out easing, and a `prefers-reduced-motion` guard that disables ECharts animation + edge trails.

### Layout (deterministic, no force simulation)

- **Hub node** = the client IP, fixed at center, sized by total accesses, labeled with the IP + count.
- **URL satellites** = up to top-N URLs, positioned on a circle around the hub at fixed, computed coordinates (angle sorted by count desc, largest at top) with `layout: "none"` and every node `fixed: true`. Deterministic layout keeps the diagram stable across refreshes — no jitter, and identical data animates nothing.
- **Connection lines**: one edge per URL, hub → satellite. **Line thickness ∝ count** (min 1px, scaled by the largest count), color = the layer color scale (URL host / blocked-tone), slight `curveness` for organic feel, gradient from hub color to node color.
- **Animated flow trail**: a `lines` series overlay (same endpoints) with ECharts' `effect: { show: true, trailLength, period }` for a continuous flowing-dash motion on every edge — the "cinematic" ask. Effect is **disabled under reduced motion** and disabled when the graph is large (> 24 edges) to protect perf.

### Entrance / data-change animation

- First render: nodes **pop in** (scale 0 → 1, staggered by rank), edges **draw hub → outward**, opacity fade. All tween, expo-out (`cubicOut`).
- Data change (filter/window/refresh): ECharts animates the same transform/opacity transition via `animationDuration` + `animationEasingUpdate`; no layout work (fixed positions).
- **Reduced motion** (`matchMedia("(prefers-reduced-motion: reduce)")`): `animation: false` at init, no trail effect, instant render.

### Behavior

- Hover URL node → `emphasis: { focus: "adjacency" }` + tooltip (full URL, count). `stateAnimation: { duration: 0 }` so hover state snaps (same fix as the sankey).
- Click URL node → bubble up via `onSelectUrl(url)` prop; `GraphPage` owns the URL-chip filter state.
- Height: content-derived like the sankey (a function of node count, clamped).

## 5. Backend API

All new endpoints are read-only, reuse existing helpers, add **no dependencies**, and keep `ruff check` + `pytest` green.

### 5a. `GET /api/findings/top-clients?search=&limit=` (persisted)

Top client IPs by total access count — powers the picker autocomplete **and** the clickable Top clients table.

- `GROUP BY client_ip` with `COUNT(*)`, `ORDER BY count DESC, client_ip`, `LIMIT ?`.
- `search` → `client_ip LIKE ?` substring filter.
- Whitelist exclusion: same `_whitelist_sql_clauses` + Python `re.search` fallback as `findings_graph` (the clauses also filter the grouped query before aggregation).
- Response: `{ "items": [{ "client_ip": str, "count": int }] }` (count = total accesses in window, not distinct URLs).

### 5b. `GET /api/findings/client/{ip}?minutes=&search=&limit=` (persisted)

Per-URL breakdown for one client.

- `WHERE client_ip = ? [AND log_timestamp >= ?] [AND url LIKE ?]` + whitelist clauses, `GROUP BY url, base_url`, `ORDER BY count DESC`, `LIMIT ?`.
- `minutes` → `log_timestamp >= strftime('%Y-%m-%dT%H:%M:%SZ', 'now', '-{minutes} minutes')`; omit when "All".
- Python `re.search` whitelist fallback still runs on the grouped rows (parity with `findings_graph`).
- Response shape (shared with 5c — **one shape, two sources**):

```json
{
  "client_ip": "10.0.0.7",
  "source": "findings",
  "total_accesses": 482,
  "es_online": true,
  "urls": [
    { "url": "http://evil.example/a", "base_url": "evil.example", "count": 214, "last_seen": "..." }
  ]
}
```

- `urls` capped at `limit` (the top-N cap); empty client → `urls: []`, `total_accesses: 0` (200, not 404).

### 5c. `GET /api/query/client?ip=&minutes=&search=&limit=` (live ES)

Same response shape with `source: "es"`. Implementation reuses the query path:

- Extend `build_logs_query` with an optional `client_ip` term filter (a `bool.filter` `term` clause on `client_ip`, additive with the existing block-pattern `must` + window range).
- New service fn `run_client_query(ip, minutes, search, limit)` in `app/services/monitor.py`: `build_logs_query(..., client_ip=ip)`, `apply_filters`, then `df["url"].value_counts()` + per-group `base_url`/`last_seen`. Whitelist/ALLOW filtering identical to `run_query`.
- ES unreachable → `es_online: false`, empty `urls` (graceful, no 500 — same contract as `/api/query/run`).

### 5d. Indexes (in `init_db`, `app/database.py`)

The perf pass indexed `url`/`base_url`. Add the two this feature's SQL depends on:

```python
await db.execute("CREATE INDEX IF NOT EXISTS idx_findings_client_ip ON findings(client_ip)")
await db.execute("CREATE INDEX IF NOT EXISTS idx_findings_log_timestamp ON findings(log_timestamp)")
```

(`GROUP BY client_ip` + the window `WHERE` were both scans without these.)

## 6. Frontend changes

### `admin-ui/src/api.ts`

Three typed calls: `getTopClients({search, limit})`, `getClientBreakdown(ip, {minutes, search, limit})`, `runClientQuery(ip, {minutes, search, limit})` — plus the `ClientBreakdown` / `ClientUrlCount` / `TopClient` interfaces. Follow the existing `request()` wrapper + `URLSearchParams` pattern.

### `admin-ui/src/components/GraphPage.tsx`

- New drill-down state: `selectedClient: string | null`, `source: "findings" | "es"`, `windowMinutes: number | null` (1440 / 10080 / 43200 / null), `urlFilter: string | null`, `cap: 6 | 12 | 24`.
- When `selectedClient` is null: current aggregate view, with the Top client IPs table rows made clickable and the picker bar rendered.
- When set: fetch the breakdown (5b or 5c depending on source) on a `useEffect` keyed on the full filter set; render `RadialDiagram` + the Access flows table in place of the sankey/ranked panels.
- Access flows table in focused mode: driven by the same breakdown payload (single source of truth — the table and the radial always agree), per-URL rows `{url, base_url, count, last_seen}`, module-scope columns (per the perf-pass convention: stateful cells read synced module handles), `ListActionCell` on base_url, URL click from the radial or the row sets `urlFilter`. This is the approved "existing Access flows table pre-filtered to the client", now fed by the per-client breakdown instead of the global triple list.
- Auto-refresh: only the **active** mode refetches on the interval (aggregate graph vs breakdown), same `useAutoRefresh` + keep-previous-data pattern.
- Loading / error / empty states reuse `Skeleton` / `EmptyState` as the page already does.

### New `RadialDiagram.tsx`

ECharts `GraphChart` + `LinesChart` (tree-shaken core registration), the `resolveAllColors` cache pattern from `SankeyDiagram`, deterministic circular layout, trail overlay, adjacency emphasis, click callback. **No framer-motion here** — ECharts owns its canvas animation; reduced-motion is handled via `matchMedia` + `animation: false`.

### `app/database.py` migration + routes wiring

Indexes in `init_db` (5d); two new findings routes + one new query route registered on the existing routers.

## 7. Animation discipline (inherited from the perf/motion pass)

- ECharts animates only `transform`/`opacity` on the canvas; no DOM layout churn, no `layout` prop, no springs — tween/expo-out everywhere.
- `prefers-reduced-motion` is the single source of truth: `matchMedia` disables ECharts `animation` + trail effects; framer's existing `MotionGate` already covers the DOM chrome (drill-down bar).
- Deterministic fixed layout → no force-simulation jitter, no `setOption` on identical data (data-change diff).
- Below-the-fold radial container gets `.cv-auto` (existing utility) so off-screen paint is skipped.
- No new dependencies on either side.

## 8. Testing & verification

**Backend** (new `tests/test_client_breakdown.py`, reusing `client` + `db_path` fixtures, pytest-asyncio auto mode):

- `top-clients`: sorted by count desc, respects `search` + `limit`, whitelisted URLs excluded.
- `client/{ip}`: per-URL counts correct; `minutes` window filters; `search` substring filters; `limit` caps; empty client → 200 with empty `urls`; whitelisted URL excluded.
- `/api/query/client`: ES unreachable → `es_online: false`, empty urls, no 500.
- `ruff check` clean; full `pytest` green.

**Frontend**: `npm run build` + `npm run lint` clean; headless-Chrome smoke over the drill-down flow — pick a client from the picker, radial renders with visible hub→URL lines, click a URL node filters the table + shows the chip, clear returns to the aggregate view; repeat with reduced-motion emulation (no animation, everything instant).

## 9. Out of scope

- Editing/annotating the diagram (blacklist/whitelist actions stay in the table via `ListActionCell`).
- Multi-client comparison or any aggregate-per-client table beyond the clickable top-N list.
- Server-side pagination of the per-client table (the top-N cap bounds it).
- Re-theming, new charting libraries, or changes to the ES index mappings.
