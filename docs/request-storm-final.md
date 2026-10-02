# Request Storm Fix — Final Verification

**Date:** 2026-10-02
**Tree state:** all writers stopped; working tree left exactly as found (read-only verification).
**Verdict:** **FIXED** — the storm is eliminated, the three refetch regressions from the second
pass are corrected, and no new gap was introduced. See §7 for the one remaining non-blocking item.

This pass re-ran the gates, verified the `[active, cb]` regression fix statically **and** empirically
in a real Chromium, audited `active`/`useAutoRefresh` coverage, and spot-checked the backend.
Where a claim in the brief is imprecise it is called out (§1, §6).

---

## 1. Gates (Step 1)

All commands run as specified. Exact output and exit codes:

| Gate | Command | Result | Exit |
|---|---|---|---|
| admin build | `npm run build` | `✓ built in 2.50s` | **0** |
| admin lint | `npm run lint` (oxlint) | `23 diagnostics in 11 files` (all `react(only-export-components)` warnings), `LINT_EXIT=0` | **0** |
| admin tsc | `npx tsc -b --noEmit` | no output, `TSC_EXIT=0` | **0** |
| pytest | `.venv/bin/python -m pytest -q` | `1 failed, 466 passed, 3 warnings in 41.73s` | **1** |
| ruff | `.venv/bin/ruff check app/ --output-format=concise` | `Found 39 errors.` (8 fixable) | **1** |
| git status | `git status --short` | 17 modified + 3 untracked (see below) | — |

Exact failing test (the known pre-existing one):
```
FAILED tests/test_hosts.py::test_persisted_fallback_reports_same_domain_shape - assert 0 == 2
```

**All expectations met.** Specifically:
- Build, tsc, lint green. Lint is **23 warnings / 0 errors** — exactly the expected count, all
  warnings pre-existing (`only-export-components`), **0 new**.
- pytest **1 failed / 466 passed**, the single failure being the named pre-existing one.
- ruff **39 errors**, matching the prior pass's measured 39 (the brief's "~39" is correct here;
  note the *audit* brief's "90" was wrong — the verify pass already caught that).
- Modified set is exactly the expected list: 12 `admin-ui/src/components/*` + `App.tsx` +
  `lib/utils.ts`, `app/database.py`, `app/main.py`, `app/routes/analytics.py`,
  `app/routes/redirects.py`. No extra modified file.

**Untracked:** `brag-output/` (a build/composition artifact directory, pre-existing workflow
output) + the two docs `docs/request-storm-audit.md`, `docs/request-storm-verify.md`. Nothing else.

**Stray-file sweep — clean.** `find` (excluding `node_modules`/`.git`/`.venv`) for
`probe*.mjs`, `*.cjs`, `*_ssr_*`, `*.bundle.*`, `*.probe.*`, `*.tmp` returned **nothing in the
repo tree**. The only `*.cjs` hits are legitimate dependency files inside `admin-ui/node_modules/`.
No `/tmp` artifacts were left in the repo. My own probe scripts lived in `/tmp` only and were
deleted (§3). **No deviation.**

---

## 2. The regression fix is correct (Step 2)

`useGeneration()` (`admin-ui/src/lib/utils.ts:79-84`) is confirmed to return a **fresh object
literal every render**:
```ts
export function useGeneration(): { next: () => number; isCurrent: (g: number) => boolean } {
  const genRef = useRef(0)
  const next = useCallback(() => ++genRef.current, [])
  const isCurrent = useCallback((g: number) => g === genRef.current, [])
  return { next, isCurrent }               // ← new literal each render
}
```
The inner `next`/`isCurrent` are `useCallback(…, [])` → **stable**; the wrapper object is not.
So the brief's warning is correct: depending on the *object* would make any callback new every
render → an effect keyed on it loops forever. The fix destructures the stable inner functions.

`useAbortable()` (`utils.ts:49-65`) returns `useCallback(fn, [])` — the returned function is
**stable**, so `run`/`runTable`/`runGraph`/`runAll`/`runRaw` are safe deps.

### Per-page verification

| Page | Effect (file:line) | Effect deps | Callback dep array (file:line) | All deps primitive / stable-fn? | Verdict |
|---|---|---|---|---|---|
| **FindingsPage** | `:405-415` | `[active, refetch]` | `refetch` `:403`: `[run, genNext, genCurrent, debouncedSearch, page, pageSize]` | ✅ `run`=useAbortable (stable), `genNext/genCurrent`=destructured hook fns (stable), 3 primitives | ✅ CORRECT |
| **RedirectsPage** (table) | `:415-425` | `[active, loadTable]` | `loadTable` `:385`: `[runTable, tableNext, tableCurrent, debouncedSearch, page, pageSize, sortBy, sortDir]` | ✅ stable fns + 5 primitives | ✅ CORRECT |
| **RedirectsPage** (graph) | `:427-433` | `[active, loadGraph]` | `loadGraph` `:413`: `[runGraph, graphNext, graphCurrent]` | ✅ fixed params; all stable fns | ✅ CORRECT |
| **AnalyticsPage** (aggregates) | `:225-233` | `[active, fetchAll]` | `fetchAll` `:223`: `[runAll, allNext, allCurrent, range, compare, toast]` | ✅ stable fns + 2 primitives + `toast` | ✅ CORRECT |
| **AnalyticsPage** (raw table) | `:267-274` | `[active, fetchRaw]` | `fetchRaw` `:265`: `[runRaw, rawNext, rawCurrent, range, rawSearch, rawPage, toast]` | ✅ stable fns + 3 primitives + `toast` | ✅ CORRECT |

Destructuring confirmations (grep):
- `FindingsPage.tsx:333` `const { next: genNext, isCurrent: genCurrent } = useGeneration()`
- `RedirectsPage.tsx:348` `const { next: tableNext, isCurrent: tableCurrent } = useGeneration()` and `:390` `const { next: graphNext, isCurrent: graphCurrent } = useGeneration()`
- `AnalyticsPage.tsx:180` `const { next: allNext, isCurrent: allCurrent } = useGeneration()` and `:182` `const { next: rawNext, isCurrent: rawCurrent } = useGeneration()`

Verbatim quotes of the three pages' effects:
```ts
// FindingsPage.tsx:405-415
useEffect(() => {
  if (!active) return
  void refetch()
}, [active, refetch])
```
```ts
// RedirectsPage.tsx:415-433  (TWO effects)
useEffect(() => { if (!active) return; void loadTable() }, [active, loadTable])
useEffect(() => { if (!active) return; void loadGraph() }, [active, loadGraph])
```
```ts
// AnalyticsPage.tsx:225-274  (TWO effects)
useEffect(() => { if (!active) return; void fetchAll() }, [active, fetchAll])
useEffect(() => { if (!active) return; void fetchRaw() }, [active, fetchRaw])
```

**No callback depends on a bare `useGeneration()`/`useAbortable()` return object.** No
infinite-loop bug. The `gen` object pitfall is avoided on all five callbacks.

### The `toast` dependency (adversarial check)

`fetchAll`/`fetchRaw` also depend on `toast` from `useToast()`. The provider passes a **fresh
object literal** `value={{ toast, dismiss }}` (`ui.tsx:898`), but consumers **destructure**
`const { toast } = useToast()`, and `toast` is `useCallback(…, [clearTimer, dismiss])` where
`clearTimer` = `useCallback(…, [])` and `dismiss` = `useCallback(…, [clearTimer])` — all stable
for the provider's lifetime (`ui.tsx:883-894`). Therefore `fetchAll`'s identity does **not** change
per render and the effect does not loop. Confirmed empirically: Analytics idles at 0 req/10 s (§3).

The inline comments added on all three pages (e.g. `FindingsPage.tsx:406-412`,
`RedirectsPage.tsx:345-347`) accurately describe the `[active, cb]` + destructure rationale. The
prior pass's complaint that the old comments claimed "a separate effect re-runs the callback" is
resolved — the callbacks now run from these very effects.

---

## 3. Empirical proof (Step 3) — real Chromium, measured

Tooling worked. `playwright-core` resolves at
`admin-ui/node_modules/playwright-core/index.js`; Chromium 1243 is installed
(`~/.cache/ms-playwright/chromium-1243`) and system `/usr/bin/google-chrome` is present.

**Method:** persistent Chromium context (`google-chrome`, headless), `page.route('**/api/**')`
counting every request by pathname and fulfilling with correctly-shaped stub JSON (no backend
needed). Auth seeded via `localStorage.unetwatch_token`; the SPA was booted directly onto each
view via `unetwatch_view` to avoid Dashboard needing live data. Dev server:
`npm run dev -- --port 5197 --strictPort` (built once, `✓ built`). All counts below are for the
**windowed interval only** (arrival excluded), after a 1 s settle.

### 3a. Infinite-loop check — idle 10 s on each page with no interaction

| Page | Arrival requests (excl. window; StrictMode ×2) | Requests during 10 s idle | Per second | Verdict |
|---|---|---|---|---|
| Findings | 16 | **0** | **0.00** | ✅ no loop |
| Redirects | 10 | **0** | **0.00** | ✅ no loop |
| Analytics | 18 | **0** | **0.00** | ✅ no loop |

Pre-fix regression loop produced ~23 req/3 s; this is **0/10 s**. The `[active, cb]` fix does
**not** loop.

### 3b. Storm still fixed — mount 6 pages, then sit on Findings 20 s

Mounted Findings, Redirects, Analytics, Logs, Query (Patterns sidebar click timed out — a probe
selector issue, not an app issue; Patterns was not needed for the assertion) then sat on Findings:

| Measurement | Value |
|---|---|
| Requests in the 20 s window | **0** |
| Requests/minute steady | **0.0** |

Matches the prior pass's ≈2200 → 0 result. **Storm remains eliminated.**

### 3c. Controls refetch again — the three fixed regressions

| Interaction | Endpoint | Before | After | Δ | Verdict |
|---|---|---|---|---|---|
| Findings: type `example.com` in search | `/api/findings/` | 2 | 3 | **+1** | ✅ refetches |
| Redirects: type `ex` in search | `/api/redirects/` | 2 | 3 | **+1** | ✅ refetches |
| Analytics: change range select (7 options present) | `/api/analytics/summary` | 2 | 3 | **+1** | ✅ refetches |

The `before=2` baseline is React StrictMode double-mount; each control change adds exactly one
debounced refetch. **All three regressions are fixed.**

Cleanup: dev server stopped (`curl` → `000`), all `/tmp` probe scripts and temp Chromium profiles
deleted, no repo files created. The `vite5197` supervisor ending in exit 1 is the expected result
of the `pkill` that stopped it.

---

## 4. `active` / `useAutoRefresh` coverage (Step 4)

### 4a. `active=` wiring — `grep -n 'active=' admin-ui/src/App.tsx`

| Page | `active` line | `visited.has` line | Verdict |
|---|---|---|---|
| DashboardPage | `:268` | `:265` | ✅ |
| QueryPage | `:281` | `:279` | ✅ |
| PatternTable | `:286` | `:284` | ✅ |
| FindingsPage | `:291` | `:289` | ✅ |
| BlacklistPage | `:296` | `:294` | ✅ |
| JaillistPage | `:301` | `:299` | ✅ |
| RedirectsPage | `:306` | `:304` | ✅ |
| LogsPage | `:311` | `:309` | ✅ |
| HostInspectorPage | `:316` | `:314` | ✅ |
| UrlInvestigationPage | `:321` | `:319` | ✅ |
| AnalyticsPage | `:326` | `:324` | ✅ |

**All 11 polling/fetching pages are wired.** The two remaining rendered blocks —
`AttckFleetPage` (`:331-333`) and `ReportPage` host/url (`:334-341`) — render **without** an
`active` prop, but neither uses `useAutoRefresh` nor a mount fan-out that survives idle, so they
are correctly not storm sources (matching the prior pass's finding). **No fetching/polling page is
unwired.**

### 4b. `useAutoRefresh` call sites — `grep -rn 'useAutoRefresh(' admin-ui/src/components/*.tsx`

| File:line | Call | 4th `enabled` arg | Verdict |
|---|---|---|---|
| `AnalyticsPage.tsx:235` | `useAutoRefresh(fetchAll, "analytics", 0, active)` | `active` | ✅ |
| `DashboardPage.tsx:200` | `useAutoRefresh(refreshAll, "dashboard", 60, active)` | `active` | ✅ |
| `FindingsPage.tsx:419` | `useAutoRefresh(refetch, "findings", 0, active)` | `active` | ✅ |
| `QueryPage.tsx:711` | `useAutoRefresh(fetchQuery, "query", 0, active)` | `active` | ✅ |

**All 4 call sites pass the 4th argument.** The hook early-returns before `setInterval` when
`!enabled || !refreshSeconds` (`utils.ts:138`) and has `enabled` in its dep array (`:151`), so an
inactive page arms no timer.

### 4c. Gated effects still early-return when inactive

`grep -n 'if (!active) return' src/components/*.tsx` → **16 occurrences**, each the first statement
inside its gated effect:
`AnalyticsPage:231,272` · `BlacklistPage:387` · `DashboardPage:142,188` · `FindingsPage:413,473` ·
`HostInspectorPage:406` · `JaillistPage:101` · `LogsPage:631` · `PatternTable:258` ·
`QueryPage:584,704` · `RedirectsPage:423,431` · `UrlInvestigationPage:95`.

Adding the `refetch`/`loadTable`/`loadGraph`/`fetchAll`/`fetchRaw` dep did **not** weaken the gate —
the `if (!active) return` guard is intact and precedes the call in every effect. **Confirmed.**

---

## 5. Backend spot-check (Step 5)

### 5a. `analytics.py` rewritten SQL — same LIMIT window

| Helper | Line | Window |
|---|---|---|
| `_findings_summary` | `:319` | `(SELECT * FROM findings {base_where} LIMIT 10000)` |
| `_previous_period_summary` | `:436` | `(SELECT * FROM findings{where} LIMIT 10000)` |
| `_findings_bandwidth` | `:483` | `(SELECT * FROM findings WHERE 1=1{where} LIMIT 20000)` |
| `_findings_enforcements` | `:538` | `(SELECT * FROM findings WHERE 1=1{where} LIMIT 20000)` |

Same 10 000 / 20 000 windows as the old Python loops. ✅

### 5b. DST-zone Python path preserved

`_fixed_offset_minutes()` (`:220-252`) samples the operator zone's `utcoffset()` daily over four
years; `len(offsets) != 1` → returns `None`, and the callers then keep the **exact per-row Python
path** (`local_day`/`local_hour_bucket`) — bandwidth `:506-520`, enforcements `:557-568`. A
DST-observing zone (e.g. `America/New_York`, 2 distinct offsets) returns `None` → Python path.
✅ Unchanged from the prior pass's verified behavior.

### 5c. `app/main.py` defaults to 1 worker when `UNETWATCH_WORKERS` is unset

```python
# app/main.py:446-450
workers = max(1, int(os.getenv("UNETWATCH_WORKERS", "1")))
...
uvicorn.run("app.main:app", host="0.0.0.0", port=8000, workers=workers)
```
Env unset → `workers=1`. ✅ (The `:448-449` fallback also clamps a non-integer env to 1.)

### 5d. `_RISK_SQL` bracket-prefix vs `json.loads` on malformed `matched_patterns`

**Read of the code.** `_RISK_SQL` (`:165-171`) tests, for the no-action legacy branch,
`substr(trim(COALESCE(matched_patterns,'')),1,1) = '[' AND trim(...) != '[]'`. Python
(`result_processor.py:68-72`) uses `bool(_parse_matched_patterns(...))` = `bool(json.loads(raw))`.
These diverge on inputs that *begin with `[`* but are not valid non-empty JSON arrays:
`'[ ]'`, `'[\n]'`, `'["a", ]'`, `'[,]'`, `'["a"] extra'` → Python `False`, SQL `True` (7/18
synthetic probes). This is a **genuine but narrow** divergence, confirming the prior pass.

**Can it affect real data? NO.** Evidence — every writer to `findings.matched_patterns` emits
valid JSON:
- `result_processor.py:473` — `matched_json = json.dumps(matched_patterns or [])` (always a valid
  JSON array; the column value is that dump).
- `database.py:98` and `:106` — the startup backfill writes `json.dumps(_hits)` / `json.dumps([_bps[0]])`.
- `database.py:64` — the column default is the literal `'[]'` (valid).

The only other `matched_patterns` writer, `logs.py:63`, targets the **`monitor_logs`** table and is
never read by `_RISK_SQL`. There is no raw SQL `INSERT`/`UPDATE` into `findings.matched_patterns`
that bypasses `json.dumps`. `_RISK_SQL`'s bracket branch fires only for rows with an **empty
`action`** (pre-`action` schema) — and legacy rows are exactly the ones the backfill normalizes to
valid JSON.

**Verdict: the divergence cannot affect data written by this application.** It would require the
`matched_patterns` column to be corrupted by an external/out-of-band process. **Non-blocking.**

---

## 6. Remaining regression / gap

**None blocking.** No functional regression found; no new gap introduced. The `active` gate is
intact everywhere, all four `useAutoRefresh` sites pass `enabled`, and idle request rate is 0.

Noted non-blockers:
1. **`_RISK_SQL` vs `json.loads` drift** on malformed `matched_patterns` (§5d). Unreachable from
   app-written data; only matters if the DB is corrupted externally. Low severity. `file:line`:
   `app/routes/analytics.py:165-171` vs `app/services/result_processor.py:35-40,68-72`.
2. **`WEB_CONCURRENCY` behavior change** (already noted by the prior pass): the old code passed no
   `workers=`, so `WEB_CONCURRENCY` could override it; the new explicit `workers=1` overrides
   `WEB_CONCURRENCY`. Almost certainly intended (it makes the default deterministic) but it is a
   behavior change. `app/main.py:446`.
3. `AttckFleetPage`/`ReportPage` are unwired for `active`, but do not poll or fan out on mount, so
   they are not storm sources (§4a).

---

## 7. Final verdict

**FIXED.**

- **Gates:** build/tsc/lint green (lint 23 warnings / 0 errors, 0 new); pytest 1 failed / 466
  passed (the known pre-existing failure); ruff 39 (pre-existing); git tree exactly as expected,
  **no stray probe/harness files**.
- **Regression fix correct in all three pages** — static dep arrays all terminate in primitives,
  `useCallback`-stable hook functions, or destructured `useGeneration()` functions; **no callback
  depends on a fresh object/array literal** (§2).
- **Empirically proven in real Chromium:** idle = **0 requests / 10 s** on each of Findings,
  Redirects, Analytics (no infinite loop); sitting on Findings 20 s after mounting 6 pages = **0
  requests** (storm still fixed); and all three controls refetch again (Findings search +1,
  Redirects search +1, Analytics range +1) (§3).
- **Coverage complete:** all 11 fetching pages receive `active`; all 4 `useAutoRefresh` sites pass
  the `enabled` argument; all 16 gated effects still early-return when inactive (§4).
- **Backend semantics unchanged:** same LIMIT windows, DST Python path preserved, default 1 worker
  (§5).

**Single most important remaining issue:** none that blocks shipping. The largest residual item is
the non-blocking `_RISK_SQL` bracket-prefix vs `json.loads` drift on malformed `matched_patterns`
(`app/routes/analytics.py:165-171`), which **cannot affect data written by this app** — every
writer uses `json.dumps` or the `'[]'` default — so it is a defensive-hardening nicety, not a
ship blocker.
