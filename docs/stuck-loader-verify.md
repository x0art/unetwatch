# Stuck-loader fix — independent verification

Date: 2026-10-02
Scope: `/home/x0art/Project/uNetWatch` (React 19 admin UI)
Method: READ-ONLY. No file was modified except this report.
HEAD: `1648eff fix: stop the CPU-flooding render loops and bound two unbounded caches`

**Verdict: CLEAN.**

The final state is exactly as claimed: `utils.ts` untouched, ten page components
byte-identical to HEAD, and precisely one file modified (`RedirectsPage.tsx`, +12/-1).
Both rejected attempts leave no residue. The single change is correct, minimal, and
introduces no regression.

---

## Step 1 — Gates

```
cd /home/x0art/Project/uNetWatch/admin-ui && npm run build
```
```
> tsc -b && vite build
vite v8.2.0 building client environment for production...
transforming...✓ 2901 modules transformed.
...
dist/assets/index-B9VJO8p6.js                 205.08 kB │ gzip:  62.75 kB
✓ built in 1.57s
BUILD_EXIT=0
```

```
cd /home/x0art/Project/uNetWatch/admin-ui && npm run lint
```
```
> oxlint
23 diagnostics in 11 files
...
LINT_EXIT=0
```
**23 warnings, 0 errors** — matches expectation exactly. Every diagnostic is
`react(only-export-components)` (a fast-refresh style warning), none related to
loading/abort logic.

```
cd /home/x0art/Project/uNetWatch/admin-ui && npx tsc -b --noEmit
```
```
TSC_EXIT=0
```

```
git -C /home/x0art/Project/uNetWatch status --short
```
```
 M admin-ui/src/components/RedirectsPage.tsx
?? brag-output/
?? unetwatch.db.instance-lock
STATUS_EXIT=0
```

Modified inside `admin-ui/src/components/`: **only `RedirectsPage.tsx`** — as expected.

The two untracked entries are **outside `admin-ui/`** and unrelated to this change:
- `?? brag-output/` — pre-existing untracked directory at repo root.
- `?? unetwatch.db.instance-lock` — SQLite instance lock file at repo root.

No untracked probe/repro files anywhere under `admin-ui/`.

---

## Step 2 — Footprint proof

### Full diff stat

```
git -C /home/x0art/Project/uNetWatch diff --stat
```
```
 admin-ui/src/components/RedirectsPage.tsx | 13 ++++++++++++-
 1 file changed, 12 insertions(+), 1 deletion(-)
```

Exactly one modified file, in the whole repository.

### `utils.ts` must be empty

```
git -C /home/x0art/Project/uNetWatch diff -- admin-ui/src/lib/utils.ts
```
```
(no output)
EXIT=0
```
**Empty. Confirmed identical to HEAD.**

### Per-file equality to HEAD (`git diff --quiet`; 0 = identical)

```
for f in PatternTable.tsx FindingsPage.tsx LogsPage.tsx AnalyticsPage.tsx \
         AttckFleetPage.tsx DashboardPage.tsx HostInspectorPage.tsx \
         UrlInvestigationPage.tsx QueryPage.tsx ReportPage.tsx; do
  git -C /home/x0art/Project/uNetWatch diff --quiet -- "admin-ui/src/components/$f"; echo "$f -> $?"
done
```

| File | exit | status |
|------|------|--------|
| PatternTable.tsx | 0 | identical to HEAD |
| FindingsPage.tsx | 0 | identical to HEAD |
| LogsPage.tsx | 0 | identical to HEAD |
| AnalyticsPage.tsx | 0 | identical to HEAD |
| AttckFleetPage.tsx | 0 | identical to HEAD |
| DashboardPage.tsx | 0 | identical to HEAD |
| HostInspectorPage.tsx | 0 | identical to HEAD |
| UrlInvestigationPage.tsx | 0 | identical to HEAD |
| QueryPage.tsx | 0 | identical to HEAD |
| ReportPage.tsx | 0 | identical to HEAD |

**All ten exit 0 — none is modified.**

### No leftover artifacts

```
find admin-ui -path ./node_modules -prune -o -type f \
  \( -name 'repro-*.mjs' -o -name 'repro.html' -o -name 'repro-entry.tsx' \
     -o -name '*.probe.*' -o -name '_ssr_*' \) -print
```
```
---done---
```
No matches. No `repro-*.mjs`, no `repro.html`, no `repro-entry.tsx`, no `*.probe.*`,
no `_ssr_*`.

---

## Step 3 — `useAbortable` is the clean original

`admin-ui/src/lib/utils.ts:49-65`:

```ts
export function useAbortable(): <T>(fn: (signal: AbortSignal) => Promise<T>) => Promise<T | undefined> {
  const abortRef = useRef<AbortController | null>(null)

  useEffect(() => () => {
    abortRef.current?.abort()
  }, [])

  return useCallback(<T,>(fn: (signal: AbortSignal) => Promise<T>): Promise<T | undefined> => {
    abortRef.current?.abort()
    const controller = new AbortController()
    abortRef.current = controller
    return fn(controller.signal).catch((e: unknown) => {
      if ((e as Error).name === "AbortError") return undefined
      throw e
    })
  }, [])
}
```

Checks:

- **Exactly-once invocation.** `grep -n "fn(" src/lib/utils.ts` returns a single
  line — line 60, `return fn(controller.signal).catch(...)`. `grep -c "fn("` = **1**.
  The `.catch(...)` is a handler chained onto the promise returned by the *single*
  `fn(...)` call; it is not a second call and it invokes no second `fn`. **No request
  doubling.**
- **Signature is the original single-parameter form.** The returned callable is
  `<T>(fn: (signal: AbortSignal) => Promise<T>) => Promise<T | undefined>`. There is
  **no** second `superseded` callback parameter.
- **`AbortError` swallowed to `undefined`; other errors rethrow.** Lines 60-63:
  `if ((e as Error).name === "AbortError") return undefined; throw e`.
- **No latch machinery.** No `isSupersededRef`, no `callIdRef`, no generation counter
  inside this hook — the whole body is 16 lines and contains none of it.
  (`grep -rni "isSupersededRef\|callIdRef\|latch" src/` → no matches.)

---

## Step 4 — `RedirectsPage.openHistory` fix review

### Diff (the whole change, verbatim)

```
git -C /home/x0art/Project/uNetWatch diff -- admin-ui/src/components/RedirectsPage.tsx
```
```diff
@@ -387,6 +387,12 @@ export function RedirectsPage({ active = true }: { active?: boolean } = {}) {
+
+  // Own abort point for the history dialog: reopening or hitting Retry
+  // supersedes the previous read instead of letting two overlap and a stale
+  // one win. Independence from `runTable`/`runGraph` keeps a dialog read from
+  // aborting (or being aborted by) either list read.
+  const runHistory = useAbortable()
@@ -653,8 +659,13 @@ export function RedirectsPage({ active = true }: { active?: boolean } = {}) {
-      setHistory(await getUrlRedirectHistory(target.id))
+      // A new open/Retry aborts the previous history read; AbortError is
+      // swallowed by useAbortable to `undefined`, so a superseded open paints
+      // nothing and cannot overwrite the newer one's edges.
+      const data = await runHistory((signal) => getUrlRedirectHistory(target.id, { signal }))
+      if (data !== undefined) setHistory(data)
```

12 insertions, 1 deletion. One new hook call, one rewritten await. Nothing else.

### Runtime shape (`openHistory`, lines 653-674)

```ts
const openHistory = async (target: TrackedUrl) => {
  setHistoryTarget(target)
  if (historyTarget?.id !== target.id) setHistory(null)
  setHistoryLoading(true)
  setHistoryError(null)
  try {
    const data = await runHistory((signal) => getUrlRedirectHistory(target.id, { signal }))
    if (data !== undefined) setHistory(data)
  } catch (e) {
    if ((e as Error).name === "AbortError") return
    setHistoryError((e as Error).message)
    toast({ title: "Failed to load history", description: (e as Error).message, variant: "error" })
  } finally {
    setHistoryLoading(false)
  }
}
```

### Does `getUrlRedirectHistory` accept an `opts` argument?

**Yes.** `admin-ui/src/api.ts:1444`:

```ts
export async function getUrlRedirectHistory(id: number, opts?: ReqOpts): Promise<UrlRedirectHistory> {
  return request(`/redirects/${id}/history`, opts)
}
```
with `ReqOpts = { signal?: AbortSignal }` (api.ts:462). The signal is passed through
to `request()` and thus to `fetch`. **The signal is NOT dropped — the fix is
effective.**

Checks:

- **Superseded read paints nothing.** `if (data !== undefined) setHistory(data)` —
  an aborted read resolves to `undefined` and `setHistory` is skipped.
- **`AbortError` cannot surface as a user-visible error.** It is swallowed inside
  `useAbortable` (resolves `undefined`, never rejects). The `catch` here cannot even
  see it; the extra `if ((e).name === "AbortError") return` is belt-and-braces and
  unreachable-by-design, which is harmless.
- **`historyLoading` cleared on every terminal path.** The `finally` runs on success,
  on abort (resolves `undefined` → normal return → `finally`), and on error. All three
  clear the cue.
- **Minimal.** As quoted above: one hook, one rewritten await, no other edits.

### Does this reintroduce the cue-hiding regression?

**No — and the reasoning is sound.** The rejected shape was an *unconditional* clear
in a `finally` that runs when a read is *superseded*: read A's `finally` fired after
read B armed its own flag, hiding B's cue for B's whole duration. That is a
generation-ordered-list problem, where many reads of the same logical surface overlap.

`openHistory` is a **single, non-overlapping dialog read**: one `useAbortable` call
site, and the hook aborts the previous call before starting a new one. When the
operator reopens (or hits Retry), the prior read is aborted; its `finally` clears
`historyLoading`, and the *new* `openHistory` invocation — which runs synchronously
after, in the same user action — sets `historyLoading(true)` again at its line 659.
Order is: abort-old → old `finally` clears → new call sets loading true. The clear
therefore cannot mask the new cue, because there is no concurrent newer read hanging
off an already-armed flag; the clear belongs to the read that genuinely ended.

Note this correctness is *incidental to ordering within one event*, and it is stable
because `setHistoryLoading(true)` precedes the first `await` and the abort of the old
read happens inside `runHistory` synchronously before the new fetch is issued. The
arrangement does not depend on React batching subtleties. **I agree the clear is safe
here.**

Cross-check: the same reasoning is why `RedirectsPage`'s *list* loaders (`loadTable`,
`loadGraph`) do **not** clear unguarded — they use `if (tableCurrent(g)) setLoading(false)`
and `if (graphCurrent(g)) setGraphLoading(false)`, because they *are* generation-ordered
and overlap. The fix correctly uses the plain-`finally` pattern only for the
non-overlapping dialog read.

---

## Step 5 — Adversarial residue sweep

### `superseded` as a parameter / predicate

```
grep -rn "superseded" src/
```
15 matches across 8 files — **all comments**, none a parameter or callable:

| file:line | context |
|-----------|---------|
| DashboardPage.tsx:151 | comment |
| FindingsPage.tsx:322, 370 | comments |
| HostInspectorPage.tsx:599 | comment |
| PatternTable.tsx:164, 225 | comments |
| QueryPage.tsx:642 | comment |
| RedirectsPage.tsx:268, 663 | comments |
| UrlInvestigationPage.tsx:111, 114, 125, 144 | comments |
| utils.ts:36, 76 | comments |

No `superseded` appears in any function signature or as a called identifier.

### `isSupersededRef`

```
grep -rn "isSupersededRef" src/
```
**No matches.**

### `callIdRef` / any latch

```
grep -rni "callIdRef|latch" src/
```
**No matches.**

### Function invoked twice for one `run(...)` / `.finally(` re-invoking `fn`

```
grep -n "fn(" src/lib/utils.ts
```
```
src/lib/utils.ts:60:    return fn(controller.signal).catch((e: unknown) => {
```
Single invocation (see Step 3). Reviewing every `.finally(` in the codebase:

- `utils.ts:145` — inside `useAutoRefresh`; the handler only resets a boolean guard
  `inFlightRef.current = false`. It calls no `fn`.
- All component `.finally(` blocks (`LogsPage:621`, `RedirectsPage:382,416`,
  `QueryPage:686`, `AnalyticsPage:218,262`, `AttckFleetPage:258`, `FindingsPage:397`,
  `HostInspectorPage:471,497`, `DashboardPage:183`) contain only guarded `setState`
  clears — none re-invokes the loader or its `fn`.

**No double-invocation shape survives.**

### Never-resolving promise

```
grep -rn "new Promise(() => {})" src/
```
**No matches.**

### Cue-hiding shape: unguarded clear inside `finally` that runs on supersession

Every generation-guarded loader puts the guard **before** the clear. Full inventory:

| file:line | clear statement | classification |
|-----------|-----------------|----------------|
| FindingsPage.tsx:397-402 | `.finally(() => { if (!genCurrent(g)) return; ...; setLoading(false); setRefreshing(false) })` | **acceptable** — guard first; a superseded read returns early and does NOT clear. |
| LogsPage.tsx:621-625 | `.finally(() => { if (!genCurrent(g)) return; ...; setLoading(false) })` | **acceptable** — guard first. |
| AnalyticsPage.tsx:218-222 | `.finally(() => { if (!allCurrent(g)) return; setLoading(false); setHasLoaded(true) })` | **acceptable** — guard first. |
| AnalyticsPage.tsx:262-264 | `.finally(() => { if (rawCurrent(g)) setRawLoading(false) })` | **acceptable** — conditional clear inside guard. |
| AttckFleetPage.tsx:258-260 | `.finally(() => { if (fleetCurrent(g)) setLoading(false) })` | **acceptable** — conditional clear. |
| DashboardPage.tsx:183-185 | `.finally(() => { if (recentCurrent(g)) setRecentLoading(false) })` | **acceptable** — conditional clear. |
| HostInspectorPage.tsx:471-472 | `.finally(() => { if (genCurrent(g)) setReportLoading(false) })` | **acceptable** — conditional clear. |
| HostInspectorPage.tsx:497-498 | `.finally(() => { if (genCurrent(g)) setSectionsLoading(false) })` | **acceptable** — conditional clear. |
| HostInspectorPage.tsx:627-629 | `.finally(() => { if (genCurrent(g)) setRawLoading(false) })` | **acceptable** — conditional clear. |
| RedirectsPage.tsx:382-384 | `.finally(() => { if (tableCurrent(g)) setLoading(false) })` | **acceptable** — conditional clear. |
| RedirectsPage.tsx:416-418 | `.finally(() => { if (graphCurrent(g)) setGraphLoading(false) })` | **acceptable** — conditional clear. |
| QueryPage.tsx:686 | `.finally(() => { ... setLoading(false) })` | **acceptable** — guard precedes it (see QueryPage loader). |
| PatternTable.tsx:230-251 | clears at 231 / 238 / 244 / 251 | **acceptable** — NOT a `finally`. All clears lie *after* the `if (!genCurrent(g)) return` early-exit at line 227; a superseded invocation returns before reaching any clear. |
| RedirectsPage.tsx:672 | `setHistoryLoading(false)` in `openHistory`'s `finally` | **acceptable** — single non-overlapping dialog read (Step 4). |
| BlacklistPage.tsx:370, 435, 460, 475, 512, 552 | plain `async` `finally` clears | **acceptable** — no `useAbortable`/`useGeneration`; single read, nothing to supersede. |
| JaillistPage.tsx:84, 139, 164, 179, 214, 253 | plain `async` `finally` clears | **acceptable** — same as Blacklist. |
| LoginPage.tsx:24 | plain `async` `finally` clear | **acceptable** — single submit read. |
| Add{Blacklist,Jaillist,Pattern}Dialog.tsx, BlockDomainPage.tsx, WhitelistDomainPage.tsx, DataTable.tsx, ListActionDropdown.tsx, LogsPage (row-level), RedirectsPage (row-level), FindingsPage (row-level) | `finally` clears | **acceptable** — mutation/action handles, not overlapping reads. |

**No occurrence of the rejected shape.** In the *exact* case that motivated the
revert — `PatternTable.tsx`, the page the user reported — the loader returns early on
supersession at line 227 (`if (!genCurrent(g)) return // it owns loading/data/error
now, so touch nothing or we would blank its spinner`) and the only clears happen on
paths where this invocation is still the current owner (abort-while-current, success,
non-abort error). That is the correct, cue-preserving ordering.

---

## Final verdict

**CLEAN.**

Summary of the proof:

- **Gates:** build 0, tsc 0, lint **23 warnings / 0 errors**.
- **Footprint:** exactly one modified file in the repo — `RedirectsPage.tsx` (+12/-1).
  `utils.ts` diff empty. Ten named page components all `git diff --quiet` → 0. No probe
  artifacts. The only other working-tree entries (`brag-output/`,
  `unetwatch.db.instance-lock`) are untracked and **outside `admin-ui/`** — pre-existing,
  unrelated.
- **Request doubling:** disproved. `fn(...)` is called once (utils.ts:60); the `.catch`
  is a promise chain, not a second call.
- **Cue-hiding regression:** disproved. `useAbortable` has no `superseded` parameter,
  no `isSupersededRef`, no latch. Every generation-guarded loader puts its guard *before*
  the clear; only genuinely non-overlapping reads (dialog, plain async pages) clear
  unguarded, and that is safe.
- **The final change is correct:** the signal reaches `fetch` via the real
  `opts?: ReqOpts` parameter; superseded reads paint nothing; `AbortError` never surfaces;
  `historyLoading` clears on all terminal paths.

Nothing still needs attention. The change is minimal, correct, and leaves no residue of
either rejected attempt.
