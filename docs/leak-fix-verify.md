# CPU / Memory Leak Fix — Independent Verification

**Date:** 2026-10-02
**Verifier:** independent, read-only pass (nothing in the repo was changed; all servers/worktrees/probes started were torn down)
**Scope:** verify the fixes described in `docs/leak-audit-cpu-memory.md` and `docs/leak-audit-backend.md`
**Method:** ran the gates; static dep-array audit with `git diff`; a **live Chromium measurement** (playwright-core + system Chrome, devtools `onCommitFiberRoot` commit counter, validated by a positive control) against both the fixed tree and a **pre-fix `git worktree` of HEAD**; and an in-process bound test against the real backend helpers.

---

## 0. Verdict

**FIXED** (with one non-blocking wiring gap that does not reintroduce the loop).

The CPU-loop root cause is genuinely gone — measured, not inferred. The backend unbounded-growth stores are genuinely bounded — measured. One finding: the `active` gate that the brief says was added to `AttckFleetPage` and `ReportPage` is **inert at the `App.tsx` call sites**, because those two are the only pages still rendered **without** an `active` prop. This is a *pre-existing* state (the pre-fix HEAD is identical there) and, since the render loop no longer exists, its only effect is that those two pages still do mount work while hidden — an efficiency loss, not a leak. Details in §5.

---

## 1. Gates

| Gate | Result | Expected | Match |
|------|--------|----------|-------|
| `npm run build` | exit **0** (`✓ built in 3.00s`) | 0 | ✅ |
| `npm run lint` | exit **0** — `23 diagnostics in 11 files` (all `react(only-export-components)`) | 23 / 0 new | ✅ |
| `npx tsc -b --noEmit` | exit **0** (no output) | 0 | ✅ |
| `pytest -q` | **`1 failed, 466 passed, 3 warnings in 53.12s`** | 1 failed / 466 passed | ✅ |
| `ruff check app/` | **`Found 38 errors`**, only `app/services/upstream_jaillist.py:14:1: I001` shown at tail | 38–39 | ✅ |
| `git status --short` | see below | no stray probe/harness files | ⚠️ see note |

pytest failure is the known pre-existing one:
```
FAILED tests/test_hosts.py::test_persisted_fallback_reports_same_domain_shape - assert 0 == 2
```

`git status --short`:
```
 M admin-ui/src/components/{AttckFleetPage,DashboardPage,HostInspectorPage,LogsPage,
                             NetworkGraphDiagram,PatternTable,ReportPage,UrlInvestigationPage}.tsx
 M admin-ui/src/components/loading/useElapsed.ts
 M app/{auth_store,database}.py
 M app/services/monitor.py
?? brag-output/
?? docs/leak-audit-{backend,cpu-memory}.md
?? unetwatch.db.instance-lock
```

**Deviation to report (adversarial):** the brief claimed *"no stray probe/harness files anywhere (a prior pass left none — confirm)"*. Confirmation is **partial**:
- No probe/harness files from **this** pass exist (all `/tmp/probe_*.mjs`, `/tmp/probe_*.py`, the log files, and the `/tmp/unetwatch_prefix` worktree were deleted; `git worktree list` shows only the main tree).
- But two untracked entries predate this pass and are **not** harness files: `brag-output/` (dated **Oct 1 13:29**, contains `brag-plan.md`, `brag.jpg`, `brag.mp4`, `composition/`) and `unetwatch.db.instance-lock` (0 bytes, dated **Oct 2 13:21** — a runtime lock written by a backend launch *before* this verification, not by the verifier, whose backend started at 13:44). Neither is gitignored. I left both in place: deleting a live instance-lock can break a running server, and `brag-output/` is not a leak-fix artifact.

---

## 2. `useGeneration()` dep-array audit

`grep -rn 'useGeneration()' admin-ui/src` → **11 call sites in 10 components + the definition. Every one is destructured. Zero bare assignments.** `grep -rn 'gen.next()|gen.isCurrent()|Gen.next()|Gen.isCurrent()' admin-ui/src` → **no matches.**

| Component | Assignment (line) | Callback holding the fns | Callback dep array | Effect dep array | Verdict |
|-----------|-------------------|--------------------------|--------------------|------------------|---------|
| `AttckFleetPage.tsx` | `const { next: fleetNext, isCurrent: fleetCurrent } = useGeneration()` :242 | `fetchFleet` :243 | `[runFleet, fleetNext, fleetCurrent, timeRange]` :261 — all stable | `[active, fetchFleet]` :268 | ✅ |
| `ReportPage.tsx` | `const { next: sectionNext, isCurrent: sectionCurrent } = useGeneration()` :326 | — (fns used **directly** in effect) | n/a | `[active, kind, value, runProfile, runReport, runHostEnrich, runBreakdown, runUrlEnrich, sectionCurrent, sectionNext]` :433 | ✅ |
| `HostInspectorPage.tsx` | `const { next: genNext, isCurrent: genCurrent } = useGeneration()` :395 | `fetchRaw` :597, `fetchSections` :536 | `[runRaw, genNext, genCurrent, report, rawSearch, rawPage, toast]` :630; `[run, genCurrent, timeRange, hSource]` :547 | `[fetchRaw]` :632 (input-driven; `fetchRaw` stable) | ✅ |
| `LogsPage.tsx` | `… genNext, genCurrent` :588 | `load` :589 | `[run, genNext, genCurrent, kind, page, pageSize, sortBy, sortDir, debouncedSearch]` :626 | `[active, load]` :637 | ✅ |
| `PatternTable.tsx` | `… genNext, genCurrent` :173 | `fetchPatterns` :206 | `[run, genNext, genCurrent, debouncedSearch, filterType, page, pageSize, sortBy, sortDir]` :253 | `[active, fetchPatterns]` :265 | ✅ |
| `DashboardPage.tsx` | `… recentNext, recentCurrent` :157 | `fetchRecent` :162 → `refreshAll` :200 | `[runRecent, recentNext, recentCurrent, toast]` :186 | `[active, fetchRecent]` :195; `useAutoRefresh(refreshAll,…)` :204 | ✅ |
| `UrlInvestigationPage.tsx` | `… genNext, genCurrent` :121 | `investigate` :122 | `[runBreakdown, genNext, genCurrent, toast, uSource]` :171 | effect is `[globalFilter]` :183 (`investigate` not a dep) | ✅ |
| `AnalyticsPage.tsx` | `allNext/allCurrent` :180, `rawNext/rawCurrent` :182 | refetch callbacks | destructured (unchanged, already correct) | — | ✅ |
| `FindingsPage.tsx` | `genNext/genCurrent` :333 | — | destructured (unchanged) | — | ✅ |
| `RedirectsPage.tsx` | `tableNext/…` :348, `graphNext/…` :390 | — | destructured (unchanged) | — | ✅ |

**No new loop introduced (§2.3 of the brief).** Every dep array now terminates in primitives (`active`, `kind`, `value`, `timeRange`, `page`, …), `useAbortable()`-returned functions, or the **destructured `useGeneration()` callbacks** — all `useCallback(…, [])`:
- `useAbortable()` — verified `admin-ui/src/lib/utils.ts:56-64`: the returned runner is `useCallback(<T,>(fn) => {…}, [])`, so `run`/`runFleet`/`runRaw`/`runRecent`/`runProfile`/`runReport`/`runHostEnrich`/`runBreakdown`/`runUrlEnrich`/`runBreakdown` are **stable** deps.
- `useGeneration()` — verified `utils.ts:81-82`: `next` and `isCurrent` are each `useCallback(…, [])`.

**`active` gates kept the fetch callback in deps (no refetch regression):**
- `AttckFleetPage.tsx:268` → `}, [active, fetchFleet])` ✅ (callback present)
- `ReportPage.tsx:433` → `[active, kind, value, …]` ✅ (value/kind present)
- `LogsPage.tsx:637` → `[active, load]` ✅; `PatternTable.tsx:265` → `[active, fetchPatterns]` ✅; `DashboardPage.tsx:195` → `[active, fetchRecent]` ✅.

None is `[active]`-only. A `timeRange`/`value` change still refetches.

---

## 3. Live measurement (real, not fabricated)

Tooling worked: `playwright-core` + `/usr/bin/google-chrome`, headless. Commit counter installed via `window.__REACT_DEVTOOLS_GLOBAL_HOOK__.onCommitFiberRoot`.

**The first attempt returned `0 commits` for every page — that measurement was INVALID** (`window.__REACT_DEVTOOLS_GLOBAL_HOOK__` was reported absent). Cause: a setter-based hook definition is clobbered before React reads it. Rewritten with a lazy getter, a **positive control** confirmed the harness (`hook works (control, commits>0 on load): true`, 2 commits on load), after which the numbers below are trustworthy.

Measured over **10 s idle**, per page, fixed tree vs a **pre-fix `git worktree` at HEAD `24254e1`** (same harness, same backend):

| Page | pre-fix commits | pre-fix API reqs | **post-fix commits** | **post-fix API reqs** |
|------|-----------------|------------------|----------------------|-----------------------|
| `attck-fleet` | **490** | **328** (`GET /api/attck/fleet?timeRange=24h`) | **10** | **0** |
| `report-host` | **1531** | 0 | **10** | **0** |
| `report-url` | **1773** | 0 | **10** | **0** |
| `logs` | 148 | 147 (`GET /api/logs/?limit=25…`) | **10** | **0** |
| `patterns` | 229 | 229 (`GET /api/patterns/?limit=50…`) | **10** | **0** |
| `dashboard` / `host` / `url` / `analytics` / `redirects` | 10 | 0 | **10** | **0** |

Pre-fix console also emitted **`Maximum update depth exceeded`** (React's own infinite-loop guard) on the report views — the loop was real and reproducible. Post-fix: no such error.

The residual **10 commits/10 s** is not a page leak: it is the shared **1 Hz countdown ticker in `App.tsx:151` (`setRemaining`)** — identical on *every* page including the never-broken ones, and it issues **no API request**. Well within the brief's "~10 (one per page, plus noise)". Idle API requests: **0**, as expected.

(The brief's "~201 commits in 5s for one page" understates it: the real pre-fix range was **148–1773 / 10 s**, with the report views worst because their effect called `setGeneratedAt` unconditionally.)

---

## 4. Backend bound test (real output)

Run in-process against the actual helpers (throwaway script, deleted):

```
=== _query_cache ===
MAX_ENTRIES = 256  TTL = 2.0
inserted 50000 distinct keys -> len(_query_cache) = 256  (<=256: True)
expired entry: present_before=True get=None present_after=False (removed on lookup: True)
fresh entry get: {'v': 42} (works: True )
after 300 inserts len = 256 oldest k0 evicted: True newest k299 present: True

=== auth_store ===
after 500 logins with TTL=0 -> len(_session_tokens) = 1 (bounded: True )
after 500 valid logins -> len = 500 (all valid retained: True )
```

- `_query_cache`: 50 000 distinct keys → capped at **256**; an expired entry is **deleted on lookup**; a fresh entry is still served; oldest-eviction drops `k0` while keeping the newest. ✅ (real helper `_cache_set`/`_cache_get`, `app/services/monitor.py:131-168`.)
- `auth_store`: with an everything-expired TTL, 500 logins leave **1** entry (the sweep runs inside `add_token`); with valid TTL all 500 valid sessions are correctly retained. ✅ (`app/auth_store.py:8-24`.)

**`app/routes/auth.py` NOT modified:** `git diff --stat -- app/routes/auth.py` → **empty**. Its callers still bind: `app/routes/auth.py:7` imports `TOKEN_TTL, add_token`; `:36` calls `add_token(token)` — both still exist with compatible signatures.

---

## 5. Adversarial sweep

**5.1 ⚠️ THE ONE REAL FINDING — `active` gate is inert for `AttckFleetPage` / `ReportPage`.**
The brief states these two "gained an optional `active` prop + a gated mount fetch." The prop and the internal `if (!active) return` do exist (`AttckFleetPage.tsx:201,266`; `ReportPage.tsx:41,306,345`), **but the call sites never pass it**:

```
admin-ui/src/App.tsx:331              <AttckFleetPage onNavigate={handleNavigate} />        ← no active
admin-ui/src/App.tsx:336              <ReportPage kind="host" value={globalFilter} … />     ← no active
admin-ui/src/App.tsx:341              <ReportPage kind="url"  value={globalFilter} … />     ← no active
```

Every *other* page in `App.tsx` passes `active={view === "..."}` (:268, 281, 286, 291, 296, 301, 306, 311, 316, 321, 326). These three are the sole exceptions — and they are exactly the two pages the frontend audit (§2.1, §2.3) flagged as looping *even while hidden*. With the prop absent, the defaults are `active = true` (`AttckFleetPage.tsx:204`, `ReportPage.tsx:306`), so the gate never closes.

**Severity: minor, not a leak.** Before the fix this mattered because the loop ran unconditionally; now that the dep arrays are stable there is no loop, so the only consequence is that a visited-but-hidden ATT&CK/report page still performs its **mount fetch once** on first visit (and holds its state) rather than deferring until shown. It does **not** consume CPU at idle (measured: 10 commits/10 s, 0 idle API — the mount fetch fires once, then quiesces). This is pre-existing wiring, unchanged from HEAD `24254e1`, not a regression introduced by the fix. **Fix:** add `active={view === "attck-fleet"}` / `active={view === "report-host"|"report-url"}` at `App.tsx:331,336,341`.

**5.2 Other `useGeneration()` consumers outside `components/*.tsx`** — none. `grep` over `src/lib`, `src/contexts`, and the (nonexistent) `src/hooks` finds only the definition in `lib/utils.ts`. No context holds the bare object.

**5.3 Timers without cleanup** — every `setTimeout`/`setInterval` in `src` was inspected:
- `App.tsx:151` `setInterval` → `clearInterval` at :162 ✅
- `lib/utils.ts:24` debounce → cleared by its effect cleanup ✅; `utils.ts:139` interval → `clearInterval` at :150 ✅
- `NetworkGraphDiagram.tsx:303` (effect-scoped timer) and **:371** — `:371` is the previously-uncleared fit-view timeout; the fix now stores it in `fitTimerRef` and clears it on unmount + before re-arming ✅
- `RedirectsPage.tsx:501`, `useDelayedVisible.ts:63,81`, `DataTable.tsx:638`, `ColumnChooser.tsx:43`, `ui.tsx:893`, `FilterContext.tsx:110`, `api.ts:2196`, `exportCsv.ts:107` — each held in a ref/effect and cleared, or a fire-and-forget one-shot `revokeObjectURL` (no leak). ✅

**5.4 `useElapsed` signature change** — new 3rd param is **optional** (`useElapsed(active, startedAt?, enabled = true)`, `useElapsed.ts:74`). All callers bind:
- 2-arg legacy callers unchanged: `AnalyticsPage:170`, `FindingsPage:341`, `QueryPage:611`, `RedirectsPage:337`, `LoadingIndicator:80`.
- 3-arg adopters: `HostInspectorPage:380,381`, `LogsPage:577`, `PatternTable:174` (all pass `active`).
- `DataTable.tsx:978` passes `(loading, loadingStartedAt)` — fine.
No caller broken (tsc exit 0).

**5.5 Previously-verified CLEAN items still clean**
- ECharts `dispose()` still present in all 4 chart components: `NetworkGraphDiagram.tsx:268`, `SankeyDiagram.tsx:459`, `TrafficTimeline.tsx:58`, `TrendCharts.tsx:274`. ✅
- `_RUNS` still bounded: `app/routes/redirects.py:50` "keep the latest 20". ✅
- Request-path DB connections still closed in `finally`: DI path `database.py:503-506` (`get_db_conn`); startup `init_db` now `try/finally` at `:483-484`. ✅

**5.6 Behaviour regressions** — none observed live: all 10 pages loaded on first visit; superseded reads are still aborted (`AbortError` swallowed in `useAbortable`, `utils.ts:60-63`); failed refetch still keeps content (`rawLoadedRef`, `HostInspectorPage.tsx:401`; LogsPage `:613` comment). No console errors beyond benign 404s for optional endpoints.

**5.7 `app/database.py` diff surprise (not a defect).** `git diff --stat -- app/database.py` reports **869 changed lines**, which looks alarming for a "try/finally" fix. Under `git diff -w` it collapses to **7 insertions / 2 deletions** — the rest is **pure whitespace/indentation reflow** (the whole `init_db` body was re-indented by one level to sit inside the new `try:`). The only semantic change is the `try:`/`finally: await db.close()`. Verified: `grep` shows `try:` at :20, `finally:` at :483. ✅ No hidden logic change.

---

## 6. Final answer

**FIXED.**

The primary CPU leak — the `useGeneration()` object-identity render loop — is genuinely eliminated: measured **490→10, 1531→10, 1773→10, 148→10, 229→10 commits per 10 s idle**, idle API traffic **→0**, and React's `Maximum update depth exceeded` no longer fires. All 11 `useGeneration()` call sites are destructured; no dep array references a bare object or a per-render function. Both backend unbounded stores are bounded (50 000 keys → 256; 500 abandoned logins → 1). `auth.py` is untouched and its callers bind.

**Single most important remaining issue:** the `active` gate is dead for `AttckFleetPage` and `ReportPage` because `App.tsx:331/336/341` never pass the prop, so those two (previously hidden-page-looping) pages still fetch on mount while hidden. It is **not** a CPU/memory leak any more — the loop is gone — but it means the fix's stated invariant ("every visited page is gated") is not actually satisfied at those three call sites. One-line-per-site wiring change to close it.
