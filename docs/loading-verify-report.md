# uNetWatch — Loading UX + Request Cancellation Revamp: Independent Verification Report

Date: 2026-10-01
Verifier: independent (adversarial). Scope: four landed batches across `admin-ui/src/`.
Spec: `docs/loading-revamp-spec.md` (cited `§n`). Audit: `docs/loading-audit.md` (cited `Audit §n`).
Baseline: `main` @ `ce3d7ff` (pre-revamp). Working tree: 18 modified files, uncommitted.

**Verdict: DO NOT SHIP** (one P0 invalid-DOM regression + a P1 unhandled-rejection regression).
See §6 for the full ranking and §7 for the final verdict.

---

## 0. Method

- Every gate and every §7 criterion was run **verbatim** from `admin-ui/`, output pasted raw.
- The baseline lint count was established independently in a clean `git worktree` at `HEAD` (not taken on trust).
- The DataTable skeleton branch was rendered through `react-dom/server` (exact HTML string) **and** re-parsed with `html5lib` (browser-equivalent HTML5 tree construction) to prove the DOM the browser builds.
- Every §4.3.5 race site and every §4.5 do-not-touch item was cross-checked against the current file, not the diff summary.

---

## 1. Gate results (Step 1)

### 1.1 `npm run build` (`tsc -b && vite build`)

```
vite v8.2.0 building client environment for production...
transforming...✓ 2901 modules transformed.
dist/assets/index-ChUyRqNc.css                 55.91 kB │ gzip:  10.24 kB
...
dist/assets/echartsTheme-DAvdrFeO.js          443.97 kB │ gzip: 150.52 kB
✓ built in 3.40s
BUILD_EXIT=0
```

**Exit 0.** PASS.

### 1.2 `npm run lint` (`oxlint`)

```
23 diagnostics in 11 files
src/components/SankeyDiagram.tsx (5 diagnostics)
src/components/loading/index.tsx (5 diagnostics)
src/components/motion.tsx (3 diagnostics)
src/components/Sidebar.tsx (2 diagnostics)
src/contexts/FilterContext.tsx (2 diagnostics)
src/components/DataTable.tsx (1 diagnostics)      117:17
src/components/ListActionDropdown.tsx (1 diagnostics)
src/components/loading/LoadingIndicator.tsx (1 diagnostics)
src/components/table/FilterBuilder.tsx (1 diagnostics)
src/components/ui.tsx (1 diagnostics)             891:17
src/contexts/ZoneContext.tsx (1 diagnostics)
LINT_EXIT=0
```

**Exit 0, 23 diagnostics.** Baseline verified independently in `/tmp/unw-baseline` (worktree at `HEAD ce3d7ff`): `oxlint | grep -c warning` → **23**. So: **0 new warnings.** PASS.

### 1.3 `npx tsc -b --noEmit`

**Exit 0.** PASS.

### 1.4 `git status --short`

```
 M admin-ui/src/api.ts
 M admin-ui/src/components/AnalyticsPage.tsx
 M admin-ui/src/components/AttckFleetPage.tsx
 M admin-ui/src/components/AttckPanel.tsx
 M admin-ui/src/components/BlacklistPage.tsx
 M admin-ui/src/components/DashboardPage.tsx
 M admin-ui/src/components/DataTable.tsx
 M admin-ui/src/components/FindingsPage.tsx
 M admin-ui/src/components/HostInspectorPage.tsx
 M admin-ui/src/components/LogsPage.tsx
 M admin-ui/src/components/PatternTable.tsx
 M admin-ui/src/components/QueryPage.tsx
 M admin-ui/src/components/RedirectsPage.tsx
 M admin-ui/src/components/ReportPage.tsx
 M admin-ui/src/components/UrlInvestigationPage.tsx
 M admin-ui/src/components/ui.tsx
 M admin-ui/src/index.css
 M admin-ui/src/lib/utils.ts
?? brag-output/
?? docs/loading-audit.md
?? docs/loading-revamp-spec.md
```

No deleted (` D`), no rename, no half-written (`??` inside `admin-ui/src/`) file. The `??` entries pre-date this revamp. **PASS.**

---

## 2. §7 acceptance criteria — item by item

| # | Criterion | Command (verbatim from §7) | Actual | Verdict |
|---|---|---|---|---|
| 7.1 | No wrong-shape `h-N w-full` block outside `ui.tsx` | `grep -rnE '<Skeleton className="h-(24\|28\|32\|40\|48\|56\|60\|64\|96)[^"]*w-full"' src/components --include='*.tsx' \| grep -v 'components/ui.tsx'` | **0 matches**, exit 1 | **PASS** |
| 7.2 | No raw tall block for a multi-panel surface | `grep -rnE 'h-(40\|56\|64)([^0-9]\|$)' src/components --include='*.tsx' \| grep 'Skeleton'` | **0 matches**, exit 1 | **PASS** |
| 7.3 | Every user-keyed request has a signal or generation guard | `grep -rnE 'AbortController\|useAbortable\|useGeneration\|signal:' src/components src/lib … \| grep -vE 'components/loading\|DataTable' \| wc -l` | **21** (≥16 ✓) — **but manual §4.3.5 cross-check FAILS** (§4 below) | **FAIL** (count passes, manual cross-check does not) |
| 7.4 | NO write path accepts a signal | spec grep → 0 matches ✓; `export type ReqOpts` exists ✓; independent audit of all 45 `ReqOpts` signatures → all GET ✓; no page passes a signal to a mutation ✓ | 0 matches; type present; 38 `opts?: ReqOpts` params all on readers; 3 `{ signal }` callsites all GET | **PASS** |
| 7.5 | `useAutoRefresh` cannot overlap | `grep -n 'inFlightRef' src/lib/utils.ts` | 4 hits (decl `:115`, skip `:129`, set `:132`, reset `:134`) — **flag correct, but Dashboard's callback returns `void` so the skip never engages there** (§4.3) | **PASS (with caveat)** |
| 7.6 | No `let cancelled`-only guard on a user-keyed request | `grep -rn 'let cancelled' src/components --include='*.tsx' \| grep -vE 'QueryPage'` | **11 matches; 10 are uncovered and off the do-not-touch list** (§4.2) | **FAIL** |
| 7.7 | Build / lint / typecheck green | `tsc --noEmit && npm run lint && npm run build` | exit 0 / 0 / 0 | **PASS** |
| 7.8 | Honest-loading invariants preserved | `LOADER_DELAY_MS`, `LOADER_MIN_VISIBLE_MS`, `role="status"`, synth-`%` grep | `250` / `400`; `components/loading/` **unchanged** (`git status` clean); synth-`%` grep → exit 1 (0 matches) | **PASS** |
| 7.9 | Motion safety preserved | `grep -rn 'framer-motion' src/components/ui.tsx` (+ guards) | 0 matches; `index.css:170` and `:173-174` intact | **PASS** |

### 2.1 Raw §7.1 / §7.2

```
$ grep -rnE '<Skeleton className="h-(24|28|32|40|48|56|60|64|96)[^"]*w-full"' src/components --include='*.tsx' | grep -v 'components/ui.tsx'
EXIT_7_1=1        # no output

$ grep -rnE 'h-(40|56|64)([^0-9]|$)' src/components --include='*.tsx' | grep 'Skeleton'
EXIT_7_2=1        # no output
```

### 2.2 Raw §7.3

```
$ grep -rnE 'AbortController|useAbortable|useGeneration|signal:' src/components src/lib --include='*.tsx' --include='*.ts' | grep -vE 'components/loading|DataTable' | wc -l
21
```

The 21 hits come from exactly **5 files**: `QueryPage.tsx` (own `AbortController`), `UrlInvestigationPage.tsx`, `PatternTable.tsx`, `FindingsPage.tsx`, `lib/utils.ts`. The count gate is satisfied; the **manual cross-check in §7.3 does not** (next section).

### 2.3 Raw §7.4

```
$ grep -rnE '(create|update|delete|add|set|clear|import|restore|sync|login)\w*\(' src/api.ts | grep -E 'ReqOpts|signal'
EXIT=1                          # no output

$ grep -n 'export type ReqOpts' src/api.ts
482:export type ReqOpts = { signal?: AbortSignal }

$ grep -c 'opts?: ReqOpts' src/api.ts
38
```

Independent proof (§7.4 is the highest-stakes gate — a signal on a write is the dangerous failure mode):

- A signature parser over all **101** functions in `api.ts` found **45** with `ReqOpts` in the signature: `runQuery`, `request`, and 43 readers. **Every one of the 43 readers issues a `GET`** (they call `request()` with no `method`, or a direct `fetch` with no `method`).
- The 5 direct-`fetch` readers forward the signal explicitly and preserve the 401 path:
  `getBlacklistUrls` (`:1290-1300`), `getBlacklistIps` (`:1302-1310`), `getBlacklistSet` (`:1326-1334`), `getJaillistIps` (`:1400-1408`), `getJaillistSet` (`:1424-1432`) — each `fetch(..., { signal: opts?.signal })` + `if (res.status === 401) { setToken(null); _onSessionExpired?.() }`.
- Every mutation (`deleteLog`, `clearLogs`, `bulkDeleteLogs`, `createPattern`, `updatePattern`, `deletePattern`, `bulkImport`, `deleteFinding`, `clearFindings`, `bulkDeleteFindings`, `addBaseUrlToBlacklist`, `deleteBlacklistEntry`, `bulkAddBlacklist`, `bulkDeleteBlacklist`, `syncBlacklistUpstream`, `addClientIpToJaillist`, `deleteJaillistEntry`, `bulkAddJaillist`, `bulkDeleteJaillist`, `syncJaillistUpstream`, `addTrackedUrl`, `deleteTrackedUrl`, `putKibanaSettings`, `putFieldMap`, `putAlerts`, `importBackup`, `exportBackup`, `triggerManualRun`, `retryWebhook`, `testKibanaConnection`, `checkRedirects`, `checkRedirectsBackground`) has **no `ReqOpts`** parameter.
- No page passes a signal to a mutation: `grep … | grep -E '\{ signal|, *signal'` → exit 1.

**§7.4 PASSES on every axis, including the independent one.**

### 2.4 Raw §7.8 / §7.9

```
$ grep -rn '%' src/components/loading --include='*.tsx' | grep -vi 'percent\|progress\|width'
EXIT=1                          # no output

$ grep -rn 'framer-motion' src/components/ui.tsx
EXIT=1                          # no output

$ git status --short -- admin-ui/src/components/loading/
                                # empty → loading module untouched
$ grep -n 'LOADER_DELAY_MS = \|LOADER_MIN_VISIBLE_MS = ' src/components/loading/useDelayedVisible.ts
7:export const LOADER_DELAY_MS = 250
13:export const LOADER_MIN_VISIBLE_MS = 400
$ grep -n 'skeleton-shimmer|data-paused|prefers-reduced-motion' admin-ui/src/index.css
167:.skeleton-shimmer { … 14px … color-mix(… 10%, transparent) 14px 22px); animation: skeleton-shimmer 1.1s ease-in-out infinite; }
170:html[data-paused] *, html[data-paused] *::before, html[data-paused] *::after { animation-play-state: paused !important; }
173:@media (prefers-reduced-motion: reduce) { … animation-duration: 0.01ms !important; … }
```

`index.css` diff is **exactly 1 changed line**, matching §3.4 byte-for-byte. **PASS.**

---

## 3. Race-site cross-check (Audit §4.3.5 / Spec §4.5)

**Per-file mechanism census (current tree):**

```
AnalyticsPage              hooks=0 abortController=0
AttckFleetPage             hooks=0 abortController=0
UrlInvestigationPage       hooks=2 abortController=0
HostInspectorPage          hooks=0 abortController=0
FindingsPage               hooks=4 abortController=0
LogsPage                   hooks=0 abortController=0
RedirectsPage              hooks=0 abortController=0
ReportPage                 hooks=0 abortController=0
PatternTable               hooks=3 abortController=0
BlacklistPage              hooks=0 abortController=0
JaillistPage               hooks=0 abortController=0
DashboardPage              hooks=0 abortController=0
QueryPage                  hooks=0 abortController=2
```

Only **3 of the 13** listed pages import `useAbortable`/`useGeneration` (`FindingsPage`, `PatternTable`, `UrlInvestigationPage`); `QueryPage` uses its own pre-existing `AbortController`.

| # | Audit §4.3.5 site | Mechanism required | Present? | Evidence |
|---|---|---|---|---|
| 1 | `AnalyticsPage.tsx` `fetchAll` (5 parallel) | `useAbortable` + `useGeneration` | **NO** | `AnalyticsPage.tsx:167-196` unchanged; `getAnalyticsSummary…` at `:172-176` called with no signal; poll `useAutoRefresh(fetchAll,…)` `:198` |
| 2 | `AnalyticsPage.tsx` `fetchRaw` (rawSearch, not debounced) | `useAbortable` | **NO** | `AnalyticsPage.tsx:201-224`; `getFindings({search: rawSearch…})` `:205-210`, no signal |
| 3 | `PatternTable.tsx` `fetchPatterns` | `useAbortable` | **YES** | `PatternTable.tsx:156` `const run = useAbortable()`; `:195-204` `run((signal) => listPatterns({…}, { signal }))` |
| 4 | `AttckFleetPage.tsx` `fetchFleet` | `useAbortable` | **NO** | `AttckFleetPage.tsx:229-237`; `getFleetAttckMapping({timeRange})` no signal |
| 5 | `UrlInvestigationPage.tsx` `investigate` | `useAbortable` (getUrlBreakdown signal) | **YES (but see R2)** | `:101` hook; `:113-115` `getUrlBreakdown(trimmed, {…}, { signal })` |
| 6 | `HostInspectorPage.tsx` `lookup` (**"Highest"**) | `useAbortable` + `useGeneration` | **NO** | `HostInspectorPage.tsx:487-` plain async, no guard at all; `getHostProfile(clean,…)`, `getClientReport(clean)` |
| 7 | `HostInspectorPage.tsx` Live/Findings toggle | `useAbortable` | **NO** | effect `:409-427` (now `:411`), `getClientReport(…)` no signal |
| 8 | `HostInspectorPage.tsx` `fetchHostSections` | `useAbortable` | **NO** | effect `:430-446` (now `:432`), `fetchHostSections(ip,…)` no signal |
| 9 | `HostInspectorPage.tsx` `fetchRaw` | `useAbortable` | **NO** | `:535` `fetchRaw`; `getClientReportFindings(…)` no signal |
| 10 | `FindingsPage.tsx` `refetch` | `useAbortable` + `useGeneration` | **YES** | `:327-328` hooks; `:367-372` run+signal; `:375/:381/:393` generation guards |
| 11 | `LogsPage.tsx` `load` | `useAbortable` | **NO** | `LogsPage.tsx:574-607`; `listLogs({…})` no signal |
| 12 | `RedirectsPage.tsx` `loadTable` | `useAbortable` | **NO** | `RedirectsPage.tsx:339-369`; `listTrackedUrls({…})` no signal |
| 13 | `RedirectsPage.tsx` `loadGraph` | `useAbortable` | **NO** | `RedirectsPage.tsx:371-389`; `getRedirectGraph()` no signal |
| 14 | `HostInspectorPage.tsx` `getHostProfile` effect | `useAbortable` | **NO** | `:450-466` (now `:452`); `getHostProfile(ip, timeRange)` `:455`, `let cancelled` only |
| 15 | `ReportPage.tsx` main read (up to 5 parallel) | `useAbortable` (one shared signal) | **NO** | `ReportPage.tsx:331-356`; `getHostProfile(value,"24h")` `:336`, `getClientReport(value)` `:339`, `getUrlBreakdown(value,…)` `:348` — all with only `let cancelled` |

**Poll callbacks (§4.5):**

| Site | Required | Present? | Evidence |
|---|---|---|---|
| `AnalyticsPage.tsx:198` | in-flight skip + `useGeneration` | **skip-only** | `fetchAll` is `async` → returns a promise → skip engages; **no `useGeneration`** |
| `DashboardPage.tsx:167` | in-flight skip + `useGeneration` on `fetchRecent` | **NO skip, NO generation** | `refreshAll` (`:164-166`) has a `{}` body → returns `undefined` → the in-flight flag **never engages**; `fetchRecent` (`:137`) has no guard |
| `FindingsPage.tsx:405` | in-flight skip + `useAbortable` | **YES** | `refetch` returns `run(...)` (promise) → skip engages; `:327-328` hooks |
| `QueryPage.tsx:694` | leave as-is | **as-is** | `fetchQuery` returns a cleanup fn (not thenable) → skip moot; aborts at `:646` (spec-sanctioned) |

**Score: 3 of 15 race sites + 2 of 3 poll callbacks migrated.** The five pages the audit called "**no guard at all**" (`AnalyticsPage`, `PatternTable`, `UrlInvestigationPage`, `AttckFleetPage`, `HostInspectorPage`) — Batch 4's top priority — landed for only two of them (`PatternTable`, `UrlInvestigationPage`). `HostInspectorPage`, explicitly the "**Highest**" risk in §4.5/§6, received **zero** cancellation work.

Low-risk set: `BlacklistPage.tsx:354`, `JaillistPage.tsx:69`, `DashboardPage.tsx:98/115/137` — all still `let cancelled`-only, no `useGeneration`. Also unmigrated.

---

## 4. Behaviour-preservation checklist (Step 3)

### 4.1 `FindingsPage.tsx` — ✅ CORRECT (the model to copy)

- Never-blank rule: `.catch` (`:380-391`) → `if (isFirstLoad) { setFindings([]); setTotal(0) }`. A **failed refetch keeps rows**; a failed **first load** may reset. Matches Spec §4.6 exactly.
- Generation guard before **every** `setState`: `:375` (then), `:381` (catch), `:393` (finally) all `if (!gen.isCurrent(g)) return`.
- `AbortError` cannot reach the banner: `:382` returns before `setError`; `useAbortable` also resolves `AbortError` to `undefined`.
- `useAutoRefresh` callback returns its promise: `refetch` returns `run(...)` (`:367`); wired at `:405`.

### 4.2 `PatternTable.tsx` / `UrlInvestigationPage.tsx` — PatternTable ✅; UrlInvestigationPage ⚠️ (see R2)

- `PatternTable.tsx`: signal wraps *only* `listPatterns` (`:195-204`); aborted → `undefined` → `:207` returns before `setPatterns`. Handlers `handleSearchChange`/`handleFilterChange`/`handleSortChange` (`:226-240`) unchanged; sort/filter/page deps unchanged (`:209`).
- `UrlInvestigationPage.tsx`: signal wraps *only* `getUrlBreakdown` (`:113-115`); aborted → `undefined` → `:116` returns. **But** non-abort errors are now unhandled (R2).

### 4.3 `DataTable.tsx` — ⚠️ logic preserved; skeleton branch is INVALID DOM (R1)

- Diff is minimal: imports (`:25`), `skeletonRows` default `8 → undefined` (`:418`), a doc-comment on `DENSITY_PAD` (`:370-374`), and the skeleton branch (`:1228-1240`). Sorting / filtering / selection / export / persistence / sticky / context-menu / refetch-loader / empty-state are **untouched**.
- **R1:** the branch now renders `<TableSkeleton>` (`:1235`) as a **direct child of `<table>`**, between `</thead>` and `<tbody>`. `TableSkeleton` emits `<div><table>…</table></div>` (`ui.tsx:484-520`). This is invalid HTML. Proven two ways:
  - SSR (`react-dom/server`) emits, literally:
    ```html
    <table class="w-full text-sm" aria-label="Findings">
      <thead><tr>…</tr></thead>
      <div class="overflow-x-auto rounded-md border border-border bg-card shadow-none" aria-hidden="true">
        <table class="w-full text-sm" aria-hidden="true"><tbody>…skeleton rows…</tbody></table>
      </div>
      <tbody><tr>…real row…</tr></tbody>
    </table>
    ```
  - `html5lib` (browser-equivalent tree construction) **foster-parents** the `<div>` out of the table:
    ```
    <body>
      <div class='overflow-x-auto'>      ← skeleton wrapper, moved OUT of the table
      <table><thead><tr><th>'Findings'…
      <table><tbody><tr><td>'skel'
      #tail 'real'
    ```
  - Effect in a browser: the skeleton table detaches above/outside the real table and the real `<thead>` is left with no body. This is the *exact* layout jump the spec exists to remove, on **7 DataTable callsites** that pass a `loading` prop reaching this branch: `AnalyticsPage:746,762,819`, `FindingsPage:700`, `HostInspectorPage:1217,1293`, `LogsPage:756`, `PatternTable:396`, `RedirectsPage:850`.
- **Secondary (R5):** §3.1 required `DENSITY_PAD` "promoted to a shared export". It is instead **duplicated** as module-private in both `DataTable.tsx:375` and `ui.tsx:455`, with a comment admitting the two "MUST move together" — precisely the drift the "one implementation" rule forbids.
- **Minor:** `skeletonRows` default changed `8 → undefined` with fallback `?? pageSize ?? 25`; a real-but-intentional row-count change.

### 4.4 Skeleton-shape pages: data flow preserved? — ✅ for shape branches, ⚠️ for refetch branches

- `QueryPage.tsx`, `LogsPage.tsx`, `AnalyticsPage.tsx`, `RedirectsPage.tsx`, `HostInspectorPage.tsx`, `ReportPage.tsx`, `BlacklistPage.tsx`: the **first-load** branches were converted to `SkeletonShape`/`TableSkeleton`; the **refetch-keeps-content + quiet indicator** branches were **NOT** converted. Verified:
  - `QueryPage.tsx:1010` `aria-busy={loading}` region keeps panels; `:1013-1023` failed-refetch `Callout`; `:1026-1032` `LoadingIndicator`. ✅
  - `LogsPage.tsx:722-733` keeps `LoadingIndicator` on refetch; first-load skeleton removed so `DataTable` owns it. ✅
  - `AnalyticsPage.tsx:673` `loading && !summary` gates the skeleton (refetch keeps content). ✅
  - `RedirectsPage.tsx:732` `graphLoading && !graph` (refetch keeps graph). ✅
- `RedirectsPage` `openHistory` ordering fix (`:608-624`): changed to `if (historyTarget?.id !== target.id) setHistory(null)`. **Behaviour-preserving for the target-change case**, but the §4.6 intent is **not achieved** (R4): the render branch (`:929`) is `historyLoading ? SkeletonShape : …` — it ignores `history` entirely while loading, so a same-target reopen still shows the skeleton and the retained `history` is never rendered. The fix is inert.

### 4.5 `ui.tsx` — ✅ primitives sound; `TableSkeleton` misuse is in DataTable, not here

- `TableSkeleton` emits a cell for **every** column with `col.width ?? "w-24"` fallback (`ui.tsx:510-514`) — the Analytics dropped-column fix is real (§5.4 verification below).
- `SkeletonShape` has all **6** variants: `stat-grid` (`:550`), `chart` (`:562`), `panel-stack` (`:582`), `feed-list` (`:604`), `dag` (`:626`), `edge-list` (`:649`). All roots `aria-hidden="true"`, all CSS-only.
- `ui.tsx` diff has **zero removed lines** (224 insertions only) → `RankedTable`, `SimpleTable`, `Skeleton`, and every other primitive are byte-identical. `Skeleton` (`:435-441`) unchanged. ✅
- The Analytics identity-column fix works *through* the primitive: `domainColumns`/`clientsColumns` identity entries still declare **no** `width` (`AnalyticsPage.tsx:281-287`), but `DataTable` passes `visibleColumns.map(c => ({ width: c.width }))` → `TableSkeleton` falls back to `w-24`. Intent satisfied.

### 4.6 `lib/utils.ts` — ✅ correct

- `useAbortable` (`:49-65`): aborts previous *before* installing a fresh controller (`:57-59`); swallows `AbortError` → `undefined` (`:61`); non-abort rethrows; unmount aborts via `useEffect(() => () => …)` (`:52-54`).
- `useGeneration` (`:79-84`): `next()` = `++genRef.current` (monotonic); `isCurrent(g)` = `g === genRef.current`.
- `useAutoRefresh` (`:96-142`): **skips** (`:128-129`), never aborts; localStorage persistence (`:117-123`) and visibility skip (`:128`) preserved; `inFlightRef` is a ref (`:115`).
- `useDebounce` (`:21-28`) untouched (diff adds only new lines after it).

### 4.7 `api.ts` — ✅ correct

- `ReqOpts` exists (`:482`); `request()` (`:484-501`) unchanged except the type widened; 401/session handling intact (`:490-494`).
- 38 readers gained `opts?: ReqOpts`; the 5 direct-`fetch` readers forward `signal` and keep 401 handling; no mutation gained a signal.
- `probeEsHealth` (`:519`) has **no** `ReqOpts` — §5.4 respected. `login`/`exportBackup`/`triggerManualRun`/`retryWebhook`/`checkRedirectsBackground` — no `ReqOpts`. ✅
- **R6 (low):** §5.4 says `getOperatorZone` is "likewise left signal-free", but `getOperatorZone(opts?: ReqOpts)` now forwards one (`:2453-2456`). The spec contradicts itself (§4.1:620 lists it as "optional but harmless"); the caller `ZoneContext.tsx:18` passes none, so no runtime effect. Deviation from §5.4, not a defect.

---

## 5. §4.5 "should NOT be cancellable" — hard check

This is the most dangerous failure mode; every added mechanism was inspected individually.

| Added at | Wraps | Is it a write? | Verdict |
|---|---|---|---|
| `PatternTable.tsx:195` | `listPatterns` (GET) | No | ✅ |
| `UrlInvestigationPage.tsx:113` | `getUrlBreakdown` (GET) | No | ✅ |
| `FindingsPage.tsx:367` | `getFindings` (GET) | No | ✅ |
| `QueryPage.tsx:654` (pre-existing) | `runQuery` (POST *read*) | Read-shaped | ✅ (unchanged) |
| `useAutoRefresh` in-flight flag | none | flag only, never aborts | ✅ |

- No `AbortController`/signal on any POST/PUT/DELETE: `grep … | grep -E 'signal'` over all mutation callsites → 0.
- `probeEsHealth`, `checkRedirectsBackground`, `login`, backup export/import, blacklist/jaillist add/delete/clear/sync — all signal-free.
- **No cancellation was added to anything on the do-not-touch list.** The §4.5 contract holds. (The one deviation, `getOperatorZone`, is a read.)

---

## 6. Regressions, missed sites, unsound claims — ranked

### P0 — R1. `TableSkeleton` rendered inside `<table>` → invalid DOM on every DataTable first load

`admin-ui/src/components/DataTable.tsx:1235` (branch opener `:1234`, `loading && data.length === 0`).
The primitive is a `<div>`-rooted block (`ui.tsx:484-520`) placed between `</thead>` (`:1227`) and the real `<tbody>` (`:1243`), as a direct child of `<table>` (`:1152`).

Reproduce (exact HTML the browser receives):
```
$ cd admin-ui
$ grep -n '<TableSkeleton\|<table\|</thead>\|<tbody' src/components/DataTable.tsx | sed -n '1,8p'
1152:        <table className="w-full text-sm" aria-label={ariaLabel}>
1227:          </thead>
1235:            <TableSkeleton
1243:            <tbody>
```
Reproduce (DOM the browser builds) — SSR the branch or feed it to `html5lib`: the `<div>` is foster-parented **out** of the table, so the skeleton rows detach above the real header and the header is left bodiless.

Impact: the first-load placeholder is misaligned/unparented on `AnalyticsPage:746,762,819`, `FindingsPage:700`, `HostInspectorPage:1217,1293`, `LogsPage:756`, `PatternTable:396`, `RedirectsPage:850` — the opposite of §2 Principle 1 and §3.1's "renders `<TableSkeleton>` inside its **existing** `<table>`/`<thead>`".

Fix direction (not applied): render only the skeleton **rows** (`<tr>/<td>`, i.e. a `<tbody>`) inside DataTable's existing table; keep the `<div>`/`<table>` wrapper for the standalone callers (`QueryPage:985`, `UrlInvestigationPage:300`). The spec's own §3.1 wording ("`header={false}` … the primitive renders only the skeleton `<tbody>` rows") already assumes this, but the primitive emits a nested `<table>` regardless.

### P1 — R2. `UrlInvestigationPage.investigate` drops all error handling → unhandled rejection + stuck spinner

`admin-ui/src/components/UrlInvestigationPage.tsx:102-119`. The old code had `try/catch/finally` that did `setError(...)`, `setResult(null)`, `setLoading(false)` (`git show HEAD:…:108-116`). The new body:
```ts
const res = await runBreakdown((signal) =>
  getUrlBreakdown(trimmed, { limit: 100, source: uSource }, { signal }),
)
if (res === undefined) return         // aborted
setResult(res)
setLoading(false)
```
There is **no `try/catch`** and **no `.catch`**; `useAbortable` rethrows non-abort errors.

Impact (two failure modes):
1. **Any real failure** (HTTP 500, session expiry, network) → unhandled promise rejection; `error` Callout (`:280`) can never be set; `loading` stays `true` → the button shows "Investigating…" forever.
2. **Narrow stuck-loading:** if a newer `investigate` supersedes an in-flight one and itself takes the `!trimmed` early return (`:104-107`, which does not touch `loading`), neither invocation clears `loading`.

Reproduce: `grep -n 'try\|catch' src/components/UrlInvestigationPage.tsx` → the only matches are the unrelated jaillist effect (`:93`) and clipboard helpers (`:135-188`); `investigate` itself has none. Then run the page against a dead API and observe the permanent spinner.

### P2 — R3. Dashboard poll cannot skip; `fetchRecent` unguarded — the §4.4 skip is inert for the one site that needed it

`admin-ui/src/components/DashboardPage.tsx:164-167`.
```ts
const refreshAll = useCallback(() => {   // returns undefined
  onRefresh()
  fetchRecent()
}, [onRefresh, fetchRecent])
const { refreshSeconds, setRefreshSeconds } = useAutoRefresh(refreshAll, "dashboard", 60)
```
Because `refreshAll` returns `undefined`, `useAutoRefresh`'s `typeof out.then === "function"` test (`utils.ts:131`) is false → `inFlightRef` is never set → **ticks can still overlap every 60s**, exactly Audit §3.5's Dashboard case. `fetchRecent` (`:137-160`) also has no `useGeneration`. Spec §4.5 required both.

Reproduce: `grep -n 'refreshAll' src/components/DashboardPage.tsx` → callback body ends `fetchRecent()` with no `return`.

### P2 — R4. `RedirectsPage.openHistory` "never-blank" fix is inert

`admin-ui/src/components/RedirectsPage.tsx:613` keeps `history` on a same-target reopen, but the render branch (`:929`) is `historyLoading ? <SkeletonShape variant="edge-list"/> : …` and never reads `history` while loading. So the retained data is never shown; a same-target reopen still skeletons. Spec §4.6 intent not met.
Reproduce: `grep -n 'historyLoading ?\|historyTarget?.id' src/components/RedirectsPage.tsx` → `:613`, `:929`.

### P2 — R5. `DENSITY_PAD` duplicated instead of shared → silent drift risk

`admin-ui/src/components/DataTable.tsx:375` and `admin-ui/src/components/ui.tsx:455` are two module-private copies with identical values. §3.1 mandated a shared export. The `ui.tsx` comment (`:449-454`) concedes the coupling. A future density edit in one will silently misalign the other's skeleton.
Reproduce: `grep -n 'DENSITY_PAD' src/components/DataTable.tsx src/components/ui.tsx`.

### P1 — R6. Ten §4.5 sites not migrated at all (the largest gap by volume)

`AnalyticsPage.fetchAll/fetchRaw` (#1,#2), `AttckFleetPage.fetchFleet` (#4), `HostInspectorPage.lookup` (#6, "**Highest**"), the two HostInspector toggle effects (#7,#8), `HostInspectorPage.fetchRaw` (#9), `LogsPage.load` (#11), `RedirectsPage.loadTable/loadGraph` (#12,#13), `ReportPage` main read (#15), plus `BlacklistPage`/`JaillistPage`/`DashboardPage` low-risk loads. None gained a mechanism; all are verbatim `HEAD` behavior. §7.3's count gate (21≥16) masks this because it counts `lib/utils.ts` definitions and `QueryPage`'s pre-existing `AbortController`.

### P2 — R7. §4.6 never-blank rule not applied to three unmigrated loaders

`LogsPage.tsx:595-597` (`setItems([]); setTotal(0)` on any failure), `RedirectsPage.tsx:357-360` (`setItems([]); setTotal(0)`), `DashboardPage.tsx:148-150` (`setRecentFindings([])`), and `HostInspectorPage.tsx:415-417` (`setReport(null)`). A failed refetch on these surfaces still blanks good data — the same class of bug the spec fixed for `FindingsPage`/`QueryPage`.

### P3 — R8. Analysis/identity minor items

- §6 Batch 2 required `QueryPage.tsx` to pass `loading={firstLoad && loading}` to its `DataTable` (Audit §4.4 gap 4). `QueryPage.tsx:1216-1224` still passes only `busy={loading}`; the gap is masked by the outer `TableSkeleton` (`:985`) but the requested wiring is absent.
- `getOperatorZone` gained `ReqOpts` against §5.4 (see §4.7); no runtime effect.

---

## 7. Final verdict

**DO NOT SHIP.**

The cancellation *contract* is sound where it landed, and the "never cancel a write" rule — the dangerous failure mode — is **fully honoured** (no signal on any mutation; §7.4 passes independently). §7.1, §7.2, §7.4, §7.5 (mechanism), §7.7, §7.8, §7.9 pass, and build/lint/tsc are green with **0 new warnings** (baseline 23 re-verified).

But two of the four batches did not do the job the spec asked, and one of them actively broke a surface:

- **R1 (P0)** — the single delegated skeleton implementation is rendered as invalid HTML inside `<table>`, so every DataTable first load (`Analytics`, `Findings`, `HostInspector` ×2, `Logs`, `PatternTable`, `Redirects`, `Query` raw) shows a detached, misaligned skeleton. The revamp's headline goal (no shape mismatch) is *worse* here than before.
- **R2 (P1)** — `UrlInvestigationPage` lost its error path entirely: a failed read now spins forever with no banner.
- **R3–R8 (P1/P2)** — 10 of 15 race sites unmigrated (including the audit's "Highest"), the Dashboard poll still cannot skip, the `Redirects` history fix is inert, and three more loaders still blank good data on a failed refetch.

**Most important remaining issue: R1** — it is the only defect that makes the shipped UI visibly worse than the baseline for ordinary users on the most common first-load path. Fixing R1 (render skeleton rows, not a nested table) and R2 (restore `try/catch`) would move this to SHIP WITH CAVEATS; closing R6's `HostInspectorPage`/`AnalyticsPage` gap would make the cancellation half of the revamp truthful.

### Claims that could not be verified

- Batch commit messages / PR summaries were not provided, so "four batches landed" is taken from the file diff, not from prose. The diff shows shape work across 11 sites and cancellation across 3 pages — consistent with Batches 0–3 landing and Batch 4 only partially.
- No browser was driven (no headless Chromium available in this environment). R1 is proven by SSR output + the HTML5 tree-construction algorithm (html5lib), which is the specification browsers implement; the visual result is inferred, not screen-captured.
