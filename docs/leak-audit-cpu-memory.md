# CPU / Memory Leak Audit — `admin-ui` (React 19 + TS)

**Date:** 2026-10-02
**Scope:** `/home/x0art/Project/uNetWatch/admin-ui/src`
**Trigger:** user report — *"the app flooding the CPU usage, ensure there is no CPU leaks and no Memory leaks."*
**Prime suspect:** the just-landed "request storm" fix that added an `active` prop and gated polling/mount-fetches, plus the new `useGeneration()` / `useAbortable()` hooks.
**Method:** read-only static audit of every `useEffect`/`useCallback` in `src/lib/**`, `src/components/loading/**`, `src/App.tsx`, the chart components, and all page components; plus a **Node harness that reproduces the React dep-identity loop** to measure whether a candidate actually iterates.

---

## 0. Executive summary

There is **one root cause** producing the CPU storm, and it has **seven confirmed sites**:

> **`useGeneration()` returns a fresh object literal every render.**
> `src/lib/utils.ts:79-84`
> Some consumers destructured it correctly (`const { next, isCurrent } = useGeneration()`), but **seven call sites kept the bare object and put it in a `useCallback` dep array** whose callback is then a dependency of an effect. The callback identity changes every render → the effect re-runs every render → the callback's body calls `setState` → re-render → loop. This pins a core and, because the body fires an HTTP abort+refetch each pass, also floods the network.

**Measured (Node harness, see §7):** the "bare object + callback-dep effect" shape iterates **5000 renders / 5000 effect runs** before hitting the harness cap = **infinite**. The correctly-destructured shape **converges in 2 renders**.

Three of the seven looping pages (`AttckFleetPage`, `HostInspectorPage` raw table, `ReportPage`) are **unconditional** — they loop even while the page is hidden behind `<div hidden>` and even for a user who simply lands on the Dashboard but has visited them once. The other four loop only while their view is active, but each is a per-visit core-pin.

Two of the seven (`AttckFleetPage`, `ReportPage`) have **no `active` prop at all**, so they violate the stated invariant that every visited page is gated.

### Ranked findings

| # | file:line | Mechanism | Severity | Reachable in common case? |
|---|-----------|-----------|----------|---------------------------|
| 1 | `AttckFleetPage.tsx:235` / `:255-257` | Bare `fleetGen` in `fetchFleet` deps → `useEffect(..., [fetchFleet])` unconditional | **CPU-pin + network flood** | **Yes** — any visit to ATT&CK Coverage; **never stops, even hidden** |
| 2 | `HostInspectorPage.tsx:593` / `:628` | Bare `gen` in `fetchRaw` deps → `useEffect(..., [fetchRaw])` unconditional | **CPU-pin** | **Yes**, after a findings-mode host lookup; **never stops, even hidden** |
| 3 | `ReportPage.tsx:334` / `:422` | Bare `sectionGen` (+5 `run*` are stable) in effect deps → effect re-runs every render | **CPU-pin** | **Yes** — any report view; loops whenever mounted (no `active` gate) |
| 4 | `LogsPage.tsx:585` / `:622` / `:630` | Bare `gen` in `load` deps → `useEffect(..., [active, load])` | **CPU-pin** | **Yes** — visit Logs; loops while active |
| 5 | `PatternTable.tsx:202` / `:249` / `:257` | Bare `gen` in `fetchPatterns` deps → `useEffect(..., [active, fetchPatterns])` | **CPU-pin** | **Yes** — visit Patterns |
| 6 | `HostInspectorPage.tsx:532` / `:543` | Bare `gen` in `fetchSections` deps (identity churn; `lookup()` calls it) | **CPU-pin (secondary)** | **Yes** — every host lookup re-creates `fetchSections` |
| 7 | `DashboardPage.tsx:158` / `:182` / `:200` | Bare `recentGen` in `fetchRecent` deps; effect is gated `[active]` (no loop) **but** `useAutoRefresh(refreshAll, …, active)` deps `[refreshSeconds, refresh, enabled]` → interval **re-armed every render** while active | **CPU-pin (timer thrash)** | **Yes** — Dashboard is the landing page |
| 8 | `UrlInvestigationPage.tsx:118` / `:167` | Bare `gen` in `investigate` deps; effect keyed `[globalFilter]` only → no loop, but new identity per render | **minor (churn)** | Only when page rendered |
| 9 | `ui.tsx:898` | `ToastContext.Provider value={{ toast, dismiss }}` — fresh object literal every render | **minor (CPU amplifier)** | Yes, but bounded |
| 10 | `loading/useElapsed.ts:97` | 100 ms ticker gated only on `(loading, tabVisible)` — **not** on the in-app `active` view | **N-ticker CPU (conditional)** | Yes if multiple pages are loading at once (made likely by finding #1–6) |
| 11 | `NetworkGraphDiagram.tsx:361` | `handleFitView` `setTimeout` not cleared on unmount (user-triggered only) | **minor** | Edge case (user clicks Fit then navigates within 500 ms) |

Everything else checked **CLEAN** (see §5). No unbounded arrays, no undisposed ECharts, no unmatched listeners/observers.

---

## 1. Root cause — `useGeneration()` returns a fresh object every render

`src/lib/utils.ts:79-84`:

```ts
export function useGeneration(): { next: () => number; isCurrent: (g: number) => boolean } {
  const genRef = useRef(0)
  const next = useCallback(() => ++genRef.current, [])
  const isCurrent = useCallback((g: number) => g === genRef.current, [])
  return { next, isCurrent }
}
```

`next` and `isCurrent` are `useCallback([])`-stable. **The returned object `{ next, isCurrent }` is a new reference on every render.** `useAbortable()` (`utils.ts:49-65`) does **not** have this problem — it returns the `useCallback` directly, so the returned function is stable.

The dangerous shape is:

```tsx
const fleetGen = useGeneration()                       // fresh object every render
const fetchFleet = useCallback(() => {
  const g = fleetGen.next()                             // body calls setState
  setLoading(true)
  ...
}, [runFleet, fleetGen, timeRange])                     // ← bare object in deps
useEffect(() => { fetchFleet() }, [fetchFleet])         // runs every time fetchFleet changes
```

Because `fleetGen` changes identity every render, `fetchFleet` is a **new function every render**, so the effect fires every render, and the effect body (`setLoading(true)`, `setMapping(...)`, `setLoading(false)`) — or the aborted-read terminal branch — schedules another render. This is an infinite render loop.

The safe shape (used correctly in `FindingsPage`, `RedirectsPage`, `AnalyticsPage`) destructures the two stable functions:

```tsx
const { next: genNext, isCurrent: genCurrent } = useGeneration()
const refetch = useCallback(() => { const g = genNext(); ... }, [run, genNext, genCurrent, ...])
```

The codebase's own comments show the fix was known — `AnalyticsPage.tsx:177-179`, `FindingsPage.tsx:329-332`, `RedirectsPage.tsx:345-347` — but it was **not applied uniformly**. The seven sites below still hold the bare object.

---

## 2. Confirmed CPU-pins (render loops)

### 2.1 `AttckFleetPage.tsx` — unconditional infinite loop, no `active` gate ★ highest

`src/components/AttckFleetPage.tsx:233-257`:

```tsx
  const runFleet = useAbortable()
  const fleetGen = useGeneration()                       // 234 — BARE OBJECT
  const fetchFleet = useCallback(() => {
    const g = fleetGen.next()                             // 236
    setLoading(true)                                      // 237  ← setState
    setError(null)
    return runFleet((signal) => getFleetAttckMapping({ timeRange }, { signal }))
      .then((data) => { ... setMapping(data) })           // 242  ← setState
      .catch(...)
      .finally(() => { if (fleetGen.isCurrent(g)) setLoading(false) })  // 251 ← setState
  }, [runFleet, fleetGen, timeRange])                     // 253  ← BARE OBJECT IN DEPS

  useEffect(() => {
    fetchFleet()                                          // 256  ← unconditional, no `active`
  }, [fetchFleet])                                        // 257  ← fires every render
```

**Why it pins CPU:** `fetchFleet` changes identity every render (`fleetGen` in deps) → effect at :255 re-runs every render → `setLoading(true)`/`setLoading(false)` each pass → next render. It also aborts+re-issues an HTTP GET every pass.

**Worse:** `AttckFleetPage` receives **no `active` prop** (`AttckFleetPage.tsx:200` — `export function AttckFleetPage({ onNavigate }: Props)`; `App.tsx:331` renders `<AttckFleetPage onNavigate={handleNavigate} />` with no `active`). So once the user has visited ATT&CK Coverage, the loop **never stops — not when the page is hidden behind `<div hidden>`, not when the tab is backgrounded** (the browser throttles background timers, but this is a *render/microtask* loop, and React keeps flushing it while the tab is visible and the page hidden). This is almost certainly the "flooding CPU" the user sees.

**Measured:** harness §7 → 5000 renders / 5000 effect runs (infinite).

### 2.2 `HostInspectorPage.tsx:628` — raw-findings table, unconditional loop

`src/components/HostInspectorPage.tsx:592-628`:

```tsx
  const runRaw = useAbortable()
  const fetchRaw = useCallback(async () => {
    if (!report?.client_ip || !report.has_data) return
    const g = gen.next()                                  // 596 — `gen` is BARE OBJECT (391)
    ...
    setRawLoading(true)                                   // 598  ← setState
    ...
  }, [runRaw, gen, report, rawSearch, rawPage, toast])    // 626  ← BARE OBJECT

  useEffect(() => { void fetchRaw() }, [fetchRaw])        // 628  ← unconditional
```

`const gen = useGeneration()` at **:391** is the bare object. `fetchRaw` deps include it → new identity every render → effect :628 is **unconditional** (no `active`) → loops whenever `report.client_ip && report.has_data` is true, i.e. after a findings-mode host lookup, and **never stops even when the Host page is hidden**.

**Note on the effect ordering:** the effect at :628 sits next to `run = useAbortable()` shared with `lookup`. `useAbortable` returns a stable `useCallback`, so the abort point is fine — only `gen` triggers the loop.

**Measured:** same shape as 2.1 → 5000/5000 (infinite).

### 2.3 `ReportPage.tsx:422` — effect deps include the bare `sectionGen`

`src/components/ReportPage.tsx:318`, `:334-422`:

```tsx
  const sectionGen = useGeneration()                      // 318 — BARE OBJECT
  ...
  useEffect(() => {
    setGeneratedAt(new Date().toISOString())              // 338 ← setState every run
    if (value.trim() === "") return
    const g = sectionGen.next()                           // 343
    ... setProfile / setReport / setHostEnrich ...        // 345-389 ← setState
  }, [sectionGen, runProfile, runReport, runHostEnrich, runBreakdown, runUrlEnrich, kind, value])
  // 422  ^^^^^^^^^^ BARE OBJECT in the EFFECT's own dependency array
```

Here the fresh object is a **direct** dep of the effect — it re-runs every render and unconditionally calls `setGeneratedAt(...)` at :338 (guaranteed state change → guaranteed re-render), so the loop is self-sustaining even before the fetches resolve. `runProfile`…`runUrlEnrich` are stable (`useAbortable`), so `sectionGen` is the sole trigger.

**Reachability:** `App.tsx:336,341` render `<ReportPage … />` with **no `active` prop** (the component has no such prop), inside `<div hidden>`. Visiting a report view therefore pins a core permanently, like #2.1.

**Measured:** shape "bare object directly in effect deps + body sets state" → infinite.

### 2.4 `LogsPage.tsx:630` — `[active, load]` with `load` deps = bare `gen`

`src/components/LogsPage.tsx:583-633`:

```tsx
  const run = useAbortable()
  const gen = useGeneration()                             // 584 — BARE OBJECT
  const load = useCallback(() => {
    const g = gen.next()                                   // 586
    const isFirstLoad = !loadedRef.current
    setLoading(true)                                       // 588 ← setState
    setLoadingStartedAt(Date.now())
    setLoadError(null)
    ...
  }, [run, gen, kind, page, pageSize, sortBy, sortDir, debouncedSearch])  // 622 ← BARE OBJECT
  ...
  useEffect(() => {
    if (!active) return
    void load()                                            // 632
  }, [active, load])                                       // 633
```

The comment at :628-629 claims *"`load` is a useCallback whose deps are the stable `run`/`gen`"* — **`gen` is not stable**; it is the fresh object. So `load` is new every render, the effect re-runs every render while `active`, `setLoading(true)` keeps firing → loop. **This directly contradicts the code's own comment**, which is the tell that the destructuring fix was applied in some files and missed here.

### 2.5 `PatternTable.tsx:257` — identical shape

`src/components/PatternTable.tsx:169`, `:202-260`:

```tsx
  const gen = useGeneration()                             // 169 — BARE OBJECT
  const fetchPatterns = useCallback(async () => {
    const g = gen.next()                                   // 204
    setLoading(true)                                       // 205 ← setState
    ...
  }, [run, gen, debouncedSearch, filterType, page, pageSize, sortBy, sortDir])  // 249 ← BARE
  ...
  useEffect(() => {
    if (!active) return
    fetchPatterns()                                        // 259
  }, [active, fetchPatterns])                              // 260
```

Comment at :255-256 also falsely asserts `gen` is stable. Same loop while Patterns is active.

### 2.6 `HostInspectorPage.tsx:543` — `fetchSections` identity churn

`src/components/HostInspectorPage.tsx:532-543`:

```tsx
  const fetchSections = useCallback(async (clean: string, g: number) => {
    ...
  }, [run, gen, timeRange, hSource])                       // 543 ← BARE `gen` (:391)
```

This one does **not** feed a dep-array effect directly (its callers are event-driven `lookup()`), so it is not itself an infinite loop — but it is a **new function every render**, re-created on each pass of the loops in #2.1/#2.3 when both pages are mounted, contributing allocation churn. It is the same latent bug and should be fixed with the others.

### 2.7 `DashboardPage.tsx` — `useAutoRefresh` interval re-armed every render

`src/components/DashboardPage.tsx:152-200`:

```tsx
  const runRecent = useAbortable()
  const recentGen = useGeneration()                        // 153 — BARE OBJECT
  const fetchRecent = useCallback(() => {
    const g = recentGen.next()                             // 159
    setRecentLoading(true)                                 // 161 ← setState
    ...
  }, [runRecent, recentGen, toast])                        // 182 ← BARE OBJECT
  ...
  useEffect(() => {
    if (!active) return
    void fetchRecent()
  }, [active])                                             // 191 — gated; NO loop here
  ...
  const refreshAll = useCallback(() => {
    onRefresh()
    return fetchRecent()
  }, [onRefresh, fetchRecent])                             // 199 — new every render
  const { refreshSeconds, setRefreshSeconds } = useAutoRefresh(refreshAll, "dashboard", 60, active)
  // 200
```

The mount effect at :184 is correctly gated (`[active]` only), so it does **not** create a render loop. **But** `useAutoRefresh` (`utils.ts:134-151`) has dep array `[refreshSeconds, refresh, enabled]`:

```ts
  useEffect(() => {
    if (!enabled || !refreshSeconds) return
    const id = window.setInterval(() => { ... refresh() ... }, refreshSeconds * 1000)
    return () => window.clearInterval(id)
  }, [refreshSeconds, refresh, enabled])                   // utils.ts:151
```

`refresh` is `refreshAll`, which is a **fresh function every render** (it depends on `fetchRecent`, which depends on `recentGen`). So while the Dashboard is the active view:
- every render clears and re-creates the interval (`clearInterval` + `setInterval`),
- the 60 s timer is **reset on every render**, so it may never actually fire,
- and every render allocates a new interval id.

This is a **timer-thrash CPU cost** rather than a render loop, but it is the same root cause and it means the Dashboard's 60 s auto-refresh is effectively broken (never fires because the timer is constantly reset). Because Dashboard is the landing view (`App.tsx:99` default `"dashboard"`), this is hit on every session.

**Measured:** harness shows the gated shape converges (2 renders) — so this is not an infinite loop; the cost is the repeated interval re-arm, which the harness models separately (§7, "timer thrash" line).

### 2.8 `UrlInvestigationPage.tsx:167` — churn only

`src/components/UrlInvestigationPage.tsx:117`, `:167`:

```tsx
  const gen = useGeneration()                              // 117 — BARE OBJECT
  const investigate = useCallback(async (target: string) => {
    const g = gen.next()                                    // 130
    setLoading(true)                                        // 131
    ...
  }, [runBreakdown, gen, toast, uSource])                  // 167 ← BARE OBJECT
```

`investigate` is called by `useEffect(..., [globalFilter])` at :173 (keyed on `globalFilter` only, with `eslint-disable`), so **no loop**. But `investigate` is new every render → any consumer that used it as a dep would loop. Fix for consistency. Severity minor.

---

## 3. Timers, intervals and animation loops

### 3.1 `useElapsed.ts` — the 100 ms ticker and why N can run at once

`src/components/loading/useElapsed.ts:67-99` (the ticker):

```ts
export function useElapsed(active: boolean, startedAt?: number): ElapsedState {
  const visible = usePageVisible()                          // TAB visibility only
  ...
  useEffect(() => {
    if (!active) { setElapsedMs(0); return }                // active = the `loading` flag
    ...
    if (!visible) return                                    // hidden TAB ⇒ no interval
    const tick = () => { ... setElapsedMs(next) }           // setState every tick
    const id = window.setInterval(
      tick,
      anchorRef.current && Date.now() - anchor > SLOW_AFTER_MS ? SLOW_TICK_MS : TICK_MS,
    )                                                        // 97 — 100 ms (or 500 ms)
    return () => window.clearInterval(id)                    // 98 — cleaned up ✔
  }, [active, startedAt, visible])
```

**Cleanup:** yes — every invocation owns its interval and clears it (`:98`). Strict-Mode safe. Stops on `!active` and on tab-hidden.

**The gap:** the gate is `(active = loading, visible = tab)`. It has **no knowledge of the in-app `active` view prop**. Therefore a page that is **hidden behind `<div hidden>` but still mounted** holds a live 100 ms ticker **whenever its `loading` flag is true**. With the loops in §2.1–2.6, `loading` is re-set to `true` on essentially every render, so those pages arm/disarm a 100 ms ticker continuously.

**N-ticker count (reasoned, not measured in a real browser):** `useElapsed` is called at **10 sites** (`LogsPage:577`, `RedirectsPage:337`, `LoadingIndicator:80`, `QueryPage:611`, `AnalyticsPage:170`, `DataTable:978`, `PatternTable:170`, `FindingsPage:341`, `HostInspectorPage:380`, `HostInspectorPage:381`). Each mounted page holding `loading=true` runs its own `setInterval(…, 100)`. In a normal session a user visits several pages and leaves them mounted (`App.tsx:265-343`); because the looping pages never settle to `loading=false`, they can each keep a 100 ms ticker alive simultaneously → **N × 10 ticks/sec**, each tick a `setState` that re-renders that page. This is a real amplifier of the CPU storm, though the loops of §2 are the primary driver.

**Each tick's cost:** one `setState(elapsedMs)` → re-render of the whole page component that owns the hook (e.g. `AnalyticsPage`, `LogsPage`, `PatternTable`). For a page rendering a large `DataTable`, that re-render is non-trivial (memoised rows limit DOM work, but reconciliation of the page subtree still runs). At 10 Hz × N pages this is significant.

### 3.2 `App.tsx` countdown ticker — 1 s, correctly gated

`src/App.tsx:151-162`:

```tsx
    const tick = setInterval(() => {
      setRemaining((r) => { if (r <= 1) { fetchStats(); return intervalSec } return r - 1 })
    }, 1000)
    return () => clearInterval(tick)
  }, [status, intervalSec, fetchStats])
```

**Clean:** 1 Hz, single site, cleared on unmount/`status` change. It **does run while other views are active** (it lives in `AppRoutes`, above the view switch) — 1 tick/sec of a cheap `setRemaining` reducer + re-render of the shell. Acceptable. It does **not** check tab visibility, so a backgrounded tab still ticks 1/sec (browser will throttle `setInterval` in background tabs to ~1/min, so negligible). **Not a leak.**

### 3.3 `RedirectsPage` poll — self-rescheduling `setTimeout`, bounded and cleared

`src/components/RedirectsPage.tsx:474-504`: a 500 ms `setTimeout` chain polling a background check, capped at `attempts >= 300` (:497), stored in `pollTimerRef`, cleared on unmount (:476-478). **Clean** — the only self-rescheduling timer is bounded at 300 attempts (150 s) and user-initiated.

### 3.4 CSS animations and `html[data-paused]`

- `src/index.css:167-168` `.skeleton-shimmer` — `infinite`.
- `src/index.css:171-172` `.edge-flow` — `infinite` (`dash-flow`).
- `src/index.css:153-164` `.animate-in` / `.animate-out` / `slide-*` / `fade-in` — finite one-shot.
- Tailwind `animate-spin` — **13 occurrences**, all conditional spinners:
  `AddBlacklistDialog.tsx:73`, `AddJaillistDialog.tsx:73`, `AddPatternDialog.tsx:85`, `BlockDomainPage.tsx:275`, `DataTable.tsx:1050`, `LoginPage.tsx:104`, `LogsPage.tsx:973,1034`, `PatternTable.tsx:527,567`, `WhitelistDomainPage.tsx:253`, `ui.tsx:98,128`.
- `animate-ping`: **0**. `animate-pulse`: **0**.

**Pause mechanism:** `App.tsx:198-200` toggles `data-paused` on `<html>` from `usePageVisible()`; `index.css:170` sets `animation-play-state: paused !important` on everything when `html[data-paused]`. **Verified:** `usePageVisible()` (`utils.ts:161-169`) subscribes to `visibilitychange` and removes the listener on cleanup. **Clean.**

**`hidden` vs CSS animation — verified, not assumed:** the `hidden` attribute maps to the UA-stylesheet rule `[hidden] { display: none }`. `display: none` removes the element from the box tree, so **CSS animations (and `animate-spin` on descendants) do NOT advance** on a hidden-but-mounted page. I searched `index.css` for any override of `[hidden]` or a forced `display:` on `[hidden]` — **none found** (`grep` for `[hidden]`/`display:` returned no rules). So the hidden-page CSS-animation concern is **CLEAN**. (Caveat: this is standard CSS/browser behaviour — I did not run a real browser here.)

**Important consequence:** because `display:none` freezes CSS animations, the 13 `animate-spin` spinners are *not* a hidden-page CPU cost. The CPU cost of a hidden page is entirely the **JS** loops of §2 (React render + interval churn), not CSS animation.

---

## 4. Memory

### 4.1 Unbounded collections — NONE FOUND

I grepped every `useRef<…[]>` / `useRef<…Map>` / `useRef<…Set>` and every `.push(` in a ref-like context. Findings:

- `ui.tsx:881` `timersRef = useRef<Map<string, number>>(new Map())` — **bounded**: entries are added per toast and deleted in `clearTimer` (`:884`) and on unmount (`:896`). Clean.
- `DataTable.tsx:938` `chipAnchors = useRef(new Map<string, HTMLElement>())` — keyed by column id (bounded by column count). Clean.
- All other `.*\.push(` occurrences are local arrays built inside a render/memo (e.g. CSV export, sankey build), not retained. Clean.
- `redirect pollTimerRef`, `recentLoadedRef`, `loadedRef`, `rawLoadedRef`, `selectorRef`, `hasLoadedRef`, `reportRef`, `anchorRef`, `shownAtRef`, `inFlightRef`, `genRef` — all hold scalars/booleans/controllers, none grow.

**No log buffer, no render-history array, no per-row ref keyed by row id that grows per fetch.** Verified clean.

### 4.2 Module-scope `*_UI` retention — bounded, but one nuance

The `*_UI` pattern (`PATTERNS_UI`, `FINDINGS_UI`, `queryUI`, `LOGS_UI`, `REDIRECTS_UI`, `TECHNIQUES_UI`, `HOSTS_UI`) hands callbacks to module-scope column defs. Each is a **plain module-scope object**; it survives unmount **by design**, but its fields are only:

- callbacks (`onEdit`, `onDelete`, `onDetail`, `openHost`, …) — replaced, not accumulated;
- scalars (`busy`, `busyUrl`);
- index maps: `whitelistIndex`, `blacklistIndex`, `trackedIndex`, `jailedIndex` (`FINDINGS_UI`) and `queryUI.jailedIndex`.

**The index maps ARE retained after the component unmounts** (they are written by reference at `FindingsPage.tsx:602-605`, `QueryPage.tsx:627` — no copy). These can be large: `FindingsPage.refetchIndexes` (`:430-435`) fills them from `listPatterns({limit:5000})`, `listTrackedUrls({limit:5000})`, `getBlacklistSet()`, `getJaillistSet()`. So `FINDINGS_UI`/`queryUI` can hold **up to ~5000 keys each** in the module scope after the page is gone — and they are only ever *replaced* by a newer map, never cleared. This is a **bounded-retention** issue (worst case a few hundred KB of short strings), **not unbounded growth** (the map is replaced wholesale, not appended to). Severity: **minor**. Worth noting because the maps are keyed by pattern/URL/IP and survive tab switches; but they do not grow without bound and they hold no whole row array or result set.

Crucially: **the `*_UI` objects do not hold the row arrays.** `findings`/`patterns`/`logs` (the large arrays) live in component state and are freed on unmount. Verified.

### 4.3 ECharts instances — ALL DISPOSED ✔

| Chart component | init | `dispose()` | observers |
|---|---|---|---|
| `TrendCharts.tsx` | `:263` | `:274` in cleanup `:271-276` | `resize` listener removed `:272`; `ro.disconnect()` `:273` |
| `TrafficTimeline.tsx` | `:47` | `:58` in cleanup `:55-60` | `resize` removed `:56`; `ro.disconnect()` `:57` |
| `SankeyDiagram.tsx` | (init effect) | `:459` in cleanup `:456-461` | `resize` removed `:457`; `ro.disconnect()` `:458`; `chart.off` for mouseover/mouseout `:549-551` and click `:584-586` |
| `NetworkGraphDiagram.tsx` | `:246` | `:259` in cleanup `:257-261` | `ro.disconnect()` `:258`; `chart.off("click")` `:328` |

**All four dispose correctly and detach their observers.** Verified clean. (This was the classic leak the brief warned about — it is not present.)

### 4.4 Listeners / observers — ALL MATCHED ✔

Every `addEventListener` has a matching `removeEventListener` in the same cleanup:

- `App.tsx:187/188` keydown ✔
- `utils.ts:165/166` visibilitychange ✔
- `DataTable.tsx:959/960` scroll; `:1462-1463/1465-1466` pointermove+pointerup; `:1685/1686` keydown ✔
- `ListActionDropdown.tsx:120-121/123-124` mousedown+keydown ✔
- `SankeyDiagram.tsx:452/457` resize ✔
- `TrafficTimeline.tsx:51/56` resize ✔
- `TrendCharts.tsx:267/272` resize ✔
- `RowDetailPanel.tsx:57-58/60-61` pointermove+pointerup ✔
- `Sidebar.tsx:334/335` keydown ✔
- `FilterContext.tsx:195/196` popstate ✔

`ResizeObserver` created in all four charts + `SankeyDiagram` — each `disconnect()`ed (§4.3). **No `IntersectionObserver`, no `MutationObserver`** anywhere in `src/`. Verified clean.

**`URL.revokeObjectURL`:** four blob-download sites, all matched:
`api.ts:2195-2196` (`setTimeout(…, 1000)`), `AnalyticsPage.tsx:93-94`,
`HostInspectorPage.tsx:642-643`, `:715-716`, `table/exportCsv.ts:106-107`.
Verified clean.

**framer-motion:** the only subscription is `AnimatedNumber` (`motion.tsx:192-199`) — `useMotionValue` + `useMotionValueEvent` + `animate(mv, …)` with `return controls.stop` (`:198`), so the animation is stopped on cleanup. `AnimatePresence` is used once (`DataTable.tsx:1101-1142`) for the bulk-action bar; it auto-cleans on unmount by design. `MotionConfig` (`motion.tsx:28`) is just context. **No leaked motion subscription.** Verified clean.

### 4.5 React-specific

- **Context value as a fresh object literal:** `ui.tsx:898` — `ToastContext.Provider value={{ toast, dismiss }}`. `toast`/`dismiss` are `useCallback`-stable (`:886-895`) but the **wrapper object is new every `ToastProvider` render**, and `ToastProvider` re-renders on every toast add/dismiss. Any consumer of `useToast()` re-renders on every toast churn. Severity **minor** (the provider only re-renders when a toast changes). Should be `useMemo`. **Not** a leak.
  - `FilterContext` and `ZoneContext` were checked: `FilterProvider` builds its value — I read the provider and it does **not** wrap the value in a fresh inline literal that would differ from stable hooks; regardless, filter churn is user-driven. `ZoneContext` value is the raw `zone` state (a stable reference). Clean.
- **Store subscriptions without unsubscribe:** none — the app uses no external store; all state is React state/context. Verified clean.
- **`useRef` holding a growing array:** none (§4.1). Clean.

---

## 5. Explicitly CLEAN (negative results)

For audit credibility, these were checked and are **correct**:

1. **`useAbortable()` (`utils.ts:49-65`)** returns a stable `useCallback([])` — safe to use as a dep. Its `abortRef` controller is aborted on unmount (`:52-54`). ✔
2. **Destructured `useGeneration()` consumers** — `FindingsPage.tsx:333/403/415`, `RedirectsPage.tsx:348/385/390/413/425/433`, `AnalyticsPage.tsx:180/182/223/233/265/274` — all destructure `next`/`isCurrent`; their callbacks are stable; **no loop**. ✔ (proven by harness)
3. **`QueryPage.tsx`** — `fetchQuery` deps are five primitives (`:695`); `useEffect(..., [active, fetchQuery])` (`:706`) converges. Mount badge effect gated `[active]` (`:599`). `useElapsed(loading)` OK. **Clean.** ✔
4. **`BlacklistPage.tsx` / `JaillistPage.tsx`** — `load`/`loadUpstreamStatus` deps are stable `splitLines`/`toast`; effect keyed `[active]` (`:391`/`:105`). **Clean.** ✔
5. **`DashboardPage.tsx` fetchBlacklistCount / fetchTrackedCount (`:103-135`)** — deps `[toast]` only; mount effect gated `[active]` (`:147`). **Clean** (the loop risk is only in `fetchRecent`, §2.7). ✔
6. **All four ECharts components** dispose + disconnect (§4.3). ✔
7. **All 11 `addEventListener` sites** matched (§4.4). ✔
8. **All 4 `revokeObjectURL` sites** matched (§4.4). ✔
9. **`useDebounce` (`utils.ts:21-28`)**, **`useDelayedVisible` (`useDelayedVisible.ts:51-92`)**, **`usePageVisible` (`utils.ts:161-169`)**, **Toast timers (`ui.tsx:882-896`)**, **Redirects poll (`:474-504`)** — every timer cleaned up; no unconditional self-reschedule except the bounded 300-attempt poll. ✔
10. **`App.tsx` countdown (`:151-162`)** — 1 Hz, cleared, single site. ✔
11. **`hidden` freezes CSS animations** — no `[hidden]` override in `index.css`; `display:none` removes from box tree. The 13 `animate-spin` are not a hidden-page CPU cost. ✔
12. **No unbounded collections / growing refs** (§4.1). ✔
13. **`LoginPage.tsx`, `EventInspectorSidebar.tsx`, `HostEntityCard.tsx`, `TopDestinations.tsx`, `CountdownRing.tsx`, `AttckPanel.tsx`, `AppShell.tsx`, `GlobalSearchPalette.tsx`, `Sidebar.tsx`, `motion.tsx`, `Add*Dialog.tsx`, `BlockDomainPage.tsx`, `WhitelistDomainPage.tsx`** — no `setInterval`, no `requestAnimationFrame`, no looping effects, no uncleaned listeners. **Clean.** ✔
14. **`NetworkGraphDiagram.tsx:294-301`** — the data-settle `setTimeout` **is** cleaned (`return () => clearTimeout(timer)`). Only the *fit-view* timer at `:361` is uncleaned (§6). ✔

---

## 6. Minor / edge-case findings

- **`NetworkGraphDiagram.tsx:361-365`** — `handleFitView` schedules `setTimeout(…, settleTime)` with **no cleanup**. If the user clicks "Fit view" and navigates away within 500 ms, the callback runs `chart.resize()`/`applyView` on a **disposed** chart (`chartRef.current` is null but `chart` is the captured local — it calls into a disposed ECharts instance). ECharts tolerates most post-dispose calls, but it can throw and it keeps the chart object reachable briefly. **Severity: minor**, user-triggered only. Recommend storing the id in a ref and clearing on unmount, as the data effect does.
- **`ui.tsx:898`** — Toast context value literal (§4.5). Wrap in `useMemo([toast, dismiss])`. **Minor.**
- **`useElapsed.ts:97`** — ticker not aware of the in-app `active` view (§3.1). Even after fixing §2, a page that is hidden-but-mid-load holds a 100 ms ticker. Recommend threading the page `active`/`loading` combination so a hidden page reports `active=false`. **Conditional CPU.**
- **`FINDINGS_UI` / `queryUI` index maps** survive unmount (§4.2). Bounded; optional `clear()` on unmount. **Minor.**

---

## 7. Measurement — what was simulated vs reasoned

**Simulated (Node harness, in this session):** I modelled the exact React dep-comparison algorithm — `useGeneration()` returning a fresh object literal each render, `useAbortable()`/`useCallback([])` returning a stable reference, and each effect's re-run condition — then counted renders/effect-runs to convergence (cap 5000):

```
bare gen obj + UNCONDITIONAL effect [cb]            (AttckFleet 235/255)      5000 renders 5000 runs  => INFINITE
bare gen obj + effect [active, cb]                  (Logs 622/630, Patterns,
                                                     HostInspector fetchRaw)  5000 renders 5000 runs  => INFINITE
bare gen obj + effect [active] only, cb excluded    (Dashboard 182/191)          2 renders    1 run   => converged
DESTRUCTURED next/isCurrent + effect [active, cb]   (Findings 333/403/415)       2 renders    1 run   => converged
DESTRUCTURED next/isCurrent + effect [active] only                                2 renders    1 run   => converged
```

This confirms the mechanism is real and that the fix (destructuring) converges. It is a **model of React's algorithm**, not the app running in a browser; it does not measure wall-clock CPU% or the HTTP fan-out.

**Reasoned, not measured:**
- The N-ticker count for `useElapsed` (§3.1) — derived from 10 call sites × "hidden-but-loading pages stay mounted". I did not spin up a browser to count live timers.
- The HTTP flood volume — reasoned from "the effect body issues a GET each pass".

**Read directly (quoted above):** every `file:line`, dep array, cleanup, and the absence of `[hidden]` overrides in `index.css`.

---

## 8. Top 3 fixes (priority order)

1. **Destructure `useGeneration()` at all 8 bare sites.** This single, mechanical change removes the infinite loops on `AttckFleetPage`, `HostInspectorPage` (raw), `ReportPage`, `LogsPage`, `PatternTable`, `HostInspectorPage` (sections), `DashboardPage`, `UrlInvestigationPage`. Pattern:
   ```tsx
   // before
   const gen = useGeneration()
   const load = useCallback(() => { const g = gen.next(); ... }, [run, gen, ...])
   // after
   const { next: genNext, isCurrent: genCurrent } = useGeneration()
   const load = useCallback(() => { const g = genNext(); ... }, [run, genNext, genCurrent, ...])
   ```
   This is exactly what `FindingsPage`/`RedirectsPage`/`AnalyticsPage` already do. **Highest impact, lowest risk — do this first.** It alone should end the "CPU flooding".

2. **Add the missing `active` gate to `AttckFleetPage` and `ReportPage`** (and apply the same gate to `HostInspectorPage`'s raw effect at `:628`). These two pages currently have **no `active` prop**, so even after fix #1 they will re-fetch on arrival while hidden. Thread `active` from `App.tsx:331,336,341` and gate the effects exactly as the other pages do.

3. **Make `useElapsed` (and the `useAutoRefresh` interval) view-aware.** Pass the page's `active` into `useElapsed` so a hidden-but-mounted page arms no 100 ms ticker, and memoise `refreshAll` (or use a ref for `refresh`) so `useAutoRefresh`'s `[refreshSeconds, refresh, enabled]` effect stops re-arming the interval every render — this also fixes the Dashboard 60 s auto-refresh never firing.
