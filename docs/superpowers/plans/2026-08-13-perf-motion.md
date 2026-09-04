# Performance Audit & Cinematic Motion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Eliminate the dashboard's felt lag (DataTable re-sort churn, sankey hover cost, page-load paint cost, slow backend query/aggregation) and add a refined framer-motion layer on top of the now-fast engine.

**Architecture:** Four independent work streams — (A) stabilize the frontend engine, (B) add the framer-motion cinematic layer, (C) fix the backend query/aggregation hotspots, (D) harden the DB with indexes. Each task produces an independently testable deliverable; motion is built only after the engine fixes it sits on are in place.

**Tech Stack:** React 19 / Vite / Tailwind v4 / TypeScript; framer-motion (new); python 3.12 / FastAPI / aiosqlite / pandas; pytest / ruff.

**Spec:** `docs/superpowers/specs/2026-08-13-perf-motion-design.md`

## Global Constraints

- All motion is **GPU-composited `transform`/`opacity` only** — zero layout/paint/React-render cost from animation.
- **No `layout` prop** from framer-motion (FLIP measurement is the expensive path).
- **No springs** — tween only, expo-out `cubic-bezier(0.16, 1, 0.3, 1)` for everything, matching `admin-ui/src/index.css` `--default-transition-timing-function`.
- `prefers-reduced-motion` (`admin-ui/src/index.css:214`) is the single source of truth; framer honors it via `MotionConfig reducedMotion="user"`.
- `framer-motion` is used **only** for motion — never replaces a Radix primitive, never for state/data flow/layout.
- No re-theming: oklch tokens, DM Sans / JetBrains Mono, existing visual language unchanged.
- No new Python dependencies. Frontend gains exactly one dependency: `framer-motion`.
- Backend changed files must keep `ruff check` clean and `pytest` green (`asyncio_mode = "auto"`, `tests/conftest.py` provides the `db_path` + `client` fixtures).
- No placeholders / stubs / `.only` / `test.skip` in changed files before completion.

---

## Task 1: Install framer-motion

**Files:**
- Modify: `admin-ui/package.json`

**Interfaces:**
- Consumes: nothing
- Produces: `framer-motion` available to `admin-ui/src/components/motion.tsx` (Task 3)

- [ ] **Step 1: Install the dependency**

Run: `cd admin-ui && npm install framer-motion`

Expected: `framer-motion` appears in `dependencies` in `package.json`.

- [ ] **Step 2: Verify the bundle resolves**

Run: `cd admin-ui && npm run build`
Expected: `tsc -b` and `vite build` both pass.

- [ ] **Step 3: Commit**

```bash
git add admin-ui/package.json admin-ui/package-lock.json
git commit -m "chore(ui): add framer-motion for cinematic motion layer"
```

---

## Task 2: Motion primitives — `motion.tsx`

**Files:**
- Create: `admin-ui/src/components/motion.tsx`

**Interfaces:**
- Consumes: nothing (self-contained; uses `framer-motion` + existing `cn`)
- Produces:
  - `<Reveal delay?: number>` — `whileInView` fade + 12px rise + slight scale, `once`
  - `<Stagger>` — parent, `variants` with `staggerChildren`
  - `<StaggerItem>` — child of `<Stagger>`
  - `<AnimatedNumber value: number, durationMs?=600>` — count-up
  - `<MotionPage>` — page wrapper used by `App.tsx`
  - `MotionGate` — `MotionConfig reducedMotion="user"` wrapper mounted once in `App.tsx` (Task 8), so the motion layer and the existing CSS `prefers-reduced-motion` block use one preference.

- [ ] **Step 1: Write the file**

```tsx
import { motion, MotionConfig, useMotionValue, useTransform, animate, type Variants } from "framer-motion"

export const EASE = [0.16, 1, 0.3, 1] as const

/** Root motion gate — honors the OS reduced-motion preference so framer and
 * the existing CSS `@media (prefers-reduced-motion)` block agree. Mount once
 * at the app root (App.tsx). */
export function MotionGate({ children }: { children: React.ReactNode }) {
  return <MotionConfig reducedMotion="user">{children}</MotionConfig>
}

export function Reveal({ children, delay = 0 }: { children: React.ReactNode; delay?: number }) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 12, scale: 0.99 }}
      whileInView={{ opacity: 1, y: 0, scale: 1 }}
      viewport={{ once: true, margin: "-40px" }}
      transition={{ duration: 0.5, delay, ease: EASE }}
    >
      {children}
    </motion.div>
  )
}

export const staggerVariants: Variants = {
  hidden: {},
  show: { transition: { staggerChildren: 0.05, delayChildren: 0.05 } },
}

export const staggerItemVariants: Variants = {
  hidden: { opacity: 0, y: 8 },
  show: { opacity: 1, y: 0, transition: { duration: 0.35, ease: EASE } },
}

export function Stagger({ children }: { children: React.ReactNode }) {
  return (
    <motion.div initial="hidden" animate="show" variants={staggerVariants}>
      {children}
    </motion.div>
  )
}

export function StaggerItem({ children }: { children: React.ReactNode }) {
  return <motion.div variants={staggerItemVariants}>{children}</motion.div>
}

export function AnimatedNumber({
  value,
  durationMs = 600,
}: {
  value: number
  durationMs?: number
}) {
  const mv = useMotionValue(0)
  const rounded = useTransform(mv, (v) => Math.round(v))
  const [display, setDisplay] = React.useState(0)
  rounded.on("change", (v) => setDisplay(v))
  React.useEffect(() => {
    const controls = animate(mv, value, { duration: durationMs / 1000, ease: EASE })
    return controls.stop
  }, [value, durationMs, mv])
  return <>{display.toLocaleString()}</>
}

export function MotionPage({ children }: { children: React.ReactNode }) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -8 }}
      transition={{ duration: 0.22, ease: EASE }}
    >
      {children}
    </motion.div>
  )
}
```

- [ ] **Step 2: Verify it builds**

Run: `cd admin-ui && npm run build`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add admin-ui/src/components/motion.tsx
git commit -m "feat(ui): framer-motion primitives — Reveal, Stagger, AnimatedNumber, MotionPage"
```

---

## Task 3: DataTable — stop the re-sort churn

**Files:**
- Modify: `admin-ui/src/components/DataTable.tsx` (see `:229-241`, `:260`, `:407-440`)

**Interfaces:**
- Consumes: current `DataTableColumn<T>` / `DataTableProps<T>` unchanged
- Produces: `DataTableColumn<T>[]` consumers (Tasks 4-6) no longer need to memoize `columns` — the sort memo no longer depends on `columns` identity

- [ ] **Step 1: Stabilize `sortedData` against `columns` identity**

Replace the `sortedData` memo (currently keyed on `[data, columns, sortKey, sortDirState, controlled]`) so it no longer re-runs when `columns` is a fresh-but-equal array:

```tsx
const columnsRef = useRef(columns)
columnsRef.current = columns

const sortColumnsMemo = (() => {
  const col = columnsRef.current.find((c) => c.id === sortKey)
  return col ?? null
})()
const sortColumn = useMemo(() => sortColumnsMemo, [sortKey]) // eslint-disable-line react-hooks/exhaustive-deps

const sortedData = useMemo(() => {
  if (controlled || !sortKey || !sortColumn) return data
  const dir = sortDirState === "asc" ? 1 : -1
  return [...data].sort((a, b) => {
    const av = sortColumn.accessor ? sortColumn.accessor(a) : renderCellValue(sortColumn, a)
    const bv = sortColumn.accessor ? sortColumn.accessor(b) : renderCellValue(sortColumn, b)
    return compareValues(av, bv) * dir
  })
}, [data, sortKey, sortDirState, controlled, sortColumn])
```

(If linting flags `sortColumnsMemo` as a new value each render, hoist the column lookup next to `sortKey` in a `useMemo([sortKey])` so its identity is stable.)

- [ ] **Step 2: Verify a build**

Run: `cd admin-ui && npm run build`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add admin-ui/src/components/DataTable.tsx
git commit -m "perf(ui): stop DataTable re-sorting when columns identity changes"
```

---

## Task 4: QueryPage — collapse triple filter + stabilize columns

**Files:**
- Modify: `admin-ui/src/components/QueryPage.tsx` (see `:329-484` columns array, `:691/695/699` footer counts)

**Interfaces:**
- Consumes: `DataTableColumn<QueryDoc>` type, `ListActionCell`
- Produces: module-level `QUERY_COLUMNS: DataTableColumn<QueryDoc>[]`, `queryRowId(d: QueryDoc): string`

- [ ] **Step 1: Hoist the columns + rowId to module scope**

Move the `columns` array (currently inline at `:329-484`) to `const QUERY_COLUMNS: DataTableColumn<QueryDoc>[]` outside the component. The `ListActionCell` `onBlacklisted` callback uses a functional `setResult`, so it closes over nothing — safe at module scope. Hoist `rowId` to `function queryRowId(d: QueryDoc): string { return `${d.timestamp}|${d.client_ip}|${d.url}` }` and use it in place of the inline `rowId` callback and the `handleBulk*` filters.

- [ ] **Step 2: Collapse the triple filter**

Replace the three `.filter()` calls at `:691/695/699` with a single `useMemo`:

```tsx
const coverageCounts = useMemo(() => {
  let blocked = 0
  let whitelisted = 0
  let blacklisted = 0
  for (const d of actionFilteredItems) {
    if (d.blocked_by.length > 0) blocked++
    if (d.whitelisted) whitelisted++
    if (d.blacklisted) blacklisted++
  }
  return { blocked, whitelisted, blacklisted }
}, [actionFilteredItems])
```

Then render `coverageCounts.blocked` / `.whitelisted` / `.blacklisted` in the existing footer text.

- [ ] **Step 3: Build + lint**

Run: `cd admin-ui && npm run build && npm run lint`
Expected: both PASS.

- [ ] **Step 4: Commit**

```bash
git add admin-ui/src/components/QueryPage.tsx
git commit -m "perf(ui): hoist Query columns to module scope, collapse triple filter"
```

---

## Task 5: FindingsPage — stabilize columns

**Files:**
- Modify: `admin-ui/src/components/FindingsPage.tsx` (see `:277-407`)

**Interfaces:**
- Consumes: `FindingsPageProps` (unchanged), `DataTableColumn<Finding>`
- Produces: module-level `FINDINGS_COLUMNS: DataTableColumn<Finding>[]`

- [ ] **Step 1: Hoist columns to module scope**

Move `columns` (`:277-407`) to `const FINDINGS_COLUMNS: DataTableColumn<Finding>[]`. The cells reference `whitelistIndex`, `trackedIndex`, `busy`, `handleCopyUrl`, `handleTrackRedirect`, `handleDelete`, `setDeleteTarget`, and `ListActionCell`'s `onBlacklisted` — all of which close over component state. Convert those to **ref lookups**: create `const stateRef = useRef({ whitelistIndex, trackedIndex, busy })` updated each render, and hoist the action handlers (`handleCopyUrl`, `handleTrackRedirect`) as pure module functions that take their dependencies as parameters, or keep tiny inline wrappers that read `stateRef.current`. The `setBlacklistIndex`/`setDeleteTarget` setters are stable and safe.

- [ ] **Step 2: Build + lint**

Run: `cd admin-ui && npm run build && npm run lint`
Expected: both PASS.

- [ ] **Step 3: Commit**

```bash
git add admin-ui/src/components/FindingsPage.tsx
git commit -m "perf(ui): hoist Findings columns to module scope"
```

---

## Task 6: GraphPage / RedirectsPage / PatternTable / LogsPage / BlacklistPage — stabilize columns

**Files:**
- Modify: `admin-ui/src/components/GraphPage.tsx`, `admin-ui/src/components/RedirectsPage.tsx`, `admin-ui/src/components/PatternTable.tsx`, `admin-ui/src/components/LogsPage.tsx`, `admin-ui/src/components/BlacklistPage.tsx`

**Interfaces:**
- Consumes: `DataTableColumn<T>` per page's row type
- Produces: per-page module-level `*_COLUMNS` constants; `rowId` hoisted where it closes over nothing (`RedirectsPage` uses `(i) => i.id`, `FindingsPage` uses `(f) => f.id`)

- [ ] **Step 1: Hoist each page's `columns` array to module scope**

For each of the five pages, move the inline `columns` array to a module-level `const`. Where a cell closes over component state (e.g. `GraphPage`'s `whitelistIndex` / `blacklistIndex`, `RedirectsPage`'s `busyUrl` / `busy`), convert to `stateRef` lookups exactly as in Task 5. Hoist inline `rowId` callbacks that close over nothing to module functions.

- [ ] **Step 2: Build + lint**

Run: `cd admin-ui && npm run build && npm run lint`
Expected: both PASS.

- [ ] **Step 3: Commit**

```bash
git add \
  admin-ui/src/components/GraphPage.tsx \
  admin-ui/src/components/RedirectsPage.tsx \
  admin-ui/src/components/PatternTable.tsx \
  admin-ui/src/components/LogsPage.tsx \
  admin-ui/src/components/BlacklistPage.tsx
git commit -m "perf(ui): hoist remaining page columns to module scope"
```

---

## Task 7: Sankey + Timeline — memoize and lighten

**Files:**
- Modify: `admin-ui/src/components/SankeyDiagram.tsx` (see `:143-246` buildOption, `:300-338` effect), `admin-ui/src/components/QueryPage.tsx` (TimelineChart `:124-233`)

**Interfaces:**
- Consumes: `SankeyNode` / `SankeyLink` (unchanged), `TimelineChart` props (unchanged)
- Produces: none new

- [ ] **Step 1: Cache `resolveColor` per theme**

In `SankeyDiagram.tsx`, wrap the four `resolveColor("var(--color-*)")` calls in a `useMemo` keyed on `theme` (server-render-safe: the effect already resolves palette via `getComputedStyle`, so the memo is only a cache; the `paletteChanged` diff stays authoritative).

- [ ] **Step 2: Scale `layoutIterations` to graph size**

```tsx
const layoutIterations = nodes.length > 60 ? 8 : nodes.length > 30 ? 12 : 16
```

and pass `layoutIterations` into `buildOption`'s series (replacing the hard-coded `32` at `:219`).

- [ ] **Step 3: Memoize TimelineChart paths**

In `QueryPage.tsx`, wrap `linePath` and `areaPath` (and the recomputed `max`/`gridLines`/`xLabels`) in `useMemo([points])`.

- [ ] **Step 4: Build + manual check**

Run: `cd admin-ui && npm run build`
Expected: PASS. In the browser, hover nodes on a Top-50 graph — no stutter.

- [ ] **Step 5: Commit**

```bash
git add admin-ui/src/components/SankeyDiagram.tsx admin-ui/src/components/QueryPage.tsx
git commit -m "perf(ui): cache sankey palette, scale layout iterations, memo timeline paths"
```

---

## Task 8: Page load / route paint — `AnimatePresence` + visibility-gated infinite animations

**Files:**
- Modify: `admin-ui/src/App.tsx` (see `:179` Suspense), `admin-ui/src/components/ui.tsx` (StatCard `:1094-1134`), `admin-ui/src/index.css` (infinite anims), `admin-ui/src/components/DashboardPage.tsx` (status dot `:164-176`)

**Interfaces:**
- Consumes: `MotionPage`, `AnimatedNumber`, `Reveal` (Task 2)
- Produces: `usePageVisible()` hook in `admin-ui/src/lib/utils.ts`

- [ ] **Step 1: Mount `MotionGate` + add `usePageVisible` + `.cv-auto` utility**

Wrap `AppRoutes`'s output in `<MotionGate>` (from Task 2) in `App.tsx`. Add `usePageVisible` to `lib/utils.ts`:**

```tsx
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

In `index.css`, add the `.cv-auto` utility (GPU-composited content-visibility with intrinsic size so the browser can reserve layout without painting):
```css
@utility cv-auto {
  content-visibility: auto;
  contain-intrinsic-size: 1px 300px;
}
```

- [ ] **Step 2: Gate infinite animations**

In `DashboardPage.tsx`, only render the `animate-ping` status dot when `usePageVisible()` is true (keep the static dot always). Add `data-paused` handling to `index.css` (the existing `prefers-reduced-motion` block already covers OS-level pause; this covers tab-hidden):
```css
*:where([data-paused]) {
  animation-play-state: paused !important;
}
```
Then attach `usePageVisible` in `App.tsx` to set that attribute globally.

- [ ] **Step 3: Route crossfade + StatCard count-up**

In `App.tsx`, wrap the `Suspense` children in `<AnimatePresence mode="wait">` and render each page inside `<MotionPage>` (keyed by `view`). In `ui.tsx` `StatCard`, render the value through `<AnimatedNumber>` when it is a `number` (keep string values like `"—"` / `"Online"` as-is):

```tsx
const animated = typeof value === "number"
...
{animated ? <AnimatedNumber value={value} /> : value}
```

- [ ] **Step 4: Build + lint**

Run: `cd admin-ui && npm run build && npm run lint`
Expected: both PASS.

- [ ] **Step 5: Commit**

```bash
git add admin-ui/src/App.tsx admin-ui/src/components/ui.tsx admin-ui/src/index.css admin-ui/src/components/DashboardPage.tsx admin-ui/src/lib/utils.ts
git commit -m "feat(ui): route crossfades, stat count-ups, pause infinite anims on hidden tab"
```

---

## Task 9: Bulk-action bar + table-first-paint stagger

**Files:**
- Modify: `admin-ui/src/components/DataTable.tsx` (bulk bar `:264-298`, rows `:407-441`), `admin-ui/src/components/ui.tsx` (`RankedTable` `:994-1055`)

**Interfaces:**
- Consumes: `Stagger` / `StaggerItem` / `AnimatePresence` (Task 2)
- Produces: none new

- [ ] **Step 1: Stagger the visible table rows on first paint**

In `DataTable.tsx`, wrap the rendered rows in `<Stagger>` and each row in `<StaggerItem>`. Only rows in `displayData` (the current page) are animated — never the full dataset — so `internalPagination` keeps the count ≤ page size. Non-paginated (server-side) tables get the same treatment on their page cells.

- [ ] **Step 2: Animate the bulk-action bar**

Wrap the `selectable && selected.size > 0` block in `<AnimatePresence>` (import from `framer-motion`) with a mount `initial={{ opacity: 0, y: -6 }}` / `animate={{ opacity: 1, y: 0 }}` / `exit={{ opacity: 0, y: -6 }}`.

- [ ] **Step 3: Stagger RankedTable rows**

In `RankedTable`, wrap the `rows.map(...)` `<tr>`s in a light `Stagger`/`StaggerItem`.

- [ ] **Step 4: Build + lint**

Run: `cd admin-ui && npm run build && npm run lint`
Expected: both PASS.

- [ ] **Step 5: Commit**

```bash
git add admin-ui/src/components/DataTable.tsx admin-ui/src/components/ui.tsx
git commit -m "feat(ui): stagger table rows + animate bulk bar"
```

---

## Task 10: Backend — `findings_graph` SQL-filter + indexes

**Files:**
- Modify: `app/database.py` (init_db — add two indexes after the `findings` `CREATE TABLE` + migration), `app/routes/findings.py` (`findings_graph` `:11-151`)
- Test: `tests/test_findings_graph.py` (create)

**Interfaces:**
- Consumes: `_build_pattern_regex` (already exported from `app.services.monitor`)
- Produces:
  - `app.services.monitor` gains `_whitelist_sql_clauses(patterns: list[str]) -> list[str]` (SQL `NOT LIKE`/`NOT GLOB` clauses, empty-list fallback)
  - `findings_graph` keeps its response shape: `{"nodes": [...], "links": [...], "flows": [...]}`

- [ ] **Step 1: Write the failing test**

In `tests/test_findings_graph.py` (uses the `client` + `db_path` fixtures):

```python
def test_findings_graph_whitelist_excluded(client, db_path):
    import aiosqlite

    db = await aiosqlite.connect(db_path)
    await db.executemany(
        "INSERT INTO findings (client_ip, server_ip, url, base_url, log_timestamp)"
        " VALUES (?, ?, '', ?, ?)",
        [
            ("1.1.1.1", "", "http://evil.example/a", "evil.example", "2026-01-01T00:00:00Z"),
            ("1.1.1.1", "", "http://safe-porn-ads.example/b", "safe-porn-ads.example", "2026-01-01T00:00:00Z"),
        ],
    )
    await db.commit()
    await db.close()

    # Add the whitelist pattern (pytest-asyncio runs this async test).
    client.post("/api/patterns/", json={"pattern": "*porn*", "pattern_type": "whitelist"})

    res = client.get("/api/findings/graph?limit=30")
    assert res.status_code == 200
    data = res.json()
    urls = {n["label"] for n in data["nodes"] if n["kind"] == "url"}
    assert "http://safe-porn-ads.example/b" not in urls  # whitelisted -> excluded
    assert "http://evil.example/a" in urls
```

- [ ] **Step 2: Run it to verify it fails**

Run: `uv run pytest tests/test_findings_graph.py -v` (or `python -m pytest`, per repo norm)
Expected: FAIL — the whitelisted row is still present (current code excludes via Python, but the test pins the SQL path being added).

- [ ] **Step 3: Add `_whitelist_sql_clauses`**

In `app/services/monitor.py`:

```python
def _whitelist_sql_clauses(patterns: list[str]) -> list[str]:
    """SQL exclusion clauses for whitelist patterns.

    ``*``/``?`` translate to SQL ``%``/``_`` (LIKE semantics, case-insensitive
    via GLOB when patterns stay literal). Patterns that contain regex meta
    characters beyond the wildcards fall back to the Python re.search path —
    the caller decides; returning [] forces the Python fallback.
    """
    clauses = []
    for pattern in map(str.strip, patterns):
        if not pattern:
            continue
        # Only patterns composed of literals + * / ? are SQL-expressible.
        if re.fullmatch(r"[A-Za-z0-9./:_-]*[\*?][A-Za-z0-9./:_-]*", pattern):
            like = pattern.replace("*", "%").replace("?", "_")
            clauses.append(f"(url NOT LIKE '{like}' ESCAPE '\\')")
    return clauses
```

(Adjust the allowed charset to your actual pattern shape; anything else falls back.)

- [ ] **Step 4: Apply SQL exclusion + LIMIT in `findings_graph`**

In `app/routes/findings.py`, after fetching `wl_rows`: build the SQL clauses; when non-empty append them to the `WHERE` of the grouped query. Keep a **pure-Python `re.search` fallback** for rows that slip through (or when clauses are empty). Add `LIMIT 5000` to the grouped query.

- [ ] **Step 5: Run the test to verify it passes**

Run: `uv run pytest tests/test_findings_graph.py -v`
Expected: PASS.

- [ ] **Step 6: Add the indexes in `init_db`**

After the `findings` CREATE TABLE block and its migration (around `database.py:59`), add:
```python
await db.execute(
    "CREATE INDEX IF NOT EXISTS idx_findings_url ON findings(url)"
)
await db.execute(
    "CREATE INDEX IF NOT EXISTS idx_findings_base_url ON findings(base_url)"
)
```

- [ ] **Step 7: Run the full backend suite + lint**

Run: `uv run pytest -v && uv run ruff check app tests`
Expected: all tests pass, ruff clean.

- [ ] **Step 8: Commit**

```bash
git add app/services/monitor.py app/routes/findings.py app/database.py tests/test_findings_graph.py
git commit -m "perf(api): push findings whitelist filter into SQL, add url indexes"
```

---

## Task 11: Backend — vectorize pandas in the hot paths

**Files:**
- Modify: `app/services/monitor.py` (`apply_filters` `:230-236`, `store_findings` `:238-267`, `_build_items` `:442-505`), `app/services/seed.py` if it touches similar loops
- Test: `tests/test_monitor_patterns.py` (extend) + `tests/test_findings_graph.py`

**Interfaces:**
- Consumes: existing `_glob_to_regex`, `_safe_number`, `_normalize_timestamp` (all unchanged)
- Produces: none new — same functions, vectorized bodies

- [ ] **Step 1: Vectorize `apply_filters` base_url**

```python
# BEFORE
df["base_url"] = df["url"].astype(str).apply(_extract_base_url)
# AFTER
urls = df["url"].astype(str)
df["base_url"] = urls.str.split("/", n=2).str[2].fillna(urls)
```

(Verify a null/new row is guarded the same way `_extract_base_url` handles `len < 3` — use `np.where` / `df.assign` if a fill alone doesn't match.)

- [ ] **Step 2: Vectorize `store_findings`**

Replace `for _, row in df.iterrows()` with `for row in df[["client_ip","server_ip","url","base_url","log_timestamp", "@timestamp"]].itertuples(index=False, name=None)` collecting the same 5-tuples (use `str(row[i] or "")` guards). Keep `INSERT OR IGNORE` + `executemany` unchanged.

- [ ] **Step 3: Vectorize `_build_items`**

Currently a per-row Python loop calling `rx.search(url)` per pattern. Replace the `blocked_by` annotation with a vectorized pass:

```python
# One search per pattern, vectorized across the batch, not per row.
block_hits = {i: [] for i in range(len(df))}
for pattern, rx in block_matchers:
    m = df["url"].astype(str).str.contains(rx.pattern if False else rx, regex=True, case=False, na=False)
    # m is a boolean Series: mark rows hit by this pattern
    for idx in m[m].index:
        block_hits[idx].append(pattern)
```

then build `items` from `df.to_dict("records")` + `block_hits` instead of `df.iterrows()`. Keep the `blacklisted`/`whitelisted` logic identical per row.

- [ ] **Step 4: Extend tests to pin behavior**

In `tests/test_monitor_patterns.py` add a test that `apply_filters` still excludes whitelisted URLs and keeps non-matching ones (mirror existing `test_apply_filters_handles_nasty_whitelist_patterns`), now exercising the vectorized `base_url` path with a `url` that has no `/` (guard: base_url should equal the url).

- [ ] **Step 5: Run backend tests + lint**

Run: `uv run pytest -v && uv run ruff check app tests`
Expected: all pass, ruff clean.

- [ ] **Step 6: Commit**

```bash
git add app/services/monitor.py tests/test_monitor_patterns.py
git commit -m "perf(api): vectorize apply_filters, store_findings, _build_items"
```

## Task 11b: Apply `content-visibility` to below-the-fold panels

**Files:**
- Modify: `admin-ui/src/components/AppShell.tsx` (where panels live), any panel wrapper used by GraphPage/QueryPage/RedirectsPage

**Interfaces:**
- Consumes: `.cv-auto` class (Task 8, Step 1)
- Produces: no new exports

- [ ] **Step 1: Add `content-visibility: auto` to panels that are below the fold**

In `AppShell.tsx`'s `<main>` area, and in the graph/chart panels of `GraphPage.tsx`/`QueryPage.tsx`/`RedirectsPage.tsx`, add `className="cv-auto"` so the browser skips layout/paint for off-screen content. Don't add it to the header, stat cards, or the sankey canvas (ECharts manages its own rendering; we only skip the surrounding div).

- [ ] **Step 2: Build**

Run: `cd admin-ui && npm run build`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add admin-ui/src/components/AppShell.tsx admin-ui/src/components/GraphPage.tsx admin-ui/src/components/QueryPage.tsx admin-ui/src/components/RedirectsPage.tsx
git commit -m "perf(ui): gate below-the-fold panels behind content-visibility"
```

---

## Task 12: Backend — TTL cache for identical auto-refresh queries

**Files:**
- Modify: `app/services/monitor.py` (`run_query` `:508-642`), `app/database.py` (add the index migration in `init_db` to close out Task 10 if not yet added)
- Test: `tests/test_query_cache.py` (create)

**Interfaces:**
- Consumes: `run_query` signature (unchanged)
- Produces: private `_query_cache: dict[str, tuple[float, dict]]` + `_invalidate_query_cache()`; `run_query` consults/updates it

- [ ] **Step 1: Write the failing test**

In `tests/test_query_cache.py` (module-level cache is reset per-test via the `db_path` fixture; import and reset manually):

```python
from app.services.monitor import run_query, _query_cache, _invalidate_query_cache

def test_run_query_short_ttl_cache(client):
    _invalidate_query_cache()
    # ES is unreachable in tests, so run_query returns es_online=False quickly;
    # the cache key is fingerprints (empty block patterns -> no ES call).
    first = run_query(minutes=30)
    second = run_query(minutes=30)
    assert _query_cache  # a cache entry was written
    # Same (minutes, no patterns) key -> served from cache, no duplicate work.
    assert first["window_minutes"] == second["window_minutes"]
```

(This pins that the cache is populated and keyed on stable inputs; the precise hit path is hard to assert without mocking ES, so this test asserts the cache mechanics — write, key stability, invalidation.)

- [ ] **Step 2: Run it to verify it fails**

Run: `uv run pytest tests/test_query_cache.py -v`
Expected: FAIL — `_query_cache` / `_invalidate_query_cache` don't exist yet.

- [ ] **Step 3: Implement the cache**

In `app/services/monitor.py`, add near `run_query`:

```python
_query_cache: dict[str, tuple[float, dict]] = {}
_QUERY_TTL_S = 2.0

def _query_cache_key(minutes, search, exclude_whitelist, exclude_blacklist,
                     block_patterns, whitelist_patterns) -> str:
    return "|".join([
        str(minutes), search or "", str(exclude_whitelist), str(exclude_blacklist),
        "|".join(block_patterns), "|".join(whitelist_patterns),
    ])

def _invalidate_query_cache() -> None:
    _query_cache.clear()
```

In `run_query`, right after building `block_patterns`/`whitelist_patterns` (before opening ES): compute the key, check `_query_cache`; on hit within TTL, return a copy of the cached dict. On miss, run the existing path and store `(time.monotonic(), result)` before returning. Note: since `block_patterns`/`whitelist_patterns` are empty in the test server-memory env, the fast path (no ES hit, `es_online` stays True) makes the test deterministic.

- [ ] **Step 4: Run the test to verify it passes**

Run: `uv run pytest tests/test_query_cache.py -v`
Expected: PASS.

- [ ] **Step 5: Full backend suite + lint**

Run: `uv run pytest -v && uv run ruff check app tests`
Expected: all pass, ruff clean.

- [ ] **Step 6: Commit**

```bash
git add app/services/monitor.py tests/test_query_cache.py
git commit -m "perf(api): 2s TTL cache for duplicate query runs"
```

---

## Task 13: Final verification pass

**Files:**
- Modify: none (verification only)

- [ ] **Step 1: Full frontend build + lint**

Run: `cd admin-ui && npm run build && npm run lint`
Expected: both PASS.

- [ ] **Step 2: Full backend suite + lint**

Run: `uv run pytest -v && uv run ruff check app tests`
Expected: all pass, ruff clean.

- [ ] **Step 3: Manual UX sanity (reduced-motion + normal)**

- With OS `prefers-reduced-motion` ON: open Dashboard, Query, Graph — no `animate-ping`, no reveal/count-up motion, everything instant.
- With it OFF: route switch crossfades, StatCard numbers count up, table rows stagger in, sankey hovers are smooth (no stutter) at Top-50.
- Type in Query's search box: the table no longer re-sorts per keystroke.

- [ ] **Step 4: No-fake-completion scan**

Grep changed files for `TODO|FIXME|test.skip|\.only|placeholder` — expect zero hits in authored code.

- [ ] **Step 5: Report**

Summarize which bottlenecks were eliminated (re-sort churn, triple filter, sankey layout iterations, unbounded findings scan, per-row regex, ES re-runs) and what motion was added (route crossfade, count-ups, reveals, stagger, bulk-bar animate). Commit any docs change:

```bash
git commit -m "test(ui): final verification of perf + motion pass"
```