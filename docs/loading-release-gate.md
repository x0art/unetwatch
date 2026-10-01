# Loading-UX + request-cancellation revamp — FINAL RELEASE GATE

Scope: `admin-ui/` — the loading/skeleton UX revamp and the request-cancellation
migration. **Read-only gate**: no application file was modified by this review.
All paths are relative to `admin-ui/` unless stated otherwise.

Method: every gate re-run from source; every claimed fix re-read in the *current*
tree (not taken from the prior `loading-verify-final.md` summary). The P0 (R1) was
**reproduced end-to-end** with `react-dom/server` + `html5lib 1.2`. Adversarial:
each `.catch`/`finally` in the ten migrated files was inspected individually.

---

## 1. Gates (exact output)

### 1.1 `npm run build` (tsc -b && vite build) — **EXIT 0**

```
> tsc -b && vite build

vite v8.2.0 building client environment for production...
transforming...✓ 2901 modules transformed.
rendering chunks...
computing gzip size...
dist/index.html                                 1.49 kB │ gzip:   0.65 kB
dist/assets/index-ChUyRqNc.css                 55.91 kB │ gzip:  10.24 kB
dist/assets/DataTable-CVCJe1eg.js              61.21 kB │ gzip:  18.65 kB
dist/assets/RedirectsPage-xORbEeK0.js          52.38 kB │ gzip:  17.65 kB
dist/assets/HostInspectorPage-CikvsSii.js      41.27 kB │ gzip:  11.33 kB
dist/assets/echartsTheme-DAvdrFeO.js          443.97 kB │ gzip: 150.52 kB

✓ built in 1.47s
BUILD_EXIT=0
```

### 1.2 `npm run lint` (oxlint) — **EXIT 0**, 23 warnings / 0 errors (== baseline)

```
> admin-ui@0.0.0 lint
> oxlint

23 diagnostics in 11 files
(src/components/SankeyDiagram.tsx (5) · loading/index.tsx (5) ·
 motion.tsx (3) · Sidebar.tsx (2) · FilterContext.tsx (2) ·
 DataTable.tsx (1) · ListActionDropdown.tsx (1) ·
 loading/LoadingIndicator.tsx (1) · table/FilterBuilder.tsx (1) ·
 ui.tsx (1) · ZoneContext.tsx (1))
   … all react(only-export-components) Fast-refresh advisories …
LINT_EXIT=0
```

Warning count is exactly 23 (`npm run lint 2>&1 | grep -cE 'warning'` → `23`);
error count 0. **No new warnings.**

### 1.3 `npx tsc -b --noEmit` — **EXIT 0**

```
TSC_EXIT=0
```

### 1.4 `git -C /home/x0art/Project/uNetWatch status --short` — **EXIT 0**

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
?? docs/loading-verify-final.md
?? docs/loading-verify-report.md
```

No ` D ` (deleted) and no half-written / untracked source file. The only untracked
entries are pre-existing artifacts (`brag-output/`) and the four loading docs.
The gate harness's temporary `_ssr_proof.*` files were removed by this review;
`git status` is clean of them.

**Gates: ALL PASS.**

---

## 2. Defect-by-defect verification (current source)

| Defect | Status | Evidence (`file:line`) | Command run |
|---|---|---|---|
| **R1** invalid DOM in DataTable skeleton (P0) | **FIXED** | `DataTable.tsx:1227` `</thead>` → `:1240` real `<tbody>` → `:1241-1246` `<SkeletonRows>` → `:1247` `</tbody>`; `SkeletonRows` at `:1751-1776` emits only `<tr>/<td>` | SSR + html5lib, §3 below |
| **R2/N1** UrlInvestigation stuck spinner | **FIXED** | `UrlInvestigationPage.tsx:120` `setLoading(true)`; clears `false` at `:112` (empty), `:135` (aborted-current), `:140` (success-current), `:146` (AbortError-current), `:154` (non-abort error-current); `gen.next()` `:118`; `gen.isCurrent(g)` `:132,:139,:143`; `gen` in deps `:157` | `sed -n '75,200p'` |
| **R3** `refreshAll` returned void | **FIXED** | `DashboardPage.tsx:179-182` `refreshAll = useCallback(() => { onRefresh(); return fetchRecent() }, …)`; `fetchRecent` `:146-175` returns the `runRecent(...)` chain | `grep -n 'refreshAll\|return fetchRecent'` |
| **R4** RedirectsPage never-blank inert | **FIXED** | branch `RedirectsPage.tsx:955` `historyLoading && !history`→skeleton; `:960` `historyLoading && history`→retained edges + `<LoadingIndicator label="Refreshing history">`; `:990` error; `:995` populated; `:1017` empty. `openHistory:634` nulls only on target change | `sed -n '930,1023p'` |
| **R5** `DENSITY_PAD` duplication | **ACCEPTED** (unchanged) | two copies `ui.tsx:455`, `DataTable.tsx:375` + the mirror row-loop `SkeletonRows` `DataTable.tsx:1751` | `grep -rn 'DENSITY_PAD'` |
| **R6** unmigrated race sites | **FIXED** | §4.3.5 census — no zeros (see §4) | loop grep, §4 |
| **R7** never-blank on failed refetch | **FIXED** | Logs `isFirstLoad` gate `LogsPage.tsx:604-608`; Redirects `:371,:402`; Dashboard `isFirstLoad` `DashboardPage.tsx:148,166`; Findings `:385` | source read |
| **N3** HostInspector stale closure | **FIXED** | `HostInspectorPage.tsx:358` `reportRef`; `:359` `reportRef.current = report` (synced each render); read at `:454` `if (!reportRef.current) setReport(null)` | `sed -n '356,360p;452,456p'` |

### 2.1 R2/N1 — all five `investigate` paths walked

```
:107  empty input            → setLoading(false)  [line 112]   ✓ button usable
:118  gen.next() claimed; setLoading(true); setError(null); setSearched(trimmed)
:126  await runBreakdown((signal) => getUrlBreakdown(..., { signal }))
:131  !gen.isCurrent(g)        → return            (superseded: newer owner clears)
:134  res === undefined (abort while current) → setLoading(false) [line 135]
:139  success & current        → setResult(res); setLoading(false) [line 140]
:143  catch: !isCurrent        → return
:145  AbortError & current     → setLoading(false) [line 146]
:152  non-abort error & current→ setError; setResult(null); setLoading(false) [line 154]
```

`AbortError` never surfaces (guarded `:145`; and `useAbortable` already converts it
to `undefined`). `gen` is in the `useCallback` deps: `}, [runBreakdown, gen, toast,
uSource])` at `:157`. **Every still-current terminal path clears `loading`.** The
superseded paths deliberately do not — the newer invocation owns the spinner. No
stuck button.

### 2.2 R1 — structural + SSR/parse proof

**Structural:** the loading branch is `<tbody><SkeletonRows/></tbody>` between the
real `</thead>` (`:1227`) and the live-row `Stagger as="tbody"` (`:1273`). No
`<div>`/`<table>` is emitted between them; `SkeletonRows` (`:1751`) emits bare
`<tr>`s. The wrapper-bearing `TableSkeleton` (`ui.tsx:475`) is **not** used here.

**Reproduced** with the real component, real `ToastProvider`, and a
`document.visibilityState` shim (`renderToStaticMarkup`, `loading={true}`,
`data={[]}`, columns Name `w-40` + Count widthless):

```
=== counts ===
<table occurrences: 1
<tbody occurrences: 1
<tr occurrences: 26          # 1 header + 25 skeleton rows
```

Markup from `</thead>`:

```html
</thead><tbody><tr class="border-b border-border last:border-b-0"><td class="px-4 py-3"><div class="relative overflow-hidden rounded-md border border-border bg-muted h-4 w-40" aria-hidden="true"><div class="skeleton-shimmer absolute inset-0"></div></div></td>…</tr>…25 more identical <tr>…</tbody>
```

**html5lib 1.2 parse (browser-equivalent):**

```
TABLES total: 1
  table aria-label= Findings direct children: ['thead', 'tbody']
real <table aria-label=Findings> count: 1
real table direct children: ['thead', 'tbody']
nested <table> inside real table: 0
real thead children tags: ['tr']
real thead <tr> count: 1
real tbody <tr> count: 25
bad children directly inside real table: []
body direct children tags: ['div', 'div']
```

**Contrast (the OLD shape, same parser) — confirms the defect class is real and gone:**

```
OLD: tables: 2 [['thead'], ['tbody']]
OLD body direct children: ['div', 'table', 'table']   # wrapper foster-parented OUT
```

**R1: FIXED, proven at the DOM layer.** (Visual pixel proof still unavailable — no
headless browser in this environment; the P0 was raised at the DOM layer, which is
where it is now proven clean.)

### 2.3 R4 — branch ordering (error branch cannot be shadowed)

```tsx
:955  {historyLoading && !history ? (      <SkeletonShape variant="edge-list" />
:960  ) : historyLoading && history ? (    <LoadingIndicator label="Refreshing history" /> + retained edges
:990  ) : historyError ? (                 <Callout>Retry</Callout>
:995  ) : history && history.edges.length > 0 ? (  populated edges
:1017 ) : (                                "No redirects observed…"
```

Ordering is correct: the two loading branches consume `historyLoading` first, so the
`historyError` branch (position 4) is only reachable once loading has settled — a
failed refetch over retained edges shows the retained list + cue, and an error with
no data shows the Callout. `openHistory:634` preserves `history` on a same-target
reopen (`if (historyTarget?.id !== target.id) setHistory(null)`), which is exactly
what makes the `:960` branch live. **FIXED.**

---

## 3. Safety re-check

### 3.1 No signal on a mutation — **PASS**

```
$ grep -rnE '(delete|clear|add|create|update|put|import|restore|sync|retry|checkRedirects|trigger|bulk)[A-Za-z]*\(.*signal' src/components --include='*.tsx'
EXIT_A=1                     # no output
```

Every `(signal) =>` call site (22 across 10 files) wraps a **reader only**:
`getFindings`, `getUrlBreakdown`, `getRedirectGraph`, `getHostProfile`,
`getClientReport`, `fetchHostSections`, `getHostEnrichment`, `listPatterns`,
`listLogs`, `listTrackedUrls`, `getAnalytics*` (×5), `getFleetAttckMapping`,
`runQuery` (a GET read). Every mutation export in `api.ts` — `deleteLog`,
`clearLogs`, `bulkDeleteLogs`, `retryWebhook`, `createPattern`, `updatePattern`,
`deletePattern`, `bulkImport`, `triggerManualRun`, `deleteFinding`, `clearFindings`,
`bulkDeleteFindings`, `addBaseUrlToBlacklist`, `syncBlacklistUpstream`,
`addClientIpToJaillist`, `syncJaillistUpstream`, `addTrackedUrl`, `deleteTrackedUrl`,
`checkRedirects`, `checkRedirectsBackground`, `importBackup`, `put*` — takes **no**
`ReqOpts`:

```
$ awk '/^export async function (delete|clear|add|create|update|put|import|restore|sync|retry|trigger|bulk|checkRedirects)/,/\): Promise|\): \{/' src/api.ts | grep -n 'ReqOpts\|signal'
EXIT=1                       # no output
```

**No write path accepts or is handed a signal.** §4.5 contract holds.

### 3.2 Poll ticks skip, never abort — **PASS**

`lib/utils.ts:128-138`: `if (document.visibilityState === "hidden") return; if
(inFlightRef.current) return;` then, only if the callback returned a thenable,
`inFlightRef.current = true … .finally(() => { inFlightRef.current = false })`.
No `abort()` is reachable from `useAutoRefresh`. Callbacks:

| Caller | Returns promise? |
|---|---|
| `DashboardPage.tsx:179` `refreshAll` | YES — `return fetchRecent()` (R3) |
| `AnalyticsPage.tsx:178` `fetchAll` | YES — `return runAll(...)` |
| `FindingsPage.tsx:365` `refetch` | YES — `return run(...)` |
| `QueryPage.tsx:645` `fetchQuery` | returns a cleanup fn (not thenable) — leave-as-is, spec-sanctioned |

### 3.3 Skeleton shape greps (§7.1 / §7.2) — **PASS (zero)**

```
$ grep -rnE '<Skeleton className="h-(24|28|32|40|48|56|60|64|96)[^"]*w-full"' src/components --include='*.tsx' | grep -v 'components/ui.tsx'
EXIT_7_1=1                   # no output
$ grep -rnE 'h-(40|56|64)([^0-9]|$)' src/components --include='*.tsx' | grep 'Skeleton'
EXIT_7_2=1                   # no output
```

Both zero outside `ui.tsx`.

### 3.4 No `AbortError` reaches the UI — **PASS**

`useAbortable` (`lib/utils.ts:61`) converts `AbortError` → `undefined`. Every
`.catch` in the migrated files guards `if ((e as Error).name === "AbortError")
return` **before** any `setError`/`toast`: `AnalyticsPage:203,241`,
`AttckFleetPage:246`, `DashboardPage:160`, `FindingsPage:382`,
`HostInspectorPage:449,480,567,604`, `LogsPage:603`, `RedirectsPage:368,400`,
`ReportPage` (guard inline in each `.catch` `:350,353,356,362,365`),
`UrlInvestigationPage:145`, `QueryPage:666`. Two bare `catch(() => …)`
(`HostInspectorPage:405,512`) are on **signal-free** plain calls and swallow
everything regardless. No user-visible `AbortError` string exists:

```
$ grep -rn 'AbortError' src/components --include='*.tsx' | grep -iE 'toast|setError|title|description|message:'
EXIT=1                       # no output
```

### 3.5 Honest-loading invariants — **PASS**

`loading/index.tsx:55-61` still exports `LoadingIndicator`, `LOADER_DELAY_MS`,
`LOADER_MIN_VISIBLE_MS`. `useDelayedVisible.ts:7,13`: `LOADER_DELAY_MS = 250`,
`LOADER_MIN_VISIBLE_MS = 400`. No synthesised percentage: `progress.ts:43-49`
returns `indeterminate` unless a finite `total > 0` is supplied by the parent;
`progressLabel` prints `"loaded N rows"` when `total` is unknown, never a fraction.
`components/loading/` is untouched by the fix batches.

### 3.6 Motion safety — **PASS**

`index.css:170` `html[data-paused] * … { animation-play-state: paused !important; }`
and `:173` `@media (prefers-reduced-motion: reduce) { … }` both intact (`index.css`
diff is a single line). The skeleton primitives (`Skeleton`, `TableSkeleton`,
`SkeletonShape` in `ui.tsx`) use the pure-CSS `.skeleton-shimmer` — **no
framer-motion** in any of them. (`DataTable.tsx:12` imports framer-motion for the
live-row `Stagger`/`StaggerItem` entry, which is pre-existing and not a skeleton
primitive. `loading/index.tsx` mentions framer-motion only in a doc comment.)

---

## 4. R6 census — §4.3.5 files (no zeros)

```
$ for f in HostInspectorPage AnalyticsPage AttckFleetPage LogsPage RedirectsPage \
           ReportPage DashboardPage FindingsPage PatternTable UrlInvestigationPage; do
    printf '%s: ' $f; grep -cE 'useAbortable|useGeneration' src/components/$f.tsx; done
HostInspectorPage: 5
AnalyticsPage: 5
AttckFleetPage: 3
LogsPage: 3
RedirectsPage: 5
ReportPage: 7
DashboardPage: 3
FindingsPage: 4
PatternTable: 3
UrlInvestigationPage: 5
```

No zero. Each hook is instantiated and used (not merely imported), per the call-site
grep in §3.1 plus `gen.next()/isCurrent` usage in each file. §7.3 breadth count:

```
$ grep -rnE 'AbortController|useAbortable|useGeneration|signal:' src/components src/lib \
    --include='*.tsx' --include='*.ts' | grep -vE 'components/loading|DataTable' | wc -l
55                           # gate ≥ 16
```

---

## 5. NEW regression found by this gate

### P1 — `PatternTable.fetchPatterns` has no `catch`/`finally`: stuck spinner + unhandled rejection

`src/components/PatternTable.tsx:189-209` (current):

```ts
const fetchPatterns = useCallback(async () => {
  setLoading(true)
  setLoadingStartedAt(Date.now())
  setError(null)
  const data = await run((signal) =>
    listPatterns({ … }, { signal }),
  )
  loadedRef.current = true
  setLoading(false)          // :207 — SKIPPED when the await throws
  if (data === undefined) return // aborted — the newer invocation owns loading
  setPatterns(data)
}, [run, debouncedSearch, filterType, page, pageSize, sortBy, sortDir])
```

The diff proves this was introduced by the R6 migration:

```diff
-    try {
-      const data = await listPatterns({ … })
-      setPatterns(data)
-    } catch (e) {
-      setError((e as Error).message)
-    } finally {
-      loadedRef.current = true
-      setLoading(false)
-    }
+    const data = await run((signal) => listPatterns({ … }, { signal }))
+    loadedRef.current = true
+    setLoading(false)
+    if (data === undefined) return
+    setPatterns(data)
```

By inspection this function's body contains **zero** `catch`/`finally` (verified:
`awk 'NR>=189 && NR<=209' … | grep -cE 'finally|catch'` → `0`).

Consequence on a **non-abort** failure (HTTP 500/401, network error):

1. `useAbortable` rethrows non-abort errors → the `await` throws at `:204`.
2. `setLoading(false)` at `:207` is **never reached** → the Patterns skeleton/spinner
   stays up indefinitely (the page never leaves the loading state).
3. There is no `.catch`, so the rejection propagates out of the `async` callback —
   `fetchPatterns()` is invoked **un-awaited** at `:212` (effect), `:249,:267,:293,:314`
   and as the Callout `Retry` onClick `:376` → **unhandled promise rejection**.
4. `setError` is never called → the error Callout (`:375-378`) never renders.

This is the same failure class as the fixed N1 (a loader that only clears on success),
now present on the Patterns surface (in the §4.3.5 list). It is not covered by any of
the six fixes. Every other migrated loader clears its spinner on all paths
(`finally` or a `.catch` that sets `loading:false`) — PatternTable is the sole
exception, alongside ReportPage's noted quirk below.

**Fix shape (not applied — read-only gate):** `try { … } catch (e) { setError((e as
Error).message) } finally { loadedRef.current = true; setLoading(false) }`, i.e.
restore the pre-migration `finally`, or add a `.catch`.

### Observation (not a defect) — ReportPage abort-at-current leaves `loading` true

`ReportPage.tsx:344-367`: each read's `.catch` only clears `loading` when
`sectionGen.isCurrent(g) && name !== "AbortError"`. An `AbortError` that fires while
`g` is still current would leave that section's `loading:true`. In practice
`useAbortable` aborts only when a *new* `run()` is issued under a *new* generation, so
an AbortError always coincides with `!isCurrent` and the newer invocation owns the
flag — so this is not reachable, and on unmount it is moot. Noted for completeness,
not failed.

### Observation — the `history` dialog read is signal-free

`RedirectsPage.openHistory` (`:628-645`) calls `getUrlRedirectHistory(target.id)` with
**no** signal, and the API does accept `opts?: ReqOpts` (`api.ts:1531`). This site is
**not** in the audit §4.3.5 user-keyed list (that lists `:393-394`, the table/graph
effects, both migrated), so it is not an R6 miss — but the history dialog cannot be
cancelled on a fast reopen. Low severity (dialog-scoped).

---

## 6. Unsupported claims / could-not-verify

- **No headless browser.** R1 is proven at the DOM layer (real SSR + html5lib), the
  layer the P0 was raised at; a rendered pixel/screenshot comparison was not done.
- The **populated** `DataTable` branch (`Stagger as="tbody"`, `:1273`) was not SSR'd
  (framer-motion attaches DOM listeners on mount in this environment); its validity
  rests on the `motion[as]` element mapping, which emits a real `<tbody>`/`<tr>` with
  no wrapper. (Unchanged from the prior report.)
- Batch **commit messages** were not inspected; "the fix batches landed" is inferred
  from the working-tree diff.

---

## 7. Final verdict

**SHIP WITH CAVEATS.**

All six named defects are genuinely fixed in the current source, and the headline
outcomes are independently proven: R1's invalid DOM is gone (1 table, 1 tbody, 25
in-grid skeleton rows, 0 foster-parented nodes — contrast case still degrades as
documented); R2/N1's stuck button is fixed on all five paths; R3/R4/R6/N3 each
verified at the source line. Gates are green (build 0, tsc 0, lint 23/0 == baseline),
the tree has no deleted/half-written file, and every safety invariant holds — no
signal on a mutation, poll ticks skip, no `AbortError` in the UI, honest-loading
constants intact, motion rules intact.

The caveat is one **new P1** that this gate found (not present in the prior report):

**Most important remaining issue: `PatternTable.fetchPatterns` drops its `catch` and
`finally` — a non-abort failure leaves the Patterns surface spinning forever and
raises an unhandled promise rejection, with the error Callout unreachable.** It is a
one-hunk fix (restore the `finally`), but as shipped it is a real stuck-loading +
unhandled-rejection defect on a user-keyed page. Secondary: R5 remains an accepted
duplication (now three copies of the density-pad/row-loop markup that comments admit
"MUST move together").
