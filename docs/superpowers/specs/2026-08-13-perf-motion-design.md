# Performance Audit & Cinematic Motion — Design Spec

**Date:** 2026-08-13
**Status:** Approved
**Scope:** Full stack (frontend `admin-ui` + backend `app`)

## 1. Goal

Eliminate the performance bottlenecks that make the dashboard feel slow, then add a
"refined & cinematic" animation layer on top of the now-fast engine. The motion must
be mesmerizing without ever degrading the speed it sits on — and without ever
re-triggering the expensive work the audit removes.

## 2. Guiding principle

> Fix the engine first, then lay motion on top.

Motion is allowed to add GPU-composited `transform` / `opacity` work and **zero**
layout, paint, or React-render work. Every animation is gated by the existing
`prefers-reduced-motion` block (`admin-ui/src/index.css:214`), so the same preference
collapses all motion to "instant" for users who asked for it.

**Non-negotiables carried from the codebase:**

1. `prefers-reduced-motion` remains the single source of truth for reduced motion.
   framer-motion honors it via `MotionConfig reducedMotion="user"` — no second system.
2. The visual language is unchanged: oklch tokens, DM Sans / JetBrains Mono, and the
   expo-out curve (`cubic-bezier(0.16, 1, 0.3, 1)`) already defined in `index.css`.
   Motion extends this language; it does not re-theme it.

**New dependency:** `framer-motion`, used *only* for motion. It does not replace any
Radix primitive and is not used for state, data flow, or layout.

## 3. The four layers

| Layer | Fix (perf) | Motion (cinematic) |
|---|---|---|
| DataTable | Stop the re-sort churn | Staggered row reveal on first paint |
| Charts (`SankeyDiagram`, `TimelineChart`) | Memoize builds, drop `layoutIterations` | Entrance + data-change transitions |
| Pages / routing | Stabilize `columns`/`rowId` closures | `AnimatePresence` route crossfade |
| Backend | Vectorize pandas, index + SQL-filter the graph, TTL-cache queries | n/a |

## 4. Frontend engine fixes

### 4a. DataTable — kill the re-sort churn (biggest win)

**Root cause:** `DataTable` receives `columns` as an inline array recreated on every
parent render. Its `sortedData` memo lists `columns` in its deps
(`DataTable.tsx:241`), so *any* keystroke or auto-refresh tick invalidates the memo and
re-runs `.sort()` + re-renders every row even when `data` is unchanged.

**Fix:**

1. Hoist each page's `columns` array to **module scope** (`const COLUMNS`) outside the
   component, for `QueryPage`, `FindingsPage`, `GraphPage`, `RedirectsPage`,
   `PatternTable`, `LogsPage`, `BlacklistPage`. Columns that need component state
   (e.g. `FindingsPage`'s `whitelistIndex` / `trackedIndex` / `busy`) move those
   lookups into the cell body via a ref (or onto the row-data model) so the column
   definitions stay referentially stable.
2. Stabilize the `sortedData` comparator — depend on `[data, sortKey, sortDirState,
   controlled]`, read `columns` via a ref (or extract a `sortData(rows, columns,
   key, dir)` pure helper).
3. Stabilize `rowId` — hoist to module scope / `useCallback` where it closes over
   nothing (most do: `f.id`, `${client_ip}|…`).

**Expected:** Query/Findings tables re-sort only on sort change or new data — not per
keystroke.

### 4b. QueryPage — collapse the triple filter

`QueryPage.tsx:691/695/699` runs `.filter()` over `actionFilteredItems` three times to
render footer counts. Replace with a single `useMemo` pass computing
`{ blocked, whitelisted, blacklisted }`. The `columns` `ListActionCell` callback uses a
functional `setResult`, so it can close over nothing and live in module scope.

### 4c. Sankey + charts — memoize and lighten

- Keep the existing `useMemo` around `toSankey` in `GraphPage`/`QueryPage`/
  `RedirectsPage`; ensure `SankeyDiagram`'s `sameNodes`/`sameLinks` diff keeps
  skipping `setOption` on identical data.
- `layoutIterations: 32 → 16`, dropping to `8` when `nodes.length > 60`. Sankey layout
  is ~O(iterations × nodes²) — the biggest single hover/resize cost.
- Cache `resolveColor` (`SankeyDiagram.tsx`) per theme in a ref; extend the existing
  `paletteChanged` check so the `getComputedStyle` calls don't re-run when tokens are
  unchanged.
- `TimelineChart`: wrap `linePath`/`areaPath` in `useMemo` on `points`.

### 4d. Page load / route switch

- `App.tsx` already lazy-loads all pages. Add `AnimatePresence` for the route
  crossfade (Section 5).
- Add `content-visibility: auto` + `contain-intrinsic-size` to below-the-fold panels
  via a `.cv-auto` utility so off-screen tables/charts skip layout/paint.
- Pause infinite animations (`animate-ping`, `animate-pulse`, `.edge-flow`) while the
  tab is hidden — a small `usePageVisible` hook + a `data-paused` attribute the CSS
  honors.

## 5. Cinematic motion layer (framer-motion)

New file `admin-ui/src/components/motion.tsx`. `transform`/`opacity` only.

### 5a. Primitives

1. **`<Reveal>`** — fades + slides up 12px + slight scale on `whileInView`
   (`viewport={{ once: true }}`, configurable `delay` for stagger).
2. **`<Stagger>` / `<StaggerItem>`** — parent staggers children via shared
   `staggerChildren`; used by table first-paint and ranked lists.
3. **`<AnimatedNumber>`** — count-up for StatCard values; animates prev→next over
   ~600ms expo-out.
4. **`<MotionPage>`** — route-transition wrapper used by `App.tsx` with
   `AnimatePresence mode="wait"` (fade + 8px rise).

### 5b. Attachment points

- Route changes → `AnimatePresence` crossfade (`App.tsx`).
- StatCards → `AnimatedNumber` (dashboard, query, graph, redirects).
- Tables → `Stagger` on first paint of *visible* rows only (respects
  `internalPagination`, ≤ page-size rows).
- Sankey → entrance fade/rise + existing ECharts `animationDuration`
  (`SankeyDiagram.tsx:187`), tuned down for large graphs.
- Bulk-action bar → `AnimatePresence` slide/scale when `selected.size` changes.
- Theme switch → confirm the app-shell background crossfade is smooth.

### 5c. Discipline rules

- **No `layout` prop** — only `transform`/`opacity` (FLIP layout measurement is the
  expensive path).
- **Tween, not spring** — expo-out everywhere, matching the existing curve.
- **`MotionConfig reducedMotion="user"`** at root.
- **`once: true` everywhere** — reveals never replay.
- **Budget:** < 3KB authored motion code + framer-motion (~50KB, ~14KB gzip),
  lazy-split so it loads with the first animated page.

## 6. Backend changes

Three independent, testable changes. Python only, no new dependencies.

### 6a. `findings_graph` — SQL-filter + index (drop the Python scan)

Current (`findings.py:11-53`): full `GROUP BY` scan, fetch all rows, then `re.search`
per row in Python for whitelist exclusion.

**Fix:**

1. Add indexes in `init_db()` (`database.py`):
   `CREATE INDEX IF NOT EXISTS idx_findings_url ON findings(url)`,
   `idx_findings_base_url ON findings(base_url)`.
2. Push whitelist exclusion into SQL via `NOT LIKE` / `NOT GLOB` clauses built from
   the patterns' literal cores (`*`→`%`, `?`→`_`). Patterns that can't be safely
   translated fall back to the existing Python `re.search` for *those* rows only —
   correctness preserved, fast path for the common case.
3. Add a bounded `LIMIT` to the grouped query so a large table can't materialize
   unbounded memory, and move per-layer top-N to `ORDER BY count DESC LIMIT ?` where
   cheap.

### 6b. Vectorize pandas + reuse ES client

- `store_findings` (`monitor.py:238-267`) — replace `df.iterrows()` with
  `itertuples(index=False)` or `df.to_numpy()` + list comprehension.
- `_build_items` (`monitor.py:469`) — replace the per-row `rx.search(url)` Python loop
  with vectorized `df["url"].str.contains(...)` per pattern. Biggest single backend
  win.
- `apply_filters` (`monitor.py:230`) — `df["url"].astype(str).apply(_extract_base_url)`
  → vectorized `.str.split("/").str[2]` (with the existing `len < 3` guard).
- ES client: already one client per request; keep as-is (no churn to fix).

### 6c. TTL cache for identical auto-refresh queries

Module-level in-memory TTL cache (~2s) keyed on
`(minutes, search, exclude_whitelist, exclude_blacklist, block-pattern-fingerprint,
whitelist-fingerprint)`. Identical duplicate ticks within the TTL return the cached
`result` dict instead of hitting ES. The short TTL only collapses *identical duplicate*
ticks — auto-refresh at 30s+ still sees fresh data on every distinct tick.

## 7. Testing & verification

- **Frontend:** `npm run build` (tsc + vite) must pass; `npm run lint` (oxlint) clean.
  Manual check: type in the Query/Findings search box and confirm the table no longer
  re-sorts/re-renders per keystroke (React DevTools "Highlight updates").
- **Backend:** `pytest` passes; `ruff check` clean. Add/adjust tests for the
  `findings_graph` whitelist SQL filter (fast path + fallback parity) and the TTL cache.
- **Reduced motion:** with OS `prefers-reduced-motion` on, confirm all motion collapses
  to instant (framer + CSS both).
- **No fake completion:** no `TODO`/placeholder/stub/`.only`/`test.skip` in changed
  files.

## 8. Out of scope

- Re-theming or changing the design tokens / visual identity.
- Replacing Radix primitives or ECharts with another library.
- Redis / distributed caching (the TTL cache is deliberately in-process and short).
- Re-architecting the Elasticsearch index mappings.
