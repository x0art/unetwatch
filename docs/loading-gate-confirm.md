# Loading gate — final confirmation

Short read-only confirmation gate run in `admin-ui` after the P1 fix to
`PatternTable.fetchPatterns`. All writers stopped.

Date: 2026-10-01 · scope: build/lint/tsc/git + the PatternTable fix + the
"silently-dropped error handling" bug-class sweep + safety invariants.

---

## 1. Gates

```
$ npm run build
✓ built in 1.82s
BUILD_EXIT=0
```

```
$ npm run lint
src/contexts/ZoneContext.tsx:25:17: warning react(only-export-components) ...
… 23 warnings total, all react(only-export-components) …
LINT_EXIT=0
```
23 warnings, all the pre-existing `only-export-components` class; **0 new**.

```
$ npx tsc -b --noEmit
TSC_EXIT=0
```

```
$ git -C /home/x0art/Project/uNetWatch status --short
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
?? docs/loading-release-gate.md
?? docs/loading-revamp-spec.md
?? docs/loading-verify-final.md
?? docs/loading-verify-report.md
```
18 modified files (` M`), no ` D`/`R` deletions. Untracked files are docs +
`brag-output/`. **Matches expectation: build/tsc 0, lint 23/0-new, 18 modified,
no deletions.**

---

## 2. PatternTable fix — verdict: CORRECT

`PatternTable.tsx:193-240`, deps `[run, gen, debouncedSearch, filterType, page,
pageSize, sortBy, sortDir]` (`gen` present → line 240).

| Requirement | Evidence | OK |
|---|---|---|
| Generation claimed | `const g = gen.next()` (195) | ✅ |
| Has `catch` | `} catch (e) {` (226) | ✅ |
| success → clears loading | `setLoading(false)` (225) | ✅ |
| aborted-current → clears loading | `if (data === undefined) { setLoading(false); return }` (217-219) | ✅ |
| aborted-superseded → leaves to newer | `if (!gen.isCurrent(g)) return` (214) | ✅ |
| non-abort error → error + clears loading | `setError(...); setLoading(false)` (237-238) | ✅ |
| `AbortError` cannot reach `setError` | rethrown by hook, caught, `name === "AbortError"` short-circuits at 230 **before** 237 | ✅ |
| `gen` in deps | line 240 | ✅ |
| Error UI reads `error` state | `{error && (<Callout action={… onClick={fetchPatterns}>Retry…}>{error}</Callout>)}` (406-410) | ✅ |

Every terminal path either clears `loading` or defers to a strictly newer
invocation (`!gen.isCurrent(g)` — a *newer* call has called `gen.next()`). No
path leaves `loading` stuck on a failure. `useAbortable` (`utils.ts:56-64`)
swallows `AbortError` → `undefined` and rethrows everything else, so the
`catch` sees only non-abort errors or a genuine rethrow. **Fix confirmed.**

---

## 3. Bug-class sweep — loaders using `useAbortable`/`useGeneration`

All ten files use the `.then/.catch/.finally` form (grep target `.catch`), so
`handleJailedIndex`-style best-effort fetches are excluded — every row below is
the file's main list/detail loader.

| File | Has catch? | `loading`/`busy` cleared on non-abort failure? | Notes |
|---|---|---|---|
| HostInspectorPage | ✅ .catch ×5 | ✅ `.finally` gated on `isCurrent(g)` | `runDomainMatch` .catch only sets null (no spinner) |
| AnalyticsPage | ✅ .catch ×2 | ✅ `.finally` gated on `isCurrent(g)` for both runAll/runRaw | |
| AttckFleetPage | ✅ | ✅ `.finally` → `if (fleetGen.isCurrent(g)) setLoading(false)` | own loader |
| LogsPage | ✅ | ✅ `.finally` → `if (!gen.isCurrent(g)) return; … setLoading(false)` | |
| RedirectsPage | ✅ table + graph | ✅ both `.finally` gated on `isCurrent(g)` | `loadHistory` is a bare promise w/ own try/catch |
| **ReportPage** | ✅ all 4 sections | ⚠️ **only on non-abort error; on abort-superseded the spinner sticks** | **HEADLINE below** |
| DashboardPage | ✅ | ✅ `.finally` → `if (recentGen.isCurrent(g)) setRecentLoading(false)` | blacklist/tracked/counts have their own .catch |
| FindingsPage | ✅ | ✅ `.finally` → `if (!gen.isCurrent(g)) return; setLoading(false); setRefreshing(false)` | |
| PatternTable | ✅ | ✅ (see §2) | the fixed file |
| UrlInvestigationPage | ✅ (try/catch/finally-style) | ✅ abort-current clears (135), non-abort clears (154) | |

**No loader rethrows without a catch** — every non-abort failure clears its
spinner. One residual defect of the class was found (supersession, not
failure):

### HEADLINE — ReportPage section skeleton can stick on supersession

`ReportPage.tsx:334-367`. Four sections (`profile`, `report`, `hostEnrich`,
`breakdown`, `urlEnrich`) are loaded in an effect keyed on `[kind, value]`.
Each is initialised `{loading: true}` and each `.then` is guarded with
`data !== undefined && sectionGen.isCurrent(g)`, but there is **no abort-while-
current branch and no unconditional clear**:

```ts
void runProfile((signal) => getHostProfile(value, "24h", { signal }))
  .then((data) => { if (data !== undefined && sectionGen.isCurrent(g)) setProfile({ data, loading: false, error: null }) })
  .catch((e: unknown) => { if (sectionGen.isCurrent(g) && (e as Error).name !== "AbortError") setProfile({ data: null, loading: false, error: ... }) })
```

When a refetch to a new entity supersedes an in-flight one, the old invocation
aborts → `data === undefined` → `.then` skipped; `AbortError` → `.catch` skipped
**and `sectionGen.isCurrent(g)` is false anyway**. The **new** invocation had
already reset the section to `{ loading: true }` (line 345/358) and only its own
`.then`/`.catch` clears it — so the aborted `{loading:true}` is transient, not
stuck, *provided the new read succeeds or fails*. On a **user switch during an
in-range refetch that is then aborted**, the superseding read owns clearing and
does so; the defect surfaces only if the *newest* read aborts while still
current (unmount-ish / a later abort with no newer generation), leaving the
skeleton `loading:true` forever with “Section unavailable: no profile” never
shown.

Severity: **low** — requires the newest read to abort with no successor, and
the UI degrades to a permanent skeleton rather than a spinner+Retry (ReportPage
shows per-section error text, not the Callout retry pattern). It is the same
class as the P1 (terminal path that does not own `loading`), caught by the same
check that fixed PatternTable. **Not a P1**; recommend a follow-up adding an
`if (sectionGen.isCurrent(g)) set*({ …, loading: false })` abort branch,
mirroring `PatternTable.tsx:217`.

---

## 4. Safety invariants

- **No `{ signal }` on a write.** Grep for `{ signal }` co-occurring with
  `delete|update|bulkImport|addTracked|addClientIp|clear|restore|create|post|
  put|patch` → **0 matches**. Every `{ signal }` site is a GET-style read
  (`getFindings`, `getClientReport`, `getHostProfile`, `listPatterns`,
  `listLogs`, `listTrackedUrls`, `getRedirectGraph`, analytics `get*`,
  enrichments, breakdown). ✅
- **Spec §7 skeleton greps outside `ui.tsx` → zero.** The only `useEffect(() =>
  {` inside `ui.tsx` (line 860) is the timer-cleanup effect, not a fetch.
  `let cancelled` remains in 7 files but each is either the documented
  best-effort mount-once fetch (`HostInspectorPage:397` jailedIndex,
  `UrlInvestigationPage:85` jailedIndex, `ReportPage:327` /health probe,
  `DashboardPage:98/115` blacklist/tracked counts, `QueryPage:577/649`) or the
  one flagged in §3 — none is a new dropped-error-handling fetch. ✅

---

## Final verdict: **SHIP**

- Gates green: build 0, tsc 0, lint 23 warnings / 0 new, 18 modified, no deletions.
- The P1 PatternTable fix is correct and complete (generation, catch, every
  terminal path, `AbortError` isolation, `gen` in deps, error UI reads state).
- Sweep: all ten files' loaders have a `catch`; every non-abort failure clears
  `loading`/`busy`. **No new P1.**
- **Remaining issue (non-blocking, low):** `ReportPage.tsx:334-367` section
  spinner can stick if the newest read aborts with no successor — same class,
  adjacent instance. File a follow-up; does not block ship.
