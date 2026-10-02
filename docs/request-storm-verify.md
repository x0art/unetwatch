# Request Storm Fix — Independent Verification

**Date:** 2026-10-02
**Base commit:** `b87d7b3` (verifier read-only; working tree left exactly as found)
**Verdict:** **PARTIALLY FIXED** — the storm is eliminated and the backend is correct, but the
frontend gate introduced **three functional regressions**: three pages no longer refetch on
user control changes. See §5.

This report quotes real command output and real measurements. Where a claim in the brief is
false it is called out explicitly (§1, §3.5).

---

## 1. Gates (Step 1)

| Gate | Command | Result | Expected | Match |
|---|---|---|---|---|
| admin build/tsc | `npm run build` | `✓ built in 2.26s` (exit 0) | exit 0 | ✅ |
| admin lint | `npm run lint` | **23 warnings, 0 errors** | 23/0 | ✅ |
| pytest | `.venv/bin/python -m pytest -q` | **1 failed, 466 passed, 3 warnings in 36.69s** | 1 failed / 466 passed | ✅ |
| ruff | `.venv/bin/ruff check app/` | **Found 39 errors** | "unchanged from baseline (90)" | ⚠️ see below |
| git status | `git status --short` | 17 modified, untracked `brag-output/` + `docs/request-storm-audit.md` | same | ✅ |

Exact failing test (the known pre-existing one):
```
FAILED tests/test_hosts.py::test_persisted_fallback_reports_same_domain_shape - assert 0 == 2
```

**Brief claim FALSE — the ruff baseline is not 90.** Measured by stashing the changes and
re-running: baseline (stashed) = **40 errors**, current tree = **39 errors**. The change *reduced*
ruff by one (a per-file diff shows only `app/main.py`: 4 → 3 findings). No file gained a ruff
error. The "90 errors pre-existing" figure in the brief is simply wrong; the real number is ~39–40
and the change is a net improvement, not "unchanged".

**Brief claim FALSE — untracked file name.** The brief says the new doc is `docs/*.md`; the only
new doc is `docs/request-storm-audit.md` (the diagnosis, not this file). I created
`docs/request-storm-verify.md` (this file) as instructed.

No stray files: untracked is exactly `brag-output/` + `docs/request-storm-audit.md`. (I
transiently created `unetwatch.db.instance-lock` while testing the backend lock; it was removed.)

---

## 2. `active` wiring table (all rendered pages)

`git grep -n 'active={view ===' admin-ui/src/App.tsx` — every rendered page block, its `active`
prop line, the matching `visited.has("…")` guard line, and the id literal:

| Page component | `active` line | `visited.has` line | id literal | Match |
|---|---|---|---|---|
| `DashboardPage` | `App.tsx:268` `active={view === "dashboard"}` | `:265` | `"dashboard"` | ✅ |
| `QueryPage` | `:281` `active={view === "query"}` | `:279` | `"query"` | ✅ |
| `PatternTable` | `:286` `active={view === "patterns"}` | `:284` | `"patterns"` | ✅ |
| `FindingsPage` | `:291` `active={view === "findings"}` | `:289` | `"findings"` | ✅ |
| `BlacklistPage` | `:296` `active={view === "blacklist"}` | `:294` | `"blacklist"` | ✅ |
| `JaillistPage` | `:301` `active={view === "jaillist"}` | `:299` | `"jaillist"` | ✅ |
| `RedirectsPage` | `:306` `active={view === "redirects"}` | `:304` | `"redirects"` | ✅ |
| `LogsPage` | `:311` `active={view === "logs"}` | `:309` | `"logs"` | ✅ |
| `HostInspectorPage` | `:316` `active={view === "host"}` | `:314` | `"host"` | ✅ |
| `UrlInvestigationPage` | `:321` `active={view === "url"}` | `:319` | `"url"` | ✅ |
| `AnalyticsPage` | `:326` `active={view === "analytics"}` | `:324` | `"analytics"` | ✅ |

All 11 id literals match their guards. **The brief's list of "all 10 rendered pages" is
incomplete**: `AnalyticsPage` is a real sidebar page (`Sidebar.tsx:141`) and is correctly wired as
the 11th. `AttckFleetPage` and `ReportPage` (report-host/report-url, `App.tsx:331/336/341`) render
without an `active` prop, but neither uses `useAutoRefresh` nor an empty-dep mount fetch, so they
do not poll and are not storm sources.

---

## 3. Gated-effect audit

`utils.ts:103-154` — `useAutoRefresh(refresh, key, defaultSeconds = 0, enabled = true)`. When
`enabled` is false the effect early-returns **before** `setInterval` (`:138`) and `enabled` is in
the dep array (`:151`), so an inactive page holds **no timer**. Correct.

Per-page mount-fetch gate:

| Page | Gated effect (file:line) | Deps | Verdict |
|---|---|---|---|
| Dashboard | `DashboardPage.tsx:137-147` (counts), `:184-191` (recent) | `[active]` ×2 | ✅ callbacks stable (toast/refs), no user control lost |
| Query | `QueryPage.tsx:703-706` | `[active, fetchQuery]` | ✅ **correct shape** — filter/time changes refetch |
| Query badge | `QueryPage.tsx:581-599` | `[active]` | ✅ badge only |
| Patterns | `PatternTable.tsx:257-260` | `[active, fetchPatterns]` | ✅ **correct shape** |
| **Findings** | `FindingsPage.tsx:401-412` | **`[active]`** | ❌ **REGRESSION** (§5.1) |
| Findings indexes | `FindingsPage.tsx:466-472` | `[active, refetchIndexes]` | ✅ correct shape |
| Blacklist | `BlacklistPage.tsx:386-391` | `[active]` | ✅ `load` deps `[splitLines, toast]`; filter is client-side |
| Jaillist | `JaillistPage.tsx:100-105` | `[active]` | ✅ same as Blacklist |
| **Redirects** | `RedirectsPage.tsx:412-424` | **`[active]`** | ❌ **REGRESSION** (§5.2) |
| Logs | `LogsPage.tsx:630-633` | `[active, load]` | ✅ **correct shape** |
| Host index | `HostInspectorPage.tsx:405-421` | `[active]` | ✅ badge only; data via `globalFilter` effect `:427` |
| Url index | `UrlInvestigationPage.tsx:94-110` | `[active]` | ✅ badge only; data via `globalFilter` effect `:173` |
| **Analytics** | `AnalyticsPage.tsx:222-232` (all), `:266-272` (raw) | **`[active]` ×2** | ❌ **REGRESSION** (§5.3) |

Summary: **9 correct, 3 regressions** (Findings, Redirects, Analytics). The correct pages
(Query, Patterns, Logs) use the `[active, cb]` form the brief describes; the regressions use
`[active]` with the callback deliberately excluded.

---

## 4. The critical proof — is the storm gone? (Step 2)

### 4.1 Static request tally (defaults)

`useAutoRefresh` call sites and their default intervals:
- `DashboardPage.tsx:200` — `"dashboard", 60` → **polls every 60 s** (only page that polls by default)
- `QueryPage.tsx:711` — `"query", 0` → off
- `FindingsPage.tsx:416` — `"findings", 0` → off
- `AnalyticsPage.tsx:234` — `"analytics", 0` → off

All intervals are persisted per key in `localStorage`, so a user who set a non-zero interval keeps it.

For a user who has visited A,B,C,D and now sits on ONE page, the request rate from *hidden*
pages:

| | Before | After |
|---|---|---|
| Inactive page mount-fetches | re-fire on every parent re-render | 0 (early return) |
| Inactive page `useAutoRefresh` | timer always armed | **no timer armed** |
| Inactive page arrival-fetch | n/a | 0 until `active` flips true |

With defaults (only Dashboard polls at 60 s, others off):
- **Before:** every visited page's mount effect re-fires on any Dashboard tick *and* the Dashboard
  timer itself runs; hidden pages also re-render and re-run their effects. Measured below.
- **After:** hidden pages contribute **0**. Active Dashboard contributes **1 req/60 s** for
  `refreshAll` (`onRefresh` + `fetchRecent`). Active non-polling page contributes **0**.

### 4.2 Inactive page arms no timer (quote)

`admin-ui/src/lib/utils.ts:134-151`:
```ts
useEffect(() => {
  // A disabled (inactive-view) page never arms a timer: returning before
  // setInterval means there is nothing to clear, ...
  if (!enabled || !refreshSeconds) return
  const id = window.setInterval(() => { ... }, refreshSeconds * 1000)
  return () => window.clearInterval(id)
}, [refreshSeconds, refresh, enabled])
```
Inactive ⇒ `enabled === false` ⇒ returns at `:138` before `setInterval`. Quoted verbatim.

### 4.3 Gated mount-fetch early-returns (quote)

`FindingsPage.tsx:401-412`:
```ts
useEffect(() => {
  if (!active) return
  void refetch()
  // eslint-disable-next-line react-hooks/exhaustive-deps
}, [active])
```
Same shape in `RedirectsPage.tsx:412-424`, `AnalyticsPage.tsx:222-232`, `BlacklistPage.tsx:386-391`,
`JaillistPage.tsx:100-105`, `DashboardPage.tsx:137-147`. All early-return on `!active`.

### 4.4 First visit still loads immediately (reasoning)

A page only enters `visited` when `handleNavigate` runs (`App.tsx:205-208`), which also sets
`view = next`. React batches both state updates, so when the `<div hidden>` block mounts, the
prop `active={view === "<id>"}` is **already `true` on first render**. The gated effect's dep is
`[active]`; it runs on mount with `active === true` and fetches immediately. There is no "first
render with active=false then flip" cycle. Confirmed empirically: the arrival baseline in §4.5 is
non-zero (11) — pages fetch on first navigation.

### 4.5 Empirical demonstration (Playwright, real Chromium)

I ran a real browser (`playwright-core` 1.63 + Chromium 1243, already installed), intercepted
`/api/**` with a request-counting route handler, navigated via the sidebar to 3–4 pages, then sat
on **Findings** for 30 s. I measured **both** the pre-fix (stashed) and post-fix builds served by
the same Vite dev server (`npm run dev -- --port 5197 --strictPort`).

| Build | Nav to | Sit on | Post-arrival baseline | Next 30 s | Requests/min (steady) |
|---|---|---|---|---|---|
| **OLD** (fix stashed) | findings, redirects, analytics | findings | 149 | **+1111** | **≈ 2222** |
| **NEW** (fix applied) | findings, redirects, analytics | findings | 11 | **+0** | **0** |
| **OLD** | findings, redirects, analytics, logs | findings | — | 1260 total | ≈ 2520 |
| **NEW** | findings, redirects, analytics, logs | findings | 11 | **+0** | **0** |

Raw per-endpoint (OLD, 30 s sitting on Findings): `/api/findings/` ×370, `/api/redirects/` ×123,
`/api/redirects/graph` ×123, `/api/analytics/summary` ×123, `/api/analytics/bandwidth` ×123,
`/api/analytics/enforcements` ×123, `/api/analytics/top-domains` ×124, `/api/analytics/top-clients`
×124 — the exact shape of the reported storm, reproduced.

Raw per-endpoint (NEW, same 30 s): **all zero** in the steady window (the 5–6 requests in the
arrival burst are the arrival refetch of the newly-active page + its badge endpoints).

This is a **real measurement, not a static argument**. Conclusion: **the frontend storm is
eliminated** — 0 requests/min steady-state vs ≈2200/min before.

(I cleaned up: dev server stopped, temp probe scripts and JSON removed.)

---

## 5. Regression sweep (Step 4) — the fix broke three pages

The brief warned: *"an effect like `[active]` drops the filter deps and breaks
refetch-on-filter-change … That is a functional regression, not a fix."* That is exactly what
happened on three pages. The original code keyed the mount effect on the **callback** (`[load]`,
`[fetchAll]`, `[refetch]`), whose `useCallback` deps were the user controls; changing to `[active]`
dropped them.

### 5.1 FindingsPage — search / page / page-size no longer refetch

`admin-ui/src/components/FindingsPage.tsx:401-412`
```ts
useEffect(() => {
  if (!active) return
  void refetch()
  // eslint-disable-next-line react-hooks/exhaustive-deps   ← deps dropped
}, [active])
```
Before (`git show HEAD`):
```ts
useEffect(() => { void refetch() }, [refetch])
```
`refetch` deps are `[run, gen, debouncedSearch, page, pageSize]` (`:399`). Controls that now do
**nothing**: the search box (`handleSearchChange` `:474-477` → `setSearch`), `onPageChange={setPage}`
(`:751`), `onPageSizeChange` (`:749`). None call `refetch` directly.

**Repro (real browser, fixed build):** type `example.com` in the Findings search, wait 1.5 s, click
Next → **0** `/api/findings/` requests. Same interaction on the OLD build → **50** `/api/findings/`
requests. The comment at `:406-408` ("re-running on those changes is the existing (separate)
mount-effect's job") is **false** — that mount effect is this very effect, and it is `[active]`.

### 5.2 RedirectsPage — search / page / sort no longer refetch the table

`admin-ui/src/components/RedirectsPage.tsx:412-424`
```ts
useEffect(() => {
  if (!active) return
  void loadTable()
  void loadGraph()
  // eslint-disable-next-line react-hooks/exhaustive-deps
}, [active])
```
Before, two effects:
```ts
useEffect(() => { void loadTable() }, [loadTable])   // loadTable deps: debouncedSearch, page, pageSize, sortBy, sortDir
useEffect(() => { void loadGraph() }, [loadGraph])
```
The comment at `:417-419` ("`loadTable` re-runs on every search/page/sort change (its own effect)")
is **false**: `loadTable` is only ever called from this one `[active]` effect plus `reload`
(`:426-429`, wired to add/delete actions). Grep confirms: `loadTable` appears at `:347` (def),
`:421` (this effect), `:427` (`reload`).

**Repro (fixed build):** type in the Redirects search → **0** `/api/redirects/` requests. OLD build →
**12**.

### 5.3 AnalyticsPage — range / compare / raw search / raw page no longer refetch

`admin-ui/src/components/AnalyticsPage.tsx:222-232` (aggregates) and `:266-272` (raw table):
```ts
useEffect(() => {
  if (!active) return
  void fetchAll()      // fetchAll deps: range, compare   → dropped
  // eslint-disable-next-line react-hooks/exhaustive-deps
}, [active])
...
useEffect(() => {
  if (!active) return
  void fetchRaw()      // fetchRaw deps: range, rawSearch, rawPage → dropped
  // eslint-disable-next-line react-hooks/exhaustive-deps
}, [active])
```
Before: `[fetchAll]` and `[fetchRaw]`. Controls that now do nothing: the date-range `Select`
(`:691` `setRange`), the compare `Select` (`:697` `setCompare`), the raw search (`:843`) and raw
pager (`:878` `setRawPage`). The code comment at `:274` ("Refetch when search/range/page changes")
describes behaviour that no longer exists. Note `setRange` comes from shared `useFilter()`, so a
range change *anywhere* also fails to refresh Analytics now.

**Repro (fixed build):** change range 7d→30d → **0** `/api/analytics/summary` requests. OLD build →
**48**.

### 5.4 Not regressed

- **First load** works on every page (verified: arrival baseline non-zero; grep shows only the
  three pages above dropped a control dep).
- **Cancellation guards** (`useAbortable`/`useGeneration`), never-blank, skeletons, a11y: the diffs
  are additive (a `active` prop + a gate); no guard, skeleton, or `aria-*` was touched. `npm run
  build` (tsc) and lint are green. ✅
- **Response shape/status:** see §6.4 — unchanged.

---

## 6. Backend verification (Step 3)

### 6.1 Same LIMIT window (no broader scan)

`_findings_bandwidth` `analytics.py:483` and `_findings_enforcements` `:538` both wrap
`(SELECT * FROM findings WHERE 1=1{where} LIMIT 20000)`; `_findings_summary` `:319` and
`_previous_period_summary` `:436` use `LIMIT 10000`. Identical to the old `LIMIT`. ✅

### 6.2 Bucket ordering

Old code returned `list(buckets.values())` from an un-ordered `SELECT * … LIMIT 20000`; new code
returns `[buckets[d] for d in sorted(buckets)]` / `ORDER BY day`. In my synthetic **random-order**
DB the two differ (old = insertion order); but findings are inserted **chronologically**, and with
a chronological-insert fixture the old insertion order **equals** ascending order (verified: `OLD
order == NEW sorted order: True`). The chart consumes `points` in array order with no client sort
(`AnalyticsPage.tsx:604-605`, `TrendCharts.tsx:114`). So the new ascending order is what production
always effectively produced, and it is deterministic. **Not a regression; strictly better.** ✅

### 6.3 Null/absent-byte semantics; DST path

`_bytes_expr` (`:192-204`) yields `CAST(col AS INTEGER)` only for a pure digit run, else NULL —
matching `_persisted_bytes` (`absent ≠ 0`). `_findings_summary` sets
`total_volume = int(agg["volume"]) if agg["measured"] else None` (`:347`), matching
`_volume_for_bytes` (None iff no row had any counter). ✅

DST path: `_fixed_offset_minutes()` (`:220-252`) samples the operator zone's utcoffset daily over
4 years; a zone with >1 distinct offset returns `None`, forcing the exact Python per-row path
(`local_day`/`local_hour_bucket`) at `:506-520` (bandwidth), `:557-568` (enforcements),
`:388-397` (peak hour). Verified:
```
UTC                  distinct=1 -> SQL
+07:00               distinct=1 -> SQL
Asia/Bangkok         distinct=1 -> SQL
America/New_York     distinct=2 -> Python(DST)
```
✅ The complaint in the brief (DST zones keep the Python path) is **true**.

### 6.4 Differential test — old Python loop vs new SQL

I wrote a 20 000-row synthetic temp DB (random `action` ∈ ALLOW/DENY/FLAG/mixed-case/empty/NULL,
`matched_patterns` ∈ JSON-list/empty/None/garbage, `bytes_downloaded`/`uploaded` ∈ NULL/""/0/digits/
garbage, `base_url` ∈ parseable/empty/None), then ran **both** the `HEAD` implementations and the
current ones over windows `{0, 60, 1440, 4320, 10080, 43200}` in zones `{UTC, +07:00, Asia/Bangkok,
America/New_York}`, for `_findings_summary`, `_previous_period_summary`, `_findings_bandwidth`,
`_findings_enforcements`.

> **Result: 0 mismatches** (values), across all 4 functions × 6 windows × 4 zones, once bucket
> order is normalised (see §6.2) and the probe's own extra key is excluded.

This **reproduces the previous worker's parity claim** for values. Separately, an exhaustive
edge-case check of the SQL day/hour reconstruction vs the Python helpers — ~9 600 timestamps
(4 full years of hour boundaries + malformed + empty) × 4 fixed-offset zones incl. `+05:30`/`-03:30`
— gave **0 day mismatches, 0 hour mismatches**.

**One real divergence found (narrow): `_RISK_SQL` vs `bool(_parse_matched_patterns(...))`.** The SQL
treats any `matched_patterns` beginning with `[` (and not exactly `[]`) as truthy; Python uses
`json.loads`:
```
mp='[ ]'        python=0 sql=1   <<< MISMATCH
mp='[\n]'       python=0 sql=1   <<< MISMATCH
mp='["a", ]'    python=0 sql=1   <<< MISMATCH
mp='[,]'        python=0 sql=1   <<< MISMATCH
mp='["a"] extra' python=0 sql=1  <<< MISMATCH
```
7 such cases among 18 probes. Affects `totalRisk`/`totalBlacklistedRisk` only on rows whose stored
`matched_patterns` is malformed-but-bracket-prefixed JSON. The app writes this column via its own
`json.dumps` (always valid) or `""`, so this requires corrupt/external data. **Low severity, but a
genuine semantic drift the brief did not mention.** (`_ENF_SQL` and the legacy `_RISK_SQL_LEGACY`
branch match Python exactly.)

### 6.5 `main.py` worker/singleton logic

`run()` (`main.py:433-450`): `workers = max(1, int(os.getenv("UNETWATCH_WORKERS", "1")))`, passed as
`uvicorn.run(..., workers=workers)`. With the env unset → `workers=1`. Inspecting uvicorn 0.52.1
`config.py:268` (`self.workers = workers or 1`) and `main.py:110` (`if config.reload or
config.workers > 1`), `workers=1` takes the **single-`Server` path**, identical to the old default
(`workers=None` → normalised to 1). **Behaviour is byte-identical for the default.** ✅

One nit: the old code did not pass `workers` at all, so `WEB_CONCURRENCY` could override it; the new
code's explicit `workers=1` overrides `WEB_CONCURRENCY`. Almost certainly a *fix*, but it is a
behaviour change for anyone relying on `WEB_CONCURRENCY`.

Singleton lock (`_acquire_singleton_lock` `:62-95`, gate in `lifespan` `:106-112`): fcntl `flock`
`LOCK_EX|LOCK_NB` on `<db>.instance-lock`; on failure the process logs a warning and `yield`s
(serves requests, skips scheduler/seed/feed-regen). On filesystems without flock it **fails open**
(returns True) by design. Empirically verified with two processes:
```
child 3797902 acquired=True      # first process: owns scheduler
child 3797966 acquired=False     # second process: API-only, not blocked
```
✅ The lock prevents a second process from starting the scheduler, and the second process still
serves requests (its lifespan yields normally).

### 6.6 Redirects/database "no change" claims

`git diff` is comment-only for both. The claim that the correlated subquery is already index-served
is **verified** via EXPLAIN QUERY PLAN on the real DB:
```
SEARCH e USING COVERING INDEX sqlite_autoindex_redirect_edges_1 (source_url=?)
```
The `UNIQUE(source_url, target_url)` constraint provides the left-prefix index. ✅ No change needed —
correctly documented, not silently altered.

### 6.7 Tests

46 analytics tests pass (`pytest -k "analytics or bandwidth or enforcement or summary or previous"`).
The suite asserts bucket **membership** (sets), not order, so it does not independently pin the
ordering — my differential (§6.4) does.

---

## 7. Final verdict

**PARTIALLY FIXED.**

What is verified good:
- **The storm is gone.** Real-browser measurement: ≈2200 req/min while idle → **0 req/min**. The
  `active` gate + `enabled` parameter work exactly as described.
- **Backend semantics preserved** for all four rewritten functions (0 mismatches over 4 functions ×
  6 windows × 4 zones), same LIMIT windows, correct DST split, unchanged response shapes.
- **Singleton lock works**; default worker count is byte-identical.
- Full test suite, tsc build, and lint are green (with the one known pre-existing failure).

**Most important remaining issue:** the fix traded a request storm for **three silent functional
regressions** where user controls no longer refetch:
1. **Findings** — search, page, page-size (`FindingsPage.tsx:401-412`, deps `[active]`, should be
   `[active, refetch]`).
2. **Redirects** — search, page, sort (`RedirectsPage.tsx:412-424`, deps `[active]`; split back into
   `[active, loadTable]` + `[active, loadGraph]`).
3. **Analytics** — range, compare, raw search, raw page (`AnalyticsPage.tsx:222-232` and `:266-272`,
   deps `[active]`, should be `[active, fetchAll]` / `[active, fetchRaw]`).

These are the exact failure mode the brief warned about; the inline comments on all three pages
assert a "separate effect" re-runs the callbacks, which is false. Secondary issue: the `_RISK_SQL`
bracket-prefix approximation diverges from Python `json.loads` on malformed `matched_patterns`
(§6.4) — low severity. Tertiary: the brief's ruff baseline ("90 errors") and doc filename are wrong
(§1).

The three one-line dep-array corrections are required before this can be called a fix rather than a
trade.
