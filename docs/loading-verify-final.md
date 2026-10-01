# uNetWatch — Loading UX + Request Cancellation Revamp: FINAL Verification

Date: 2026-10-01
Verifier: independent (adversarial). Scope: the three fix batches landed after
`docs/loading-verify-report.md` (the "DO NOT SHIP" round). Read-only — no code
was changed.
Spec: `docs/loading-revamp-spec.md` (`§n`). Audit: `docs/loading-audit.md`.
Baseline: `main` @ `ce3d7ff`; working tree 18 modified files, uncommitted.

**Verdict: SHIP WITH CAVEATS.**
R1 (P0), R3, R6, R7 are FIXED and proven. R2's *error* path is fixed but the fix
introduced a **NEW P1 regression**: a *successful* URL investigation never
clears `loading`, so the Investigate button stays disabled on "Investigating…"
forever. R4's `openHistory` fix is still **inert at render time**. R5 remains an
accepted deviation (now a *three-way* duplication, not two).

---

## 0. Method

- Every gate and every §7 grep was run verbatim from `admin-ui/`; output pasted raw.
- **R1 was reproduced by me**, not taken on trust: the DataTable loading branch
  was server-rendered with the real `DataTable` component (`react-dom/server`,
  esbuild-bundled for Node with a minimal `document`/`window` shim), then the
  exact emitted HTML was re-parsed with **html5lib 1.2** (the HTML5
  tree-construction algorithm browsers implement). The pre-fix shape was also
  fed to html5lib for contrast.
- Every `{ signal }` / `useAbortable` call site was inspected individually and
  cross-checked against `api.ts` to prove none wraps a mutation.
- Race-site census and hook-use census were taken from the current tree.

No browser was driven (no headless Chromium available). R1 is proven by real SSR
output + the HTML5 tree-construction spec; the visual result is inferred.

---

## 1. Gate results (Step 1)

### 1.1 `npm run build` (`tsc -b && vite build`)

```
vite v8.2.0 building client environment for production...
transforming...✓ 2901 modules transformed.
dist/assets/index-ChUyRqNc.css                 55.91 kB │ gzip:  10.24 kB
dist/assets/DataTable-CIUl6hmW.js              61.21 kB │ gzip:  18.65 kB
dist/assets/index-BvOyvnzM.js                 204.09 kB │ gzip:  62.49 kB
dist/assets/echartsTheme-DAvdrFeO.js          443.97 kB │ gzip: 150.52 kB
✓ built in 1.26s
BUILD_EXIT=0
```

**Exit 0.** PASS.

### 1.2 `npm run lint` (`oxlint`)

```
23 diagnostics in 11 files
src/components/loading/index.tsx (5)   src/components/motion.tsx (3)
src/components/SankeyDiagram.tsx (5)   src/components/Sidebar.tsx (2)
src/components/Shadow…                 src/contexts/FilterContext.tsx (2)
src/components/DataTable.tsx (1)       :117:17
src/components/ListActionDropdown.tsx (1)  src/components/loading/LoadingIndicator.tsx (1)
src/components/table/FilterBuilder.tsx (1) src/components/ui.tsx (1) :891:17
src/contexts/ZoneContext.tsx (1)
LINT_EXIT=0
```

**Exit 0, 23 warnings.** Baseline was 23 (verified independently in the prior
round). **0 new warnings.** PASS.

### 1.3 `npx tsc -b --noEmit`

```
TSC_EXIT=0
```

PASS.

### 1.4 `git status --short`

```
 M src/api.ts
 M src/components/AnalyticsPage.tsx
 M src/components/AttckFleetPage.tsx
 M src/components/AttckPanel.tsx
 M src/components/BlacklistPage.tsx
 M src/components/DashboardPage.tsx
 M src/components/DataTable.tsx
 M src/components/FindingsPage.tsx
 M src/components/HostInspectorPage.tsx
 M src/components/LogsPage.tsx
 M src/components/PatternTable.tsx
 M src/components/QueryPage.tsx
 M src/components/RedirectsPage.tsx
 M src/components/ReportPage.tsx
 M src/components/UrlInvestigationPage.tsx
 M src/components/ui.tsx
 M src/index.css
 M src/lib/utils.ts
?? ../brag-output/  ?? ../docs/loading-audit.md  ?? ../docs/loading-revamp-spec.md  ?? ../docs/loading-verify-report.md
GIT_EXIT=0
```

No deleted (` D`), no rename, no half-written file. `components/loading/` is
**untouched** (`git status --short -- admin-ui/src/components/loading/` → empty).
PASS.

---

## 2. Prior defects R1..R7 — status table

| # | Sev | Defect | Status | Evidence |
|---|---|---|---|---|
| R1 | P0 | `TableSkeleton` (div/table wrapper) rendered as a direct child of `<table>` → invalid DOM, foster-parenting | **FIXED** | `DataTable.tsx:1239-1247` emits a real `<tbody>` with `SkeletonRows` (`:1751`), which emits only `<tr>/<td>`. SSR + html5lib proof below. |
| R2 | P1 | `UrlInvestigationPage.investigate` had no error handling → unhandled rejection + stuck spinner | **PARTIALLY FIXED — NEW BUG** | `catch` now sets `setError` + `setResult(null)` + `setLoading(false)` (`:124-131`); empty path clears loading (`:107`). **But the success path (`:123`) never clears `loading`** — see §3. |
| R3 | P2 | `DashboardPage.refreshAll` returned `void` → poll skip inert | **FIXED** | `DashboardPage.tsx:179-182` now `return fetchRecent()`; `useAutoRefresh` thenable test engages the flag. |
| R4 | P2 | `RedirectsPage.openHistory` never-blank fix inert (render ignores retained `history`) | **STILL-OPEN** (the `openHistory` line landed; the render still ignores it) | `:634` retains history; render at `:950` is `{historyLoading ? <SkeletonShape/> : …}` and never reads `history` while loading. |
| R5 | P2 | `DENSITY_PAD` duplicated instead of shared | **ACCEPTED** (worse: now triplicated) | `DataTable.tsx:375`, `ui.tsx:455`, plus `SkeletonRows` row loop (`DataTable.tsx:1751`) is a declared "byte-for-byte mirror" of `TableSkeleton`'s loop. |
| R6 | P1 | 10 of 15 §4.3.5 race sites unmigrated | **FIXED** | All 10 files now contain live `useAbortable`/`useGeneration` with real call sites (census §4). |
| R7 | P2 | Never-blank rule not applied on failed refetch (Logs/Redirects/Dashboard/HostInspector) | **FIXED** | Logs `isFirstLoad` gate; Redirects `isFirstLoad` gate (`:371`,`:402`); Dashboard `isFirstLoad` gate (`:18`); HostInspector toggle `if (!report) setReport(null)` (`:445`). |

---

## 3. R1 reproduction (the P0) — PROVEN FIXED

### 3.1 Method

`DataTable` was SSR'd with the real component, real `ToastProvider`, and a
minimal `document.visibilityState` shim (for `usePageVisible`):

```
loading={true}, data={[]}, columns=[Name (w-40), Count (no width)]
renderToStaticMarkup(<ToastProvider><DataTable …/></ToastProvider>)
```

### 3.2 Markup from `</thead>` onward (as emitted)

```html
</thead><tbody>
  <tr class="border-b border-border last:border-b-0">
    <td class="px-4 py-3"><div class="relative overflow-hidden rounded-md border border-border bg-muted h-4 w-40" aria-hidden="true"><div class="skeleton-shimmer absolute inset-0"></div></div></td>
    <td class="px-4 py-3"><div class="relative overflow-hidden rounded-md border border-border bg-muted h-4 w-24" aria-hidden="true"><div class="skeleton-shimmer absolute inset-0"></div></div></td>
  </tr>
  …24 more identical <tr>…
</tbody>
```

There is **no `<div>` and no nested `<table>` between `</thead>` and the real
`<tbody>`**. The real `<table aria-label="Findings">` at `:1152` is followed
directly by `</thead>` (`:1227`) then `<tbody>` (`:1240`).

### 3.3 Browser-equivalent parse (html5lib 1.2)

```
TABLES WITH aria-label=Findings: 1
real <table> direct children:   thead {}, tbody {}
Nested <table> inside real table: 0
real <thead> children: 1 <tr>
real <tbody> rows: 25 <tr>
Bad (foster-parent-triggering) children directly inside real <table>: []
body direct children tags: ['div','div']      # toolbar wrapper + page wrapper — expected
```

**No foster-parenting. The DOM is valid.** The `tbody` holds all 25 skeleton
rows inline in the real grid.

### 3.4 Contrast — the OLD shape (same html5lib)

```
   div  {class: 'overflow-x-auto'}          ← foster-parented OUT, becomes a table SIBLING
   table {aria-label: 'Findings'}
     thead > tr > th, th                      ← real header, left bodiless
   table {class: 'w-full'}                    ← skeleton table detached as a second table
     tbody > tr > td, td
```

This is the exact defect the P0 report described, and it no longer occurs.

### 3.5 Real-row branch also valid

The populated branch renders `<Stagger as="tbody">` (`DataTable.tsx:1273`) with
`<StaggerItem as="tr">` (`:1278`); `motion.tsx:104` does `const Tag = motion[as]`
→ real `motion.tbody` / `motion.tr`, no wrapper div. (Full SSR of this branch
was not possible headlessly — framer-motion attaches resize listeners on mount —
but the element mapping is unambiguous.)

**R1: FIXED.**

---

## 4. Race-site census (R6) — every listed file guarded

```
$ for f in HostInspectorPage AnalyticsPage AttckFleetPage LogsPage RedirectsPage \
           ReportPage DashboardPage FindingsPage PatternTable UrlInvestigationPage; do
    printf "%-24s %s\n" "$f" "$(grep -cE 'useAbortable|useGeneration' src/components/$f.tsx)"; done
HostInspectorPage        5
AnalyticsPage            5
AttckFleetPage           3
LogsPage                 3
RedirectsPage            5
ReportPage               7
DashboardPage            3
FindingsPage             4
PatternTable             3
UrlInvestigationPage     4
```

**No zero. All ten files carry the hook.** Beyond the import count, I verified
each hook is *used* (claimed generation + `isCurrent` checks), not dead:

```
AnalyticsPage   allGen.next×1 / allGen.isCurrent×3 ; rawGen ×1/×3
AttckFleetPage  fleetGen.next×1 / isCurrent×3
LogsPage        gen.next×1 / isCurrent×3
RedirectsPage   tableGen ×1/×3 ; graphGen ×1/×3
ReportPage      sectionGen.next×1 / isCurrent×10
DashboardPage   recentGen.next×1 / isCurrent×3
FindingsPage    gen.next×1 / isCurrent×3
HostInspector   run/runDomainMatch/runRaw + gen next/isCurrent on every setState (10 sites)
PatternTable    run ×1 on listPatterns
UrlInvestigation runBreakdown ×1 on getUrlBreakdown
```

**R6: FIXED.** (Prior round: only 3 of 13 pages.)

---

## 5. §7 acceptance criteria — re-run

| # | Criterion | Result | Verdict |
|---|---|---|---|
| 7.1 | No wrong-shape `h-N w-full` block outside `ui.tsx` | **0 matches**, `EXIT_7_1=1` | PASS |
| 7.2 | No raw tall block for a multi-panel surface | **0 matches**, `EXIT_7_2=1` | PASS |
| 7.3 | Every user-keyed request guarded | `wc -l` = **54** (was 21, gate ≥16) | PASS |
| 7.4 | NO write path accepts a signal | `EXIT_7_4=1`; `ReqOpts` exists `:482`; `opts?: ReqOpts` count 38; independent parse → **mutation-with-ReqOpts = NONE** | PASS |
| 7.5 | `useAutoRefresh` cannot overlap | `inFlightRef` decl `:115`, skip `:129`, set `:132`, reset `:134` | PASS |
| 7.6 | No `let cancelled`-only guard on a user-keyed request | 5 matches remain, **all in files that also carry guards** | PASS |
| 7.7 | Build / lint / typecheck green | 0 / 0 / 0 | PASS |
| 7.8 | Honest-loading invariants preserved | `loading/` untouched; synth-`%` grep `EXIT_7_8=1` | PASS |
| 7.9 | Motion safety preserved | `framer-motion` in `ui.tsx` → `EXIT_7_9=1`; `index.css` 1 line changed | PASS |

### 5.1 Raw §7.6 (remaining `let cancelled`)

```
$ grep -rn 'let cancelled' src/components --include='*.tsx' | grep -vE 'QueryPage'
src/components/UrlInvestigationPage.tsx:85   (jail-index effect; file has 4 guards)
src/components/ReportPage.tsx:327            (file has 7 guards)
src/components/HostInspectorPage.tsx:391     (file has 5 guards)
src/components/DashboardPage.tsx:98          (blacklist-count; file has 3 guards)
src/components/DashboardPage.tsx:115         (tracked-count; file has 3 guards)
```

Each match is in a file that also contains `useAbortable`/`useGeneration` —
§7.6's rule is satisfied. (These particular sites are non-user-keyed decoration.)

### 5.2 §7.1 / §7.2 skeleton shapes still intact after the R6 work

Both greps still return **zero outside `ui.tsx`** — the R1/R6 batches did not
clobber the earlier skeleton work. Confirmed above.

---

## 6. The most dangerous check — cancellation on a WRITE

Every `{ signal }` / `useAbortable` call site, inspected individually:

```
LogsPage:586          → listLogs                      (GET)
RedirectsPage:351     → listTrackedUrls               (GET)
RedirectsPage:392     → getRedirectGraph              (GET)
AnalyticsPage:182-188 → getAnalyticsSummary/Bandwidth/Enforcements/TopDomains/TopClients (GET ×5, one signal)
AnalyticsPage:226     → getFindings                   (GET)
AttckFleetPage:239    → getFleetAttckMapping          (GET)
ReportPage:348/351/354/360/363 → getHostProfile/getClientReport/getHostEnrichment/getUrlBreakdown/getUrlEnrichment (GET ×5)
FindingsPage:367      → getFindings                   (GET)
DashboardPage:152     → getFindings                   (GET)
PatternTable:195      → listPatterns                  (GET)
UrlInvestigation:117  → getUrlBreakdown               (GET)
HostInspector:254/299/435/464/498/517/543/552/582 → getFindings / runQuery / getClientReport / getHostProfile / fetchHostSections / getClientReportFindings (all GET)
QueryPage:659         → runQuery                      (POST *read* — pre-existing, spec-sanctioned)
```

Verification that none is a mutation:

```
$ grep -rnE '(delete|clear|add|create|update|put|import|restore|sync|retry|checkRedirects|trigger|bulk)[A-Za-z]*\(.*signal' src/components --include='*.tsx'
EXIT=1                    # no output
$ grep -rnoE 'run[A-Za-z]*\(\(signal\) => [a-zA-Z_]+' src/components | grep -vE 'get[A-Z]|list[A-Z]|fetch[A-Z]|runQuery'
                          # no output — every wrapped call is a reader
```

Mutation call sites (`bulkImport`, `deleteTrackedUrl`, `clearLogs`,
`bulkDeleteLogs`, `syncBlacklistUpstream`, `retryWebhook`, `importBackup`,
`addTrackedUrl`, `checkRedirectsBackground`, …) all pass **no** signal.

`runQuery` (`api.ts:292-312`) is a `request()` GET with query params — no
`method:` — so it is a read, matching §4.5. `checkRedirectsBackground`,
`triggerManualRun`, `login`, backup import/export, blacklist/jaillist
add/delete/clear/sync are signal-free.

**No cancellation was added to anything on the do-not-touch list.** The §5
contract holds.

---

## 7. Poll ticks skip, not abort

`useAutoRefresh` (`lib/utils.ts:96-142`) sets `inFlightRef.current = true` only
when the callback returns a thenable, resetting in `.finally`. Callbacks:

| Caller | Returns a promise? | Skip engages |
|---|---|---|
| `DashboardPage:183` (`refreshAll`) | `return fetchRecent()` `:181` | **YES** (was NO — R3) |
| `AnalyticsPage:219` (`fetchAll`) | `return runAll(...)` | YES |
| `FindingsPage:405` (`refetch`) | `return run(...)` | YES |
| `QueryPage:694` (`fetchQuery`) | cleanup fn (not thenable) — leave-as-is | n/a |

No `abort()` is reachable from `useAutoRefresh`; the whole mechanism is a skip
flag. Confirmed.

---

## 8. `AbortError` never surfaces

`useAbortable` swallows `AbortError` → `undefined` (`utils.ts:61`). Every
`.catch` in the migrated files guards with `if ((e as Error).name ===
"AbortError") return` **before** any `setError`/`toast`:

`LogsPage:603`, `RedirectsPage:368/400`, `QueryPage:666`, `AnalyticsPage:203/241`,
`AttckFleetPage:246`, `FindingsPage:382`, `HostInspectorPage:443/471/558/595`,
`DashboardPage:160`, and `ReportPage:350-365` (guard inline in each `.catch`).

Two bare `catch(() => …)` (`HostInspectorPage:399`, `:503`) are on **signal-free**
plain calls (host-profile/poll), so they cannot receive an `AbortError` from a
cancelled reader; they swallow everything regardless.

**No user-visible `AbortError`.** PASS.

---

## 9. NEW regression introduced by the fix batches (P1)

### N1 — `UrlInvestigationPage.investigate` never clears `loading` on SUCCESS

`admin-ui/src/components/UrlInvestigationPage.tsx:101-131`:

```ts
const res = await runBreakdown((signal) =>
  getUrlBreakdown(trimmed, { limit: 100, source: uSource }, { signal }),
)
if (res === undefined) return   // aborted
setResult(res)                  // <-- success: loading stays TRUE
} catch (e) {
  setError((e as Error).message)
  setResult(null)
  setLoading(false)             // only the error path clears it
}
```

The empty-input path clears it (`:107`); the **success path does not**. The
baseline had `finally { setLoading(false) }` on every path:

```
$ git diff -- admin-ui/src/components/UrlInvestigationPage.tsx  | grep -E 'finally|setLoading'
+      setLoading(false)          # empty input
+      setLoading(false)          # catch
-    } finally {
       setLoading(false)          # REMOVED from the success path
```

Observable effect after **every successful investigation**:

- `:280-281` `<Button disabled={loading}>{loading ? <LoadingIcon/> : …}` renders
  **"Investigating…" with a spinner, permanently disabled**.
- `:299` the content branch still renders (because `result` is set), so the
  result is visible — but the form is dead until a manual reload or an error.
- `:392` the empty-state branch is correctly suppressed.

This is the *common* path — worse than the pre-fix behavior for normal use. The
error case (the reported R2) is fixed; the success case regressed. **This is the
single most important remaining issue.**

Every other migrated loader clears its spinner in `.finally(...)` on all paths
(`LogsPage:612`, `RedirectsPage:377/405`, `DashboardPage:167`, `AttckFleetPage:250`,
`AnalyticsPage:208/246`, `HostInspectorPage:448/474/604`). `UrlInvestigationPage`
is the only one that dropped `finally`.

### N2 — R4 render branch (carried over, not new)

`RedirectsPage:950` still short-circuits to `SkeletonShape` whenever
`historyLoading` is true, ignoring the retained `history`. The `:634` fix is
correct but has no visible effect on a same-target reopen. (Was R4 in the prior
round; unchanged by the fixes.)

### N3 — `HostInspectorPage` never-blank toggle uses a stale-closure guard

`HostInspectorPage:445` `if (!report) setReport(null)` reads `report` from the
effect's render closure, not a ref. In practice the effect re-runs on `hSource`
so `report` is fresh, but it is a weaker guard than the `*LoadedRef` pattern used
by Logs/Redirects/Dashboard. Low risk; noted, not failed.

No other new regressions were found. Sorting/filtering/selection/export/
persistence/sticky/context-menu behavior in `DataTable` is untouched (diff is
the skeleton branch + the `SkeletonRows` helper + a doc comment).

---

## 10. Final verdict

**SHIP WITH CAVEATS.**

The revamp's two headline goals are now met and independently proven:

- **No shape mismatch on first load.** R1 is fixed — the DataTable skeleton is a
  valid in-table `<tbody>` of `<tr>`s, proven by real SSR output parsed with
  html5lib (0 nested tables, 0 foster-parented nodes). The P0 is gone.
- **Cancellation where it matters.** R6 is fixed — all ten previously-unguarded
  files carry and *use* `useAbortable`/`useGeneration`. R3 (poll skip), R7
  (never-blank on failed refetch), §7.4 write-safety, and the "no signal on a
  mutation" invariant all hold under independent inspection.

Gates are green with **0 new lint warnings** (baseline 23), tsc clean, no stray
files, `components/loading/` untouched.

The caveats:

1. **NEW P1 (N1)** — `UrlInvestigationPage` leaves the Investigate button
   disabled/"Investigating…" forever after a *successful* read (the `finally` was
   removed and only the error path clears `loading`). One-line fix; must land
   before this is genuinely ship-clean.
2. **R4 still-open** — the `RedirectsPage` history "never-blank" claim is
   cosmetic; the retained data is still never rendered during a same-target
   reopen.
3. **R5 accepted, now triplicated** — three copies of the density-pad / row-loop
   markup (DataTable `DENSITY_PAD`, ui `DENSITY_PAD`, `SkeletonRows`) that the
   comments admit "MUST move together."

**Single most important remaining issue: N1** — it makes the most common user
action (a successful URL investigation) leave a dead, spinning button, a worse
outcome than the pre-revamp baseline on that surface.

### Claims I could not fully verify

- The visual result of the R1 fix (screen-captured layout) — no headless browser
  available. Proven at the DOM layer only (SSR + html5lib), which is the layer
  the P0 was raised at.
- The populated DataTable branch could not be SSR'd headlessly (framer-motion
  attaches DOM listeners); its validity is established by the `motion[as]`
  element mapping in `motion.tsx:104`.
- Batch commit messages were not provided; "three fix batches landed" is inferred
  from the diff (R1 `SkeletonRows`, R3 `return`, R6 hooks across 10 files).
