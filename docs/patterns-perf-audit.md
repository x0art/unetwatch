# Patterns page — performance audit

**Scope:** `GET /api/patterns` (backend), the Patterns page (`admin-ui/src/components/PatternTable.tsx`), the grid engine (`admin-ui/src/components/DataTable.tsx`), the API wrappers (`admin-ui/src/api.ts`).
**Report (verbatim):** _"the page is hang while loading the Patterns"_
**Mode:** read-only. No file, DB, or running process was modified.
**Date:** 2026-10-02

---

## 0. Executive verdict

The **backend is not the cause**. On the shipped fixture the list endpoint runs in **~120–170 µs** and is hard-capped at `LIMIT 5000`; even at 200k rows the only query that grows is `COUNT(*) GROUP BY` at **~175 ms**.

The observable "hang" is a **UI-thread / paint problem on the client**, and it is *conditional on row count*. On the current fixture (`url_patterns` = **76 rows**) the page renders **50 rows** (the page size) and does **not** measurably hang — so the user is reporting this against a **larger dataset than any DB currently in the repo** (or their perception of "hang" is the anti-flicker loader timeline; see §2.6).

Two mechanisms dominate when N grows:

1. **Per-row `framer-motion` `Stagger`/`StaggerItem`** — the grid wraps **every rendered `<tr>` in a motion component** with no cap (`DataTable.tsx:1277-1335`, `motion.tsx:61-118`). This is the classic large-table hang. **Rank 1.**
2. **`PatternTable` passes `hasNext`/`pageSize` but never `internalPagination`**, so `DataTable` renders **whatever the caller hands it with no client cap** and derives `sortedData`/`filterOptions` by walking the full array on every relevant render (`DataTable.tsx:752-816`, `780-805`). Combined with `getPatternStats`'s `limit: 5000` fetch (`api.ts:652`), a caller that reuses these patterns renders thousands of animated rows. **Rank 2.**

Ranks 3–5 (per-render sort over the whole set, the `PATTERNS_UI` module mutation, the 100 ms `useElapsed` ticker) are real but secondary.

---

## 1. Backend cost of `GET /api/patterns`

### 1.1 Router location and the list query

Router: `app/routes/patterns.py` (`prefix="/api/patterns"`). The list handler:

```python
# app/routes/patterns.py:17-43
@router.get("/", response_model=list[UrlPatternResponse])
async def list_patterns(
    db=Depends(get_db_conn),
    pattern_type: str | None = Query(None, pattern="^(block|whitelist)$"),
    search: str | None = Query(None, max_length=200),
    limit: int = Query(100, ge=1, le=5000),
    offset: int = Query(0, ge=0),
    sort_by: str = Query("id", pattern="^(id|pattern|pattern_type|created_at)$"),
    sort_order: str = Query("desc", pattern="^(asc|desc)$"),
):
    where = []
    params: list = []
    if pattern_type:
        where.append("pattern_type = ?")
        params.append(pattern_type)
    if search:
        where.append("pattern LIKE ?")
        params.append(f"%{search}%")

    clause = f"WHERE {' AND '.join(where)}" if where else ""
    order = f"ORDER BY {sort_by} {sort_order.upper()}"
    cursor = await db.execute(
        f"SELECT * FROM url_patterns {clause} {order} LIMIT ? OFFSET ?",
        (*params, limit, offset),
    )
    rows = await cursor.fetchall()
    return [dict(r) for r in rows]
```

**Findings**

* **Paginated / bounded — yes.** `LIMIT` defaults to 100, is validated `ge=1, le=5000`, and `offset` is non-negative. There is no unbounded list path.
* **Single query — no N+1, no per-row work, no JSON parsing, no network calls.** Rows are `dict(r)`-ed one loader row at a time (`patterns.py:43`) — cheap; only `limit` rows are materialized.
* **Injection-safe.** `sort_by` / `sort_order` are constrained by the `Query(pattern=...)` regexes, so the f-string interpolation at `patterns.py:37-39` cannot be reached with an arbitrary column.
* **`ORDER BY` without a usable index.** `EXPLAIN QUERY PLAN` on the shipped DB shows `SCAN url_patterns` for both `ORDER BY id DESC` and `ORDER BY pattern ASC`. The only index on the table is the implicit `sqlite_autoindex_url_patterns_1` (from `pattern TEXT NOT NULL UNIQUE`, `app/database.py:24`). There is **no index on `pattern_type`, `created_at`, or an explicit index on `pattern`**. This is a latent cost, but **bounded by `LIMIT`** and therefore irrelevant at realistic sizes (measured below).
* **`COUNT(*)` over the table.** Only in `GET /api/patterns/stats/counts` (`patterns.py:141-147`), a `GROUP BY` over the whole table. This is the one backend query that grows linearly with row count (see §1.3).

### 1.2 Where patterns are read/written

* Connection: `app/database.py:12-15`
  ```python
  async def get_db() -> aiosqlite.Connection:
      db = await aiosqlite.connect(get_db_path())
      db.row_factory = aiosqlite.Row
      return db
  ```
  A **fresh connection per request** (`get_db_conn`, `database.py:487-493`), `WAL` enabled at init (`database.py:20`).
* Schema: `app/database.py:21-29` — `url_patterns(id PK, pattern UNIQUE, pattern_type, created_at, updated_at)`; `name/category/notes` added by later migration.
* `app/services/` — **the list path touches no service.** `url_patterns` is read directly only in `routes/patterns.py`. Other readers (`services/monitor.py:79,87`, `services/readout.py:214,227,549`, `routes/findings.py`, `routes/client_report.py`) are on *other* endpoints and are not on the Patterns list path.
* `bulk_import` (`patterns.py:120-136`) is O(n) with a `commit()` **per row** — a slow *write*, not the list path, but worth flagging (see §4).

### 1.3 Measurement (read-only)

DB files found: `unetwatch.db` (540 KB, **76** `url_patterns` rows), `_acc_tmp.db` (75), `elk_monitoring.db` (75), `admin-ui/elk_monitoring.db` (75); `data/unetwatch.db` and `admin-ui/unetwatch.db` have **no** `url_patterns` table (they are different schemas). Opened with `mode=ro`.

Timings on `unetwatch.db` (200 reps, no writes):

| Query | Time |
|---|---|
| `… ORDER BY id DESC LIMIT 50` | 168.9 µs |
| `… ORDER BY pattern ASC LIMIT 50` | 214.0 µs |
| `… WHERE pattern LIKE '%a%' ORDER BY id DESC LIMIT 50` | 151.8 µs |
| `pattern_type, COUNT(*) … GROUP BY pattern_type` | 35.3 µs |
| full scan (all 76 rows) | 161.9 µs |

Synthetic scaling (in-memory, per-query, to find the knee):

| n rows | `ORDER BY id DESC LIMIT 50` | `ORDER BY pattern ASC LIMIT 50` | `LIKE '%a%' … LIMIT 50` | `COUNT(*) GROUP BY` |
|---|---|---|---|---|
| 1,000 | 0.12 ms | 0.10 ms | 0.18 ms | 0.37 ms |
| 10,000 | 0.09 ms | 0.13 ms | 0.14 ms | 4.69 ms |
| 50,000 | 0.09 ms | 0.12 ms | 0.17 ms | 32.9 ms |
| 200,000 | 0.07 ms | 0.10 ms | 0.10 ms | **174.8 ms** |

**Conclusion:** the `LIMIT`-bounded list query is flat regardless of table size (the planner stops after `limit` rows even on a scan). The only query that scales is the `stats/counts` aggregate — and it is called by `getPatternStats` / the dashboard, **not** by the Patterns list. Backend is not the source of the hang.

---

## 2. Frontend cost on the Patterns page

### 2.1 `PatternTable.tsx` — request shape

```tsx
// PatternTable.tsx:35
const DEFAULT_PAGE_SIZE = 50
...
// PatternTable.tsx:204-211
listPatterns({
  pattern_type: filterType === "all" ? undefined : filterType,
  search: debouncedSearch || undefined,
  limit: pageSize,                       // 50
  offset: page * pageSize,
  sort_by: (sortBy ?? "id") as ...,
  sort_order: sortDir,
}, { signal }),
```

* **Rows requested: 50** (`pageSize`), server-side paged via `limit`/`offset`. **The Patterns page itself is NOT unbounded** — it asks the server for exactly one page.
* `hasNext={patterns.length === pageSize}` (`PatternTable.tsx:460`) and **no `total`** is passed, so `paginationTotal` is `undefined` (`DataTable.tsx:834`) — the pager cannot show a real total but this is a correctness nit, not a hang.
* `loading={loading && patterns.length === 0}` (`:428`) — **skeleton only on the very first, empty load**; a refetch keeps rows mounted and dims via `busy={busy || loading}` (`:430`). This is correct and prevents row-churn on refetch.
* Debounce: `useDebounce(search, 300)` (`:143`), and the fetch is keyed on `debouncedSearch` inside the `useCallback` deps (`:241`) driven by `useEffect(() => { fetchPatterns() }, [fetchPatterns])` (`:243-245`). **Typing re-fetches server-side after 300 ms** — it does **not** re-sort a client-side full set here (PatternTable passes no `internalPagination`, so the server does the sort). Good design; the keystroke storm is avoided for the 50-row page.

> **Key nuance:** because `PatternTable` fetches only 50 rows, the frontend cost *on this page* is small. The hang risk lives in the **shared engine's defaults** and in **`getPatternStats`'s `limit: 5000`** — if any surface renders patterns through `DataTable` without server paging (or a developer reuses `PATTERNS_COLUMNS`), N jumps to thousands and the engine's cost becomes the hang (see §2.3–2.5).

### 2.2 `PATTERNS_COLUMNS` column model

`PatternTable.tsx:55-136` — **5 columns**: `pattern`, `pattern_type`, `id` (default-hidden), `created_at`, `actions`.

Per-row cell work is cheap:
* `pattern` cell — a `<span>` with `p.pattern` (`:63-67`). No parse.
* `pattern_type` — a `Badge` (`:76-80`).
* `created_at` — `new Date(p.created_at).toLocaleDateString()` (`:101`). **A `Date` construction + `Intl` format per row per render.** At 50 rows this is nothing; at 5,000 rows it is 5,000 `Intl` formats per render — a real (secondary) cost. Not memoized.
* `actions` — two `Button`s calling `PATTERNS_UI.onEdit/onDelete` (`:113-134`).

No `JSON.parse`, no big `.map`, no sorting inside accessors. Accessors are pure field reads (`:61,74,89,98`). **The column model is clean.**

### 2.3 The module-scope `PATTERNS_UI` mutation-during-render pattern

```tsx
// PatternTable.tsx:40-48  (module scope)
const PATTERNS_UI = { busy: false, onEdit: () => {}, onDelete: () => {} }

// PatternTable.tsx:366-370  (inside the component body, during render)
// Sync live state into the module-scope PATTERNS_COLUMNS handles.
PATTERNS_UI.busy = busy
PATTERNS_UI.onEdit = openEdit
PATTERNS_UI.onDelete = (id) => setDeleteTarget(id)
const columns: DataTableColumn<Pattern>[] = PATTERNS_COLUMNS
```

* This is a **mutation of module state during render** — a React purity violation. It is not a `setState`, so it does **not** by itself trigger a re-render loop, and it *does* achieve its goal: `PATTERNS_COLUMNS` stays referentially stable so `DataTable`'s column memos (`DataTable.tsx:577,595,805,965`) don't invalidate. 
* **Caveat / latent storm:** the columns are **not re-created**, so any memo that depends on `columns` will **not** re-run when `busy` flips or `openEdit` identity changes — but the `actions` cell reads `PATTERNS_UI.busy` **at call time**, so the delete button's `disabled` state can render **stale** (one render behind). This is a correctness footgun, and the mutated `onEdit`/`onDelete` closures captured in the stable columns array are only correct because they delegate through the mutable module object. Not the hang cause, but a fragile pattern that a future refactor can turn into a stale-render bug.

### 2.4 What runs on every render over the full row set (DataTable)

`DataTable` is the real cost centre. Sorted/filtered/derived arrays are **memoized**, but their deps include `data` (a fresh array identity each fetch) and, critically, the **memos walk the entire `data`**:

```tsx
// DataTable.tsx:752-757
const filteredData = useMemo(() => {
  const f = filtersControlled ? controlledFilters : internalFilters
  if (!f || Object.keys(f ?? {}).length === 0) return data
  return data.filter((r) => filterMatches(r, f ?? {}))
}, [data, controlledFilters, internalFilters, filtersControlled, columns])
```

```tsx
// DataTable.tsx:780-805  — distinct values per enum column over ALL rows
const filterOptions = useMemo(() => {
  const source = filterSourceData ?? data
  const map = new Map<string, { value: string; label: string }[]>()
  for (const col of columnsRef.current) {
    if (col.srOnly || col.enableColumnFilter === false) continue
    if ((col.filterType ?? "enum") !== "enum") continue
    const seen = new Map<string, string>()
    for (const row of source) {            // ← O(columns × rows)
      ...
    }
  }
  return map
}, [data, filterSourceData, columns])
```

```tsx
// DataTable.tsx:807-816  — client sort when uncontrolled
const sortedData = useMemo(() => {
  const base = quickFilteredData
  if (controlled || !sortKey || !sortColumn) return base
  const dir = sortDirState === "asc" ? 1 : -1
  return [...base].sort((a, b) => {          // ← O(n log n), accessor per comparison
    const av = sortColumn.accessor ? sortColumn.accessor(a) : renderCellValue(sortColumn, a)
    const bv = sortColumn.accessor ? sortColumn.accessor(b) : renderCellValue(sortColumn, b)
    return compareValues(av, bv) * dir
  })
}, [quickFilteredData, sortKey, sortDirState, controlled, sortColumn])
```

* **Complexity:** `filteredData` O(n·filters), `quickFilteredData` O(n·quickCols), `filterOptions` **O(columns × n)**, `sortedData` **O(n log n)** with an accessor called inside the comparator (≈2·n·log n accessor calls). All memoized, but each is a full pass over `data` whenever `data` changes — including on **every refetch (every 300 ms of typing)**.
* **Note:** `PatternTable` passes `onSortChange` → `controlled = true` (`DataTable.tsx:484`), so `sortedData` returns `base` unsorted and the **server** sorts. Good — but `filterOptions` and the quick-filter/column-filter passes **still run over `data`** regardless.
* `DataTable.tsx:955-957` — a scroll listener calls `setScrolledX(el.scrollLeft > 0)` on **every scroll event**; it only re-renders when the boolean flips, so it is minor.

### 2.5 **Where DataTable renders and animates rows — the hang**

```tsx
// DataTable.tsx:1274-1335  (abridged)
// Stagger only the visible page of rows on first paint — never the
// full dataset (internalPagination keeps displayData ≤ page size).
<Stagger as="tbody">
  {displayData.map((row) => {
    const id = rowId(row)
    ...
    return (
      <StaggerItem
        as="tr"
        key={id}
        className={cn("border-b border-border transition-colors cv-auto", ...)}
        ...
      >
        ...cells...
      </StaggerItem>
    )
  })}
</Stagger>
```

```tsx
// DataTable.tsx:826-830
const displayData = useMemo(() => {
  if (!internalPagination || !hasPagination) return sortedData   // ← no client cap!
  const size = pageSize ?? 25
  return sortedData.slice(page! * size, (page! + 1) * size)
}, [internalPagination, hasPagination, sortedData, page, pageSize])
```

**Mechanism / why it blocks the UI thread:**

1. **The row count is `displayData.length`, which is `data.length` unless `internalPagination` is set.** The comment at `:1275-1276` claims "internalPagination keeps displayData ≤ page size" — but `PatternTable` **does not pass `internalPagination`**. So the guarantee the comment relies on is **not enforced** by this call site. Whatever the parent passes is rendered in full.
2. **Every rendered row is a `motion.tr`** (`StaggerItem as="tr"`, `motion.tsx:102-117`) wrapped by a `motion.tbody` (`Stagger`, `motion.tsx:70-75`). framer-motion mounts a motion component + variant subscription **per row** (`motion.tsx:45-53`: `staggerChildren: 0.05`, `duration: 0.35`). At N rows, initial mount cost is **O(N) component instantiations** plus **N staggered animations that each occupy a frame slot for ≥0.35 s + N×0.05 s of stagger delay**. At 100 rows the last row finishes at ~0.05·100 + 0.35 ≈ **5.35 s**; at 1,000 rows ≈ **50 s** of continuous main-thread animation work — the page is effectively frozen for the duration. **There is no animation cap** (no `index < CAP` guard, no `Math.min` on children).
3. `staggerItemVariants` animates `opacity` + `y` on `tr` elements, which forces **layout+paint per row per frame** — `content-visibility` does not help here because the element must be laid out to be animated.
4. `cv-auto` (`index.css:169`, `content-visibility: auto; contain-intrinsic-size: 1px 300px`) is applied to each `<tr>` (`DataTable.tsx:1286`). It **does** skip painting/layout of off-screen rows in modern Chromium — but (a) it is applied per `<tr>`, and `content-visibility` on table rows is inconsistently honoured across engines, and (b) it **cannot reduce the framer-motion JS/animation cost**, which is where the hang lives. So `cv-auto` helps paint, not the main-thread motion work.

**No virtualization.** There is no `react-window`/`react-virtual`/`@tanstack/react-virtual` anywhere in `admin-ui` (verified: no such dependency; `grep` for `virtual` in `node_modules` deps found none used). The grid is a fully-rendered `<table>`.

**Skeleton / page defaults:**
* `skeletonRows ?? pageSize ?? 25` (`DataTable.tsx:1246`) — skeleton row count follows `pageSize` (Patterns → 50).
* `pageSize` default in the engine is `25` (`DataTable.tsx:828,1343`); Patterns overrides to `50` (`PatternTable.tsx:35,146`).

### 2.6 Anti-flicker loader — the "long spinner with no feedback" reading

`useDelayedVisible` (`useDelayedVisible.ts:35-92`) intentionally **withholds** the toolbar loader for `LOADER_DELAY_MS = 250 ms` and then **forces it to stay ≥ 400 ms**. `useElapsed` (`useElapsed.ts:67-99`) ticks a `setState` **every 100 ms** while any loader is active (500 ms past 10 s). On the Patterns page the `PageHeader` `HeaderStatus` also shows an always-mounted `elapsed` (`PatternTable.tsx:401-403`), so `useElapsed(loading)` is live during every read → a re-render **every 100 ms** for the whole read. For a sub-second backend this is invisible; if the backend is ever slow (ES-backed stats, or a cold Python process), the operator sees a visibly counting "Loading patterns · 3s" — consistent with "hang while loading".

---

## 3. Most likely hang cause(s), ranked

| # | Cause | Type | Evidence | Mechanism |
|---|---|---|---|---|
| **1** | **Per-row framer-motion `Stagger`/`StaggerItem`, uncapped** | per-row animation | `DataTable.tsx:1277-1335`; `motion.tsx:45-53,61-118` | N `motion.tr` + N staggered animations (`staggerChildren: 0.05`, `duration: 0.35`) → last row settles at `0.05·N + 0.35 s`; each frame animates opacity+`y` on a table row (layout+paint). Main thread saturated ≫ N=100 rows. **No cap.** |
| **2** | **No client cap: `displayData` = full `data` unless `internalPagination`** | UI-thread block | `DataTable.tsx:826-830`; caller `PatternTable.tsx:424-465` omits `internalPagination`; `getPatternStats` uses `limit: 5000` (`api.ts:652`) | The guard the code *believes* is active (`comment at :1275-1276`) is opt-in. Any surface that feeds >pageSize rows (or reuses `PATTERNS_COLUMNS`) renders the whole set → triggers cause #1 at scale. |
| **3** | **Unmemoized `Intl` per row** | UI-thread block (secondary) | `PatternTable.tsx:99-102` | `new Date().toLocaleDateString()` per row per render; 5,000 rows ⇒ 5,000 `Intl` formats on each render/refetch. |
| **4** | **Full-array passes on every refetch (`filterOptions` O(cols·n), `sortedData` O(n log n))** | UI-thread block (secondary) | `DataTable.tsx:780-805,807-816,752-770` | Memoized but keyed on `data` identity; each 300 ms debounced keystroke that refetches re-runs all passes over the whole row array. |
| **5** | **`useElapsed` 100 ms `setState` + `HeaderStatus` always mounted** | re-render cadence | `useElapsed.ts:93-98`; `PatternTable.tsx:401-403` | A re-render every 100 ms for the duration of any read; keeps the tab hot and makes a slow read *look* like a hang. |

**Ruled out:** the backend (§1) — bounded, single query, µs-scale, flat with N. **Not** a data-fetch storm: `useAbortable` (`utils.ts:49-65`) + `useGeneration` (`utils.ts:79-84`) correctly cancel superseded reads and the 300 ms debounce gates keystrokes. **Not** an infinite effect loop: `fetchPatterns`'s deps (`PatternTable.tsx:241`) are primitives, and `useColumnState`'s persistence reads are memoized on `viewKey` (`useColumnState.ts:119`).

**Caveat on "hang":** at the **shipped fixture (76 rows / 50 rendered)** none of the above is measurable — the page renders a 50-row animated table and settles. The user is therefore reporting against **more patterns than any DB in this repo holds**, or the "hang" is the perceived loader (§2.6). This could not be reproduced end-to-end here because (a) no running server was started (read-only audit) and (b) no large-pattern fixture exists in the repo. Stated plainly rather than guessed.

---

## 4. Recommendations (minimal, targeted)

### Fix 1 — Cap / disable the per-row animation (frontend). **Priority: highest.**
In `DataTable.tsx` around `1277-1335`, stop wrapping every row in a motion component. Two minimal options:
* Render a plain `<tbody>`/`<tr>` when `displayData.length > ANIMATION_MAX_ROWS` (e.g. **40–60**), keeping `Stagger` only below that; **or**
* Keep `Stagger` but have `StaggerItem` apply `staggerItemVariants` only for `index < ANIMATION_CAP` (pass an index) and render the rest as static rows.
**Threshold where it bites:** visible jank begins around **>50 rows** (≈2.85 s of stagger tail); it is a clear freeze by **~200 rows** (≈10 s) and unusable by **~1,000** (≈50 s).

### Fix 2 — Enforce a hard row cap / adopt `internalPagination` (frontend). **Priority: high.**
In `PatternTable.tsx:424-465`, either pass `internalPagination` + `pageSize` so `displayData` is sliced (the engine already implements the slice at `:826-830`), **or** add a defensive `MAX_RENDER_ROWS` clamp inside `DataTable` so the "≤ page size" assumption in the comment at `:1275-1276` is actually guaranteed for every caller. Also add **row virtualization** (e.g. `@tanstack/react-virtual`) if any single surface must show >~2,000 rows without server paging. **Threshold:** a hard cap is required once any caller can exceed ~500 rows.

### Fix 3 — Make `getPatternStats` a server aggregate (backend + frontend). **Priority: medium.**
`api.ts:651-691` fetches up to **5,000** pattern rows (`limit: 5000`, `:652`) then `.filter()`s twice in JS (`:666-667`) to count block vs whitelist. The backend can answer this with one indexed `GROUP BY` — which already exists at `routes/patterns.py:141-147` (`GET /api/patterns/stats/counts`) and is already called by `getPatternCounts` (`api.ts:585-587`). **Recommendation:** have `getPatternStats` use `getPatternCounts()` alone and drop the `listPatterns({limit: 5000})` call entirely; then add a real `GET /api/patterns/stats` when richer fields are needed. `getPatternStats` is currently **dead code** (no importers outside `api.ts`), so this is low-risk cleanup. **Threshold:** the 5,000-row fetch is a ~1 MB-class payload and a 5,000-item client pass; it bites whenever the registry exceeds a few hundred rows.

### Secondary (cheap, do if touched)
* **Fix 4** — Memoize the `created_at` cell (`PatternTable.tsx:99-102`) behind the operator zone (there is already a `formatInstant`/`OperatorZone` helper in `lib/utils.ts:191-214`); removes per-row `Intl`.
* **Fix 5** — Give `useElapsed` a floor: don't start the 100 ms interval until `elapsed > LOADER_DELAY_MS`, and consider dropping the always-mounted `HeaderStatus` elapsed on short reads (`PatternTable.tsx:401-403`).
* **Fix 6** — Add an explicit index to silence the scan in the query plan: `CREATE INDEX IF NOT EXISTS idx_url_patterns_type ON url_patterns(pattern_type)` (helps `pattern_type=?` filters and the `GROUP BY`) — but note it changes **nothing measurable** at current sizes; do it for the `stats/counts` aggregate only if that table ever reaches ~100k rows (≈33 ms at 50k, ≈175 ms at 200k).
* **Fix 7** — `bulk_import` (`patterns.py:120-136`) commits **per row**; batch into one transaction. Write-path only, not the list hang.

### Verification commands a reviewer can run

```bash
# 1. Row count in the shipped fixture (read-only)
sqlite3 'file:unetwatch.db?mode=ro' 'SELECT COUNT(*) FROM url_patterns;'            # -> 76

# 2. Confirm the list query is index-free but LIMIT-bounded
sqlite3 'file:unetwatch.db?mode=ro' \
  'EXPLAIN QUERY PLAN SELECT * FROM url_patterns ORDER BY pattern ASC LIMIT 50;'    # -> SCAN url_patterns

# 3. Time the list + the stats aggregate
python3 - <<'PY'
import sqlite3, time
c = sqlite3.connect('file:unetwatch.db?mode=ro', uri=True)
for sql in ('SELECT * FROM url_patterns ORDER BY id DESC LIMIT 50',
            'SELECT pattern_type, COUNT(*) FROM url_patterns GROUP BY pattern_type'):
    s = time.perf_counter()
    for _ in range(200): c.execute(sql).fetchall()
    print(f'{(time.perf_counter()-s)/200*1000:.3f} ms  {sql}')
PY

# 4. Grow the table synthetically (in-memory) to find the COUNT knee
#    -> ~4.7 ms @10k, ~33 ms @50k, ~175 ms @200k  (see §1.3)

# 5. Find the animation wrap in the grid (the rank-1 cause)
grep -n 'Stagger as="tbody"\|<StaggerItem\|cv-auto\|internalPagination' \
  admin-ui/src/components/DataTable.tsx
sed -n '1274,1336p' admin-ui/src/components/DataTable.tsx

# 6. Prove the caller does not set internalPagination / passes no total
grep -n 'internalPagination\|hasNext\|pageSize\|total=' \
  admin-ui/src/components/PatternTable.tsx

# 7. Prove getPatternStats fetches 5000 rows
grep -n 'limit: 5000\|listPatterns\|\.filter(' admin-ui/src/api.ts

# 8. Reproduce the animation timestamp-to-first-paint in the browser:
#    open the Patterns page with >500 rows seeded, open DevTools ▸ Performance,
#    record 5 s, and observe the main-thread saturation from `StaggerItem`
#    motion updates. (No such fixture ships in this repo.)
```

---

## 5. Anchored evidence index

| Claim | Anchor | Quoted code |
|---|---|---|
| List bounded by LIMIT ≤5000 | `app/routes/patterns.py:22` | `limit: int = Query(100, ge=1, le=5000),` |
| Single bounded query | `app/routes/patterns.py:38-42` | `f"SELECT * FROM url_patterns {clause} {order} LIMIT ? OFFSET ?"` |
| No index on sort columns | query plan | `SCAN url_patterns` |
| Count aggregate | `app/routes/patterns.py:143-144` | `"SELECT pattern_type, COUNT(*) as count FROM url_patterns GROUP BY pattern_type"` |
| Patterns page requests 50 | `PatternTable.tsx:35,146,207` | `const DEFAULT_PAGE_SIZE = 50` / `limit: pageSize` |
| Module-scope mutation in render | `PatternTable.tsx:366-370` | `PATTERNS_UI.busy = busy` |
| Unmemoized Intl per row | `PatternTable.tsx:99-102` | `new Date(p.created_at).toLocaleDateString()` |
| No client cap | `DataTable.tsx:826-830` | `if (!internalPagination \|\| !hasPagination) return sortedData` |
| Every row is a motion component | `DataTable.tsx:1277-1284` | `<Stagger as="tbody">` … `<StaggerItem as="tr"` |
| 0.05 s stagger, 0.35 s duration, no cap | `motion.tsx:45-53` | `staggerChildren: 0.05` … `duration: 0.35` |
| cv-auto defined | `index.css:169` | `@content-visibility: auto; contain-intrinsic-size: 1px 300px;` |
| getPatternStats fetches 5000 rows | `api.ts:652` | `listPatterns({ limit: 5000, sort_by: "id", sort_order: "asc" }, opts)` |
| getPatternStats counts in JS | `api.ts:666-667` | `patterns.filter((p) => p.pattern_type === "block")` |
| 100 ms elapsed ticker | `useElapsed.ts:8,97` | `const TICK_MS = 100` |
| Debounce 300 ms | `PatternTable.tsx:143` | `useDebounce(search, 300)` |

_End of report._
