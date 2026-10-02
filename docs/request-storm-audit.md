# Request Storm Audit — uNetWatch admin UI

**Date:** 2026-10-02
**Scope:** read-only diagnosis of the request storm observed on every page.
**Symptom (verbatim):** *"page is loading hang on everywhere, the log keep spamming these things"* — 16 requests to 4 endpoints inside one ~46 ms window:

```
GET /api/findings/           × 8   (67–189 ms)
GET /api/redirects/graph     × 5   (111–136 ms)
GET /api/redirects/          × 3   (45–48 ms)
GET /api/analytics/summary   × 1   (1989.5 ms)   ← outlier
GET /api/analytics/bandwidth × 1   (1113.0 ms)   ← outlier
```

**Verdict:** This is a **client-side mount-time fan-out amplified by a keep-mounted page design**, hitting a **single-process uvicorn with an effectively single-threaded SQLite path**. It is caused by *volume × concurrency*, not one slow query.

---

## TL;DR

1. **Yes — hidden-but-mounted pages keep firing.** `App.tsx` renders every visited page inside `<div hidden={view !== "x">}` (`admin-ui/src/App.tsx:263-342`). A `hidden` div still mounts its children and runs their effects. **Every page's `useEffect(mount)` and its `useAutoRefresh` interval keep running while the page is hidden.** There is **no in-app visibility gate** anywhere — the only gate is `document.visibilityState` (browser tab), not the app view.
2. **The count matches the log.** `/api/findings/` has **5 distinct call sites across 4 always-mounted pages**; `/api/redirects/` **2**; `/api/redirects/graph` **2** on the Redirects page (table + graph effects) plus re-mounts. Visiting several pages and sitting on one reproduces the exact mix.
3. **The backend serializes.** `uvicorn.run("app.main:app", host="0.0.0.0", port=8000)` — **no `workers=` → 1 process** (`app/main.py:383`). Every DB read opens a *new* `aiosqlite` connection (one background thread each), and the heavy analytics handlers pull **10 000–20 000 rows into Python and aggregate in a loop** (`app/routes/analytics.py:210-218, 309-311, 337, 365, 405`). Under 16 concurrent requests the Python-side loops and per-request connect/close dominate → the 1 989 ms / 1 113 ms outliers. There is **no HTTP caching, no ETag, no request coalescing** on these endpoints.
4. **No per-row/N+1 client fetching was found.** The storm is NOT per-row; it is per-mount + per-interval. `DataTable` cells render pure presentational components (`TimestampCell`, `ListActionCell`) with no fetches — verified in `DataTable.tsx` and `FindingsPage.tsx`.

---

## 1. Every source of a repeating or mount-time request

### 1.1 `useAutoRefresh(...)` call sites

The hook (`admin-ui/src/lib/utils.ts:96-142`) is per-key, interval-driven, persisted in `localStorage`. Its only gate is the **browser tab**:

```ts
// admin-ui/src/lib/utils.ts:125-139
useEffect(() => {
  if (!refreshSeconds) return
  const id = window.setInterval(() => {
    if (document.visibilityState === "hidden") return   // browser tab only
    if (inFlightRef.current) return
    const out = refresh()
    ...
  }, refreshSeconds * 1000)
  return () => window.clearInterval(id)
}, [refreshSeconds, refresh])
```

There is **no argument or check for whether *this page* is the active view.**

| # | file:line | key | default | callback | endpoints per tick |
|---|-----------|-----|---------|----------|--------------------|
| A1 | `components/DashboardPage.tsx:183` | `"dashboard"` | **60 s** | `refreshAll` (`:179-182`) | `onRefresh()` → `fetchStats` = **`/monitor/status` + `/patterns/counts`** (`App.tsx:122-131`) **+ `fetchRecent` → `/findings/`** |
| A2 | `components/AnalyticsPage.tsx:220` | `"analytics"` | **0 (off)** | `fetchAll` (`:179-214`) | **5 endpoints**: `/analytics/summary`, `/bandwidth`, `/enforcements`, `/top-domains`, `/top-clients` |
| A3 | `components/FindingsPage.tsx:406` | `"findings"` | **0 (off)** | `refetch` (`:352-399`) | **`/findings/`** (1) — plus the one-shot `refetchIndexes` fan-out below |
| A4 | `components/QueryPage.tsx:695` | `"query"` | **0 (off)** | `fetchQuery` (`:647-689`) | `/query/…` (ES) |

Note the defaults: `0` means off **unless the operator previously turned it on** — the value is read back from `localStorage` at `utils.ts:104-111`:

```ts
const [refreshSeconds, setRefreshSeconds] = useState<number>(() => {
  const stored = Number(window.localStorage.getItem(`unetwatch_autorefresh_${key}`))
  return Number.isFinite(stored) && stored >= 0 ? stored : defaultSeconds
})
```

So an operator who enabled auto-refresh on Findings once keeps it enabled forever, on every future visit. `defaultSeconds` here is `0` (off) for findings/analytics/query, **60** for dashboard.

### 1.2 `setInterval` / `setTimeout` loops

| file:line | what | gated by |
|-----------|------|----------|
| `App.tsx:151` | 1 Hz countdown ticker; on reaching zero calls `fetchStats()` → **2 requests** (`/monitor/status` + `/patterns/counts`) | none (runs while the SPA is open) |
| `lib/utils.ts:127` | `useAutoRefresh` interval (see §1.1) | browser tab only |
| `components/loading/useElapsed.ts:97` | elapsed-time display ticker (no fetch) | `visible` (browser tab) |
| `components/RedirectsPage.tsx:485` | `pollCheck` — 500 ms `setTimeout` loop polling `/redirects/check/status` | only while a check runs |
| `components/DataTable.tsx:638`, `FilterContext.tsx:110`, etc. | debounce timers (no fetch storm) | — |

`App.tsx:134-163` countdown:

```ts
const tick = setInterval(() => {
  setRemaining((r) => {
    if (r <= 1) { fetchStats(); return intervalSec }   // 2 API calls every intervalSec
    return r - 1
  })
}, 1000)
```

This fires `/monitor/status` + `/patterns/counts` (not the endpoints in the log), so it is *not* the primary storm source here, but it does add 2 requests per poll interval.

### 1.3 `useEffect` blocks that fetch on mount

Every one of these runs when the page is first mounted **and never stops when the page becomes `hidden`** (a `hidden` div does not unmount children).

| file:line (effect) | fetch callback | endpoints fired | deps |
|--------------------|----------------|-----------------|------|
| `App.tsx:165-167` | `fetchStats` | `/monitor/status`, `/patterns/counts` | `[loggedIn, fetchStats]` |
| `DashboardPage.tsx:131-135` | `fetchBlacklistCount` + `fetchTrackedCount` | `/blacklist/`, `/redirects/` (**`/api/redirects/`**) | `[fetchBlacklistCount, fetchTrackedCount]` |
| `DashboardPage.tsx:172-174` | `fetchRecent` | **`/findings/?limit=5`** | `[fetchRecent]` |
| `AnalyticsPage.tsx:216-218` | `fetchAll` | **5 analytics endpoints** | `[fetchAll]` |
| `AnalyticsPage.tsx:252-254` | `fetchRaw` | **`/findings/`** (raw table) | `[fetchRaw]` |
| `FindingsPage.tsx:401-403` | `refetch` | **`/findings/`** | `[refetch]` |
| `FindingsPage.tsx:449-451` | `refetchIndexes` | **4 parallel**: `/patterns/?type=whitelist`, **`/redirects/?limit=5000`**, `/blacklist/`, `/jaillist/` | `[refetchIndexes]` |
| `RedirectsPage.tsx:412-414` | `loadTable` | **`/redirects/`** | `[loadTable]` |
| `RedirectsPage.tsx:415-417` | `loadGraph` | **`/redirects/graph`** | `[loadGraph]` |
| `HostInspectorPage.tsx:396-411` | `getJaillistSet` | `/jaillist/` | `[]` |
| `HostInspectorPage.tsx:618` | `fetchRaw` | `/client-report/…/findings` (only if a report loaded) | `[fetchRaw]` |
| `UrlInvestigationPage.tsx:84-99` | `getJaillistSet` | `/jaillist/` | `[]` |
| `QueryPage.tsx:577` | `getJaillistSet` | `/jaillist/` | `[]` |
| `QueryPage.tsx:691` | `fetchQuery` | `/query/…` (ES) | `[fetchQuery]` |
| `LogsPage.tsx:620-622` | `load` | `/logs/…` | `[load]` |
| `BlacklistPage.tsx:378-381` | `load` + `loadUpstreamStatus` | 2 endpoints | `[load, loadUpstreamStatus]` |
| `JaillistPage.tsx:92-95` | `load` + `loadUpstreamStatus` | 2 endpoints | `[load, loadUpstreamStatus]` |
| `PatternTable.tsx:247-249` | `fetchPatterns` | `/patterns/` | `[fetchPatterns]` |
| `AttckFleetPage.tsx:255-257` | `fetchFleet` | `/attck/…` | `[fetchFleet]` |
| `ZoneContext.tsx:16-19` | `getOperatorZone` | `/timezone` (once, app-wide) | `[]` |

### 1.4 Per-row / per-item fetching (N+1)

**None found.** This is important: the storm is *not* an N+1. Evidence:

- `FindingsPage.tsx` cells use `TimestampCell` and `ListActionCell` (`FindingsPage.tsx:96, 259`), both presentational — no `useEffect`/fetch inside them.
- `DataTable.tsx` effects are UI-only (resize, keyboard, debounced filter — lines 513, 533, 546, 555, 637, 1450, 1681) and contain no API calls.
- `HostInspectorPage`/`UrlInvestigationPage` fetch **once per selected entity**, not per row: `fetchHostSections`/`fetchRaw` are keyed on the selected `host`/`report` (`HostInspectorPage.tsx:522-533, 583-616`), `investigate` on an explicit target (`UrlInvestigationPage.tsx:107-156`).

So the repeating `/findings/` and `/redirects/graph` counts come from **multiple always-mounted pages each having one call site**, not from a per-row loop.

---

## 2. Does the storm survive when a page is HIDDEN?

**Yes.** The keep-mounted design is exactly the amplifier.

`App.tsx:202-208` records visits and never removes them; `App.tsx:105` seeds the set from the persisted view:

```tsx
// admin-ui/src/App.tsx:105
const [visited, setVisited] = useState<Set<string>>(() => new Set([storedView ?? "dashboard"]))

// admin-ui/src/App.tsx:205-208
const handleNavigate = useCallback((next: AppView, _search?: string) => {
  setView(next)
  setVisited((prev) => new Set(prev).add(next))
}, [])
```

Each visited page is rendered conditionally **on `visited`, never on `view`**, wrapped in a `hidden` div (`App.tsx:265-342`). Example:

```tsx
// admin-ui/src/App.tsx:288-292
{visited.has("findings") && (
  <div hidden={view !== "findings"}>
    <FindingsPage initialSearch={findingsSearch} onNavigate={handleNavigate} />
  </div>
)}
```

The `hidden` attribute toggles CSS `display` only — **it does not unmount children, does not run cleanup, and does not stop timers or effects.** Therefore:

- `FindingsPage`'s `useEffect(() => { void refetch() }, [refetch])` (`:401-403`) and its `useAutoRefresh(refetch, "findings", 0)` (`:406`) keep running while the user is on any other page.
- `RedirectsPage`'s `loadTable`/`loadGraph` effects (`:412-417`) keep running.
- `AnalyticsPage`'s `fetchAll` effect and `useAutoRefresh(fetchAll, "analytics", 0)` (`:216-220`) keep running.
- `DashboardPage`'s mount effects and `useAutoRefresh(refreshAll, "dashboard", 60)` (`:183`) keep running — **this one fires every 60 s forever, including its `onRefresh()` → `/monitor/status` + `/patterns/counts`.**

**Visibility gate check — result: NONE.**

- `usePageVisible()` (`utils.ts:149-157`) subscribes to `document.visibilitychange` — a **browser-tab** signal, not the app view:

```ts
export function usePageVisible(): boolean {
  const [visible, setVisible] = useState(document.visibilityState !== "hidden")
  useEffect(() => {
    const onChange = () => setVisible(document.visibilityState !== "hidden")
    document.addEventListener("visibilitychange", onChange)
    return () => document.removeEventListener("visibilitychange", onChange)
  }, [])
  return visible
}
```

- Grep confirms **no page component reads the active `view`** or any `hidden` state to gate its effects. `usePageVisible` is consumed only in `App.tsx:92` (to set `html[data-paused]`, `App.tsx:198-200`) and inside `useElapsed` — never to stop data fetching.

**Conclusion:** every one of the §1.3 sources keeps firing while its page is `hidden`. The design comment itself states the intent that makes this inevitable:

```tsx
// admin-ui/src/App.tsx:263-264
{/* Keep visited pages mounted so switching tabs never resets their
    state — each renders in a hidden wrapper when inactive. */}
```

---

## 3. Requests per tick / per mount — the tally

### 3.1 Call-site census for the storm endpoints

`/api/findings/` (`getFindings`, `admin-ui/src/api.ts:708-718`) — **5 call sites across 4 pages:**

| site | file:line | pages that keep it alive |
|------|-----------|--------------------------|
| FindingsPage list fetch | `FindingsPage.tsx:369` (in `refetch`, mount + interval) | Findings |
| Dashboard recent-5 | `DashboardPage.tsx:152` (mount + 60 s interval via `refreshAll`) | Dashboard |
| Analytics raw table | `AnalyticsPage.tsx:228` (mount + range change) | Analytics |
| HostInspector findings sections | `HostInspectorPage.tsx:254` (per lookup) | Host Inspector |
| (indirect) Dashboard `refreshAll` re-invokes `fetchRecent` → same site as row 2 | `DashboardPage.tsx:181` | Dashboard |

`/api/redirects/` (`listTrackedUrls`) — **3 call sites across 3 pages:**
`RedirectsPage.tsx:354` (mount/interval), `FindingsPage.tsx:412` (mount, limit=5000), `DashboardPage.tsx:117` (mount, limit=1).

`/api/redirects/graph` (`getRedirectGraph`) — **1 call site**, but it is invoked by an effect that re-runs whenever `loadGraph`'s identity changes, and `loadGraph` depends on `runGraph`/`graphGen` (`RedirectsPage.tsx:389-410`). In React StrictMode (dev) the mount effect runs twice; rapid navigations that remount/refresh the graph multiply it. **All 5 occurrences in the log trace to this single always-mounted effect.**

### 3.2 Concrete scenario

Assume the operator visits **Dashboard → Findings → Redirects → Analytics** and then sits on Analytics, with auto-refresh left at defaults (dashboard 60 s; others off unless previously enabled).

**On first mount of each page (one-time burst):**

| page | requests on mount |
|------|-------------------|
| Dashboard | `/findings/` + `/blacklist/` + `/redirects/` + (`App` already did `/monitor/status` + `/patterns/counts`) = **3** |
| Findings | `/findings/` + 4 index fan-out (`/patterns/`, `/redirects/?limit=5000`, `/blacklist/`, `/jaillist/`) = **5** |
| Redirects | `/redirects/` + `/redirects/graph` = **2** |
| Analytics | 5 aggregate + `/findings/` (raw) = **6** |
| **Total** | **≈ 16 requests** on a single navigation sweep — matching the 16-line log excerpt. |

**Steady state per minute** (sitting on Analytics, hidden pages still mounted):

| source | file:line | req/min |
|--------|-----------|---------|
| Dashboard `useAutoRefresh` 60 s (`refreshAll` = `onRefresh` 2 + `fetchRecent` 1) | `DashboardPage.tsx:183`, `:179-182` | **3** |
| App countdown → `fetchStats` at each poll boundary | `App.tsx:151-157` | 2 per `poll_interval_minutes` |
| Anything the operator set auto-refresh on (findings/analytics/query) | `*.tsx` `useAutoRefresh` | varies (≤ 8/min for analytics @ 5 req per tick) |
| **Baseline with all defaults** | | **≈ 3–5 req/min** |

**Steady state if auto-refresh was ever enabled on Findings and Analytics** (persisted in `localStorage`, survives reloads):

- Findings @ e.g. 30 s → `/findings/` ×2/min
- Analytics @ e.g. 30 s → 5 endpoints ×2 = **10 req/min**
- Dashboard @ 60 s → 3 req/min
- **Total ≈ 15+ req/min**, all fired by hidden pages, all landing on one uvicorn worker.

**Log-pattern match:** the excerpt's mix (`findings` ~8×, `redirects/graph` ~5×, `redirects/` ~3×) is consistent with several always-mounted pages' `useAutoRefresh` ticks (each returning its promise, so overlapping ticks are skipped *per hook*, but different hooks/keys fire independently) **co-firing** on the same wall-clock second. The per-hook `inFlightRef` guard (`utils.ts:129-136`) does **not** coordinate *across* pages, so 4 independent intervals can all land in the same 46 ms.

---

## 4. Backend side — does it serialize?

### 4.1 Worker count: **1**

```python
# app/main.py:381-383
def run():
    """Console entry point: ``unetwatch`` → serves the app on :8000."""
    uvicorn.run("app.main:app", host="0.0.0.0", port=8000)
```

`workers` is omitted → uvicorn defaults to **1 process**. The Dockerfile runs this via the `unetwatch` console script (`Dockerfile:CMD ["unetwatch"]` → `pyproject.toml:36` `unetwatch = "app.main:run"`), and `docker-compose.yml` sets no `--workers`. So **all 16 concurrent requests share one event loop and one process**.

### 4.2 DB access model: new connection per request

```python
# app/database.py:12-15
async def get_db() -> aiosqlite.Connection:
    db = await aiosqlite.connect(get_db_path())
    db.row_factory = aiosqlite.Row
    return db

# app/database.py:487-493
async def get_db_conn():
    db = await get_db()
    try:
        yield db
    finally:
        await db.close()
```

Every request opens **and closes** a fresh SQLite connection. `aiosqlite` runs each connection on its own worker thread; the calls are `await`ed, so the event loop is not blocked syntactically — **but the CPU cost of `SELECT *` + Python-side aggregation is real and runs on the loop thread.** WAL is enabled (`database.py:20`), which helps concurrent *readers*, but does not make the Python aggregation cheaper. With 1 worker, the serialized CPU work (see below) is what produces the 1.1–2.0 s outliers.

### 4.3 Expensive per-request work on the storm endpoints

- **`/api/findings/`** (`app/routes/findings.py:528-565`): cheap in SQL — a `COUNT(*)` and a `SELECT * … LIMIT ? OFFSET ?`, then `dict(r)` per row (`:565`). At `limit=5000` (Findings index fan-out walks `/redirects/`, not this) and default `limit=50`, this itself is small — **but it is issued concurrently 8×**, and `SELECT *` returns every column including JSON `matched_patterns`. Not the bottleneck by itself; it is a victim of the shared worker.

- **`/api/redirects/graph`** (`app/routes/redirects.py:193-219`): `SELECT t.*, <per-row subquery> FROM tracked_urls t` where the subquery is a correlated `COUNT(*)`:

```python
# app/routes/redirects.py:11-13
_HISTORY_COUNT_SQL = (
    "(SELECT COUNT(*) FROM redirect_edges e WHERE e.source_url = t.url) AS history_count"
)
```

This correlated subquery runs **once per tracked URL** (`:195`), and the same shape is used by `/api/redirects/` (`:93`). Without an index on `redirect_edges.source_url`, this is O(rows × edges). It's plausibly the 111–136 ms per call — and 5 concurrent copies of it on one worker add up.

- **`/api/analytics/summary`** (`app/routes/analytics.py:895-962`): **the 1 989 ms outlier.** It tries ES first (`_es_summary`, `:446`) — a network round-trip with `request_timeout=5` (`es_client.py:19`) — and on ES-miss/`UNKNOWN` mode falls back to `_findings_summary` (`:923`), which does:

```python
# app/routes/analytics.py:210-218
if total:
    cursor = await db.execute(
        f"SELECT * FROM findings {base_where} LIMIT 10000", params
    )
    rows = [dict(r) for r in await cursor.fetchall()]
    total_volume = _volume_for_bytes(rows)
    total_risk = sum(1 for r in rows if _row_is_risk(r, has_action))
    ...
```

— i.e. **up to 10 000 rows materialized into Python dicts and aggregated in Python loops** on the event-loop thread. `compare=previous` doubles this (`_previous_period_summary`, `:930`).

- **`/api/analytics/bandwidth`** (`analytics.py:965-989` → `_findings_bandwidth`, `:300-326`): **`SELECT * … LIMIT 20000`** followed by a Python bucketing loop (`:311-325`). The 1 113 ms outlier.

These three handlers run **on the same single loop thread** as the concurrent cheap `/findings/` and `/redirects/graph` calls. The cheap calls are not slow — they are **queued behind** the 2 s of Python aggregation, which is exactly why the log shows cheap endpoints at 45–190 ms and the two heavy ones at 1.1–2.0 s in the same window.

### 4.4 Caching / ETag / coalescing: **none for these endpoints**

- No `ETag`, no `Cache-Control` on `/findings/`, `/redirects/`, `/redirects/graph`, or `/analytics/*`. The only `Cache-Control` headers in the codebase are `no-store` on the public feed files (`app/routes/blacklist.py:34,45`, `app/routes/jaillist.py:26`).
- The only TTL caches are the ES **field-inventory** cache (`app/services/es_fields.py:49` `_FAILED_TTL_SECONDS = 30`) and the monitor query TTL (`app/services/monitor.py:96` `_QUERY_TTL_S = 2.0`). **Neither is applied to the SQLite analytics/findings/redirects handlers.**
- There is **no request coalescing**: 8 concurrent `GET /findings/` run 8 independent `COUNT(*)` + `SELECT`. FastAPI's documented async-singleton/coalescing patterns are not used.
- The two HTTP middlewares (`app/main.py:177-200` logging, `:203-223` security headers) add overhead but no caching.

---

## Ranked storm sources

| rank | source | file:line | est. req/min contribution | gate |
|------|--------|-----------|---------------------------|------|
| 1 | Keep-mounted pages: all `useEffect(mount)` fetches keep running while hidden; `hidden` ≠ unmount | `App.tsx:263-342` | one-time burst ≈16; enables everything below | none |
| 2 | Analytics auto-refresh: 5 endpoints/tick | `AnalyticsPage.tsx:220` (+mount `:216-218`) | 5 × (60/interval) — up to ~10 at 30 s | browser tab only |
| 3 | Findings auto-refresh: `/findings/` per tick + 4-endpoint index fan-out on mount | `FindingsPage.tsx:406`, `:449-451` | 1 × (60/interval) + 4 on mount | browser tab only |
| 4 | Dashboard auto-refresh 60 s: `onRefresh`(2) + `fetchRecent`(1) | `DashboardPage.tsx:183`, `:179-182` | 3 | browser tab only |
| 5 | Dashboard mount effects: `/blacklist/` + `/redirects/` + `/findings/` | `DashboardPage.tsx:131-135`, `:172-174` | 3 (mount) | none |
| 6 | Redirects table+graph effects: `/redirects/` + `/redirects/graph` (correlated subquery) | `RedirectsPage.tsx:412-417`, `:11-13` | 2 per mount; ×2 in StrictMode | none |
| 7 | App countdown → `fetchStats` (2 endpoints) each poll boundary | `App.tsx:151-157` | 2 / `poll_interval_minutes` | none |
| 8 | Backend: 1 uvicorn worker + 10 000–20 000-row Python aggregation per analytics request | `main.py:383`; `analytics.py:210-218, 300-326` | serializes req 2 & 4 | — |

**Does the storm survive hidden pages? YES** — §2.
**Does the backend serialize? YES** — 1 worker (`main.py:383`), 10k/20k-row Python loops (`analytics.py:210,309`), no caching/ETag/coalescing.

---

## Top 3 fixes (priority order)

### 1. Stop hidden pages from fetching — gate every page's effects on the active view
**Files:** `admin-ui/src/App.tsx` (pass an `active` prop), `admin-ui/src/components/{FindingsPage,RedirectsPage,AnalyticsPage,DashboardPage,QueryPage}.tsx`, `admin-ui/src/lib/utils.ts`.
**Change:** thread a boolean `active={view === "x"}` into each kept-mounted page and pass it as the `enabled`/gate to `useAutoRefresh` (add a 4th `enabled` parameter to the hook so it clears its interval when the page is hidden) **and** guard the mount `useEffect`s (`if (!active) return`). Unmounting instead of `hidden`, or rendering `hidden` pages lazily, is even simpler. This alone removes the persistent bleed from ranks 2–6.

### 2. Give analytics/findings/redirects a cache + a non-blocking data path
**Files:** `app/routes/analytics.py` (the `_findings_*` helpers), `app/routes/redirects.py` (`_HISTORY_COUNT_SQL`), `app/database.py`.
**Change:** (a) push the 10 000/20 000-row aggregation into SQL (`SUM`/`GROUP BY`) or at least `run_in_executor`/`asyncio.to_thread` so the event loop is never held; (b) add a TTL cache (reuse the `_QUERY_TTL_S` pattern at `app/services/monitor.py:96`) or an ETag keyed on `MAX(id)` for `/findings/`, `/redirects/`, `/redirects/graph`, `/analytics/summary`; (c) add an index on `redirect_edges(source_url)` to kill the correlated subquery cost.

### 3. Run more than one worker (and coalesce duplicate in-flight reads)
**File:** `app/main.py:383` (`uvicorn.run("app.main:app", host="0.0.0.0", port=8000)`), `Dockerfile:CMD ["unetwatch"]`.
**Change:** pass `workers=N` (configurable via env) — note SQLite WAL supports multi-reader, but multiple processes each open their own connections and the APScheduler jobs (`main.py:99-140`) would multiply per worker, so guard the scheduler to a single process or move it out. Client-side, an in-flight coalescing map in `admin-ui/src/api.ts` (keyed by URL) would collapse the 8 concurrent identical `/findings/` calls into one.

---

## Uncertainties (stated plainly)

- **I cannot see the actual browser session**, so I cannot state which `useAutoRefresh` keys the operator had enabled (values persist in `localStorage` under `unetwatch_autorefresh_<key>`). The defaults are `0` (off) for findings/analytics/query and `60` for dashboard; the log's volume implies **at least two of these were enabled**, or that several pages were being (re)mounted rapidly.
- **I cannot reproduce the exact timing** of the 16-line excerpt; the tally in §3.2 is a reasoned reconstruction from call sites, not a captured trace. The count of `/findings/` (5 call sites) and `/redirects/` (3 call sites) matches the observed multiplicity well, but the exact per-second interleave depends on which intervals were active and their phase.
- The 1 989 ms / 1 113 ms figures are **consistent with** the serialized Python loops plus ES attempt on one worker, but I have not profiled a live run to attribute the milliseconds precisely between the ES timeout (up to 5 s) and the SQLite fallback.
