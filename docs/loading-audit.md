# Loading / Loader architecture audit — `admin-ui/src/`

Scope: every loading surface reached from the admin UI — the `components/loading/*`
primitives, the `Skeleton` primitive in `ui.tsx`, the shared `DataTable` loader, and
every page/section that swaps the rendered tree on a `loading`/`busy` flag. Also the
request-cancellation and stale-response-guard status of the whole tree.
Read-only audit — no file was modified. Every claim is anchored to a `file:line`
quote. All paths are relative to `admin-ui/src/` unless stated otherwise.

Method: 4 parallel read-only scouts produced the per-page branch inventory and the
cancellation/race inventory; the planner re-verified the primitives, `api.ts`,
`DataTable`, `QueryPage`, `lib/utils.ts`, and the CSS directly. Cross-checked against
`docs/table-audit.md` and `docs/chrome-consistency-audit.md` where they overlap.

---

## 0. Executive summary

The user's complaint has two halves. Both are **substantiated**, with an important
correction:

- **(A) "…instead of showing new components"** — CONFIRMED as a real pattern, but it
  is *not* a missing shimmer. The shimmer already exists and animates
  (`index.css:167-168`, used by `Skeleton` at `ui.tsx:438`). The actual defect is
  **shape**: a large number of first-load branches replace the real layout with a
  skeleton that does not mirror it — one flat block standing in for a multi-panel or
  multi-row surface. The user sees the *page jump* when the block is swapped for the
  real content, not a missing animation.
- **(B) "the loading should be cancelled"** — CONFIRMED. There is **exactly one**
  real network cancellation in the entire tree (`QueryPage.tsx:633-676`). Everywhere
  else the request runs to completion; the ~24 `let cancelled = false` guards only
  suppress `setState`, they do not abort the fetch. There are **15 race sites** where
  user-controlled input keys a request with no signal and no generation guard, so a
  slow earlier response can silently overwrite a newer one.

**Tally of the loading-branch survey** (all branches across the 13 surfaces + `DataTable`):

| Classification | Count | Notes |
|---|---:|---|
| Keeps previous content + inline indicator (refetch — the good pattern) | 18 | The dominant, deliberate pattern; correctly implemented nearly everywhere |
| Same-shape skeleton | 5 | `DataTable` rows, Analytics stat grid, HostInspector findings 5-card grid, UrlInvestigation 4-card+content, Redirects table (delegated) |
| **Wrong-shape skeleton** | **11** | One block (or a mismatched set) for a multi-panel/multi-row surface — the core of complaint (A) |
| Spinner/indicator instead of content | 9 | All but one are header mirrors or button-scope busy states — **not** content-replacing |
| Whole-section blank/empty while loading | 0 | Loading never renders a bare empty region; empty/error states are post-load only |
| No loading UI at all (unclassified gap) | 4 | 2 Dashboard stat counts, Findings `refetchIndexes`, Query documents table |

> **Wrong-shape skeleton sites: 11.** Ranked in §4.1.

**Does ANY real cancellation exist today?** Yes — exactly one: `QueryPage.tsx`
(`AbortController` at :640, `.abort()` at :639/:635, `signal:` at :652, `AbortError`
swallow at :659). Every other request is uncancellable. `AbortSignal` appears in
`api.ts` only as the `runQuery` option (`api.ts:300,311`).

### Top 5 concrete actions

1. **Add a `signal?: AbortSignal` parameter to `api.ts:request()` and thread it
   through every exported reader**, plus a `useAbortable`/generation-guard hook. Fix
   the **15 race sites** (§4.3). Highest value: AnalyticsPage, PatternTable,
   UrlInvestigationPage, HostInspectorPage, AttckFleetPage — these have *no* guard at
   all today.
2. **Replace the 11 wrong-shape skeletons** with shape-mirroring `TableSkeleton` /
   `SkeletonShape` primitives (§4.2). Worst offenders: `QueryPage.tsx:962-971`
   (h-40 + 3×h-56 for a 6-panel page) and `AttckFleetPage.tsx:290-294` /
   `AttckPanel.tsx:65-69` (a single `h-40` for a whole multi-panel result).
3. **Give `useAutoRefresh` (`lib/utils.ts:35-66`) in-flight tracking** so a slow poll
   tick cannot overlap the next one. Only the Query page's callback is currently
   overlap-safe, and only because it aborts.
4. **Fix the two "never blank" promises that break on failure**: `FindingsPage.tsx:361-362`
   (`setFindings([])`) and `QueryPage.tsx:666` (`setResult(null)`) throw away a good
   table on a failed refetch.
5. **Close the four no-loading-UI gaps** (§4.4), especially `DashboardPage.tsx:97-135`
   where two stat cards show a bare `—` with no skeleton and no elapsed cue on a cold
   backend.

---

## 1. The loading inventory

### 1.1 `components/loading/` — the primitives

| File | Lines | Role |
|---|---:|---|
| `components/loading/LoadingIndicator.tsx` | 170 | The single "we are still working" banner |
| `components/loading/ProgressHint.tsx` | 59 | Inline determinate/indeterminate hairline track |
| `components/loading/useDelayedVisible.ts` | 93 | Anti-flicker gate (250 ms delay / 400 ms min-visible) |
| `components/loading/useElapsed.ts` | 106 | Honest elapsed-time counter + formatter |
| `components/loading/progress.ts` | 62 | Determinate-vs-indeterminate maths (pure, no DOM) |
| `components/loading/index.tsx` | 62 | Re-exports + the module contract doc-block |

> Note: `ui.tsx:447` re-exports `LoadingIndicator`, and `ui.tsx:96-98` defines the
> separate `LoadingIcon` (`<Loader2 className="h-4 w-4 animate-spin" />`) used for
> button/row-scope busy states.

**The anti-flicker contract.** `useDelayedVisible.ts:7` fixes `LOADER_DELAY_MS = 250`
and `:13` fixes `LOADER_MIN_VISIBLE_MS = 400`:

```ts
export const LOADER_DELAY_MS = 250
export const LOADER_MIN_VISIBLE_MS = 400
```

The documented timeline (`useDelayedVisible.ts:18-29`): at `t=0 active=true` nothing
shows; at `t=250` still active → `visible=true`; if work ends at `t=300` the loader
stays until `t=650`; if work outlives the delay and ends at `t=900` it leaves
immediately. `:39` `const visible = usePageVisible()` means a hidden tab arms **no
timers** at all (`:53-57`), and `:90` clears the timer on unmount. Callers may
override via `immediate` (`LoadingIndicator.tsx:79`).

**The phase copy** (`LoadingIndicator.tsx:15-30`):

```ts
type Phase = "working" | "slow" | "stalled"
const SLOW_MS = 10_000
const STALLED_MS = 45_000
const PHASE_COPY: Record<Phase, string> = {
  working: "Still working…",
  slow: "This is taking longer than usual — the query is still running.",
  stalled: "Still running after 45s. The Elasticsearch cluster may be under load or slow to respond.",
}
```

**How it renders** (`LoadingIndicator.tsx:120-165`): `if (!show) return null`. Otherwise
a `div.animate-in.flex.flex-col.gap-1.5.rounded-md.border.border-border.bg-card.px-3.py-2.shadow-sm`
with `data-state={phase}`. Inside: an `sr-only` `role="status" aria-live="polite"`
node carrying `announced` (only phase *changes* are announced, `:91-101`); a row with
a `Clock`/`AlertTriangle` icon, the label, an `aria-hidden` mono `tabular-nums` elapsed
figure, and an optional `ProgressHint`; then the phase sentence. The label only gets an
ellipsis in the first sub-second beat (`:118`). The indeterminate track is a
`skeleton-shimmer` sweep only when `progress` exists but has no `total`
(`:153-159`).

**Progress maths** (`progress.ts:40-50`): a percentage renders only when a real `total`
is supplied; otherwise indeterminate and the copy is a count. The determinate bar is
clamped to `MIN_TRACK_PERCENT = 2` (`:32,:48`) so a 0-row start is not read as broken.

**`.skeleton-shimmer` — the EXACT current animation** (`index.css:167-168`):

```css
.skeleton-shimmer { background: repeating-linear-gradient(90deg, transparent 0 16px, color-mix(in oklch, var(--color-foreground) 6%, transparent) 16px 17px); animation: skeleton-shimmer 0.9s linear infinite; }
@keyframes skeleton-shimmer { 0%{transform:translateX(-100%)} 100%{transform:translateX(100%)} }
```

- **What moves:** the shimmer element itself, by `transform: translateX`, from fully
  off-screen left (`-100%`) to fully off-screen right (`+100%`). The background is a
  *repeating* 1px-in-16px gradient tile at only **6% foreground opacity**, so the
  visual is a very faint hairline comb sweeping across.
- **Duration:** `0.9s`, **easing:** `linear`, iteration `infinite`.
- **Consumers:** `ui.tsx:438` (`Skeleton`, as an `absolute inset-0` child of an
  `overflow-hidden` box), `ProgressHint.tsx:50` and `LoadingIndicator.tsx:156` (the
  indeterminate hairline).
- **Motion safety:** frozen by `html[data-paused] *` (`index.css:170`, toggled in
  `App.tsx:199`) and collapsed by `@media (prefers-reduced-motion: reduce)`
  (`index.css:173-175`, `animation-duration: 0.01ms`).

**Assessment of (A) against the primitive.** There is no missing animation to add —
shimmer exists, animates, and is reduced-motion-safe. The complaint is more plausibly
about **shape** (the switch from a generic block to the real layout is the jarring
part), and secondarily about the shimmer being *too faint to read as motion* (6%
opacity, 1px line). That is a design-tuning question, not an architecture gap.

### 1.2 `ui.tsx` — the `Skeleton` primitive (`:433-441`)

```tsx
/* ── Skeleton — shimmer ─────────────────────────────────────── */

export function Skeleton({ className }: { className?: string }) {
  return (
    <div className={cn("relative overflow-hidden rounded-md border border-border bg-muted", className)} aria-hidden="true">
      <div className="skeleton-shimmer absolute inset-0" />
    </div>
  )
}
```

`Skeleton` is *only* a sized box — it has no notion of shape, rows, or columns. **56
`Skeleton` usages** exist across 12 component files. Every "wrong-shape skeleton" in
§2 is therefore a *call-site* construction problem (`<Skeleton className="h-40 w-full" />`),
which is exactly why a `SkeletonShape`/`TableSkeleton` primitive would help.

### 1.3 `DataTable.tsx` — the shared loader (`:961-974`, `:1006-1018`, `:1221-1240`)

`DataTable` implements the app's best, most complete loading behaviour and is worth
quoting as the reference pattern:

```tsx
/* ── Loading treatment ──────────────────────────────────────────────
 * A REFETCH while rows already exist must not blow the rows away: keeping
 * the last good data on screen is the single biggest perceived-performance
 * win here. We mark the region aria-busy, dim it quietly, and surface the
 * toolbar hint. Full skeleton rows are reserved for the genuinely-empty
 * first load (`data.length === 0`), where there is nothing to keep. */
const showToolbarHint = useDelayedVisible(loading, {
  delayMs: LOADER_DELAY_MS,
  minVisibleMs: LOADER_MIN_VISIBLE_MS,
})
const { elapsed } = useElapsed(loading, loadingStartedAt)
const dimInFlight = loading && !showToolbarHint
const inFlightClass = loading && data.length > 0 ? (dimInFlight ? "opacity-60" : "opacity-50") : ""
```

- Refetch: rows stay mounted, region is `aria-busy` and dimmed `opacity-50/60`
  (`:974`, applied at the scroll wrapper `:1137-1145`), a delayed toolbar hint with
  elapsed + `ProgressHint` appears (`:1006-1018`).
- First load: same-shape skeleton **rows**, one per visible column, honouring
  `col.width` (`:1224-1240`):

```tsx
{loading && data.length === 0 ? (
  <tbody>
    {Array.from({ length: skeletonRows }).map((_, i) => (
      <tr key={i} className="border-b border-border">
        {selectable && (<td className={pad.td}><Skeleton className="h-4 w-4" /></td>)}
        {visibleColumns.map((col) => (
          <td key={col.id} className={pad.td}>
            <Skeleton className={cn("h-4", col.width ?? "w-24")} />
          </td>
        ))}
      </tr>
    ))}
  </tbody>
) : data.length === 0 ? (
```

This is the **only genuinely shape-faithful skeleton in the app**, and it degrades
gracefully: a column with no declared `width` becomes `w-24` rather than vanishing —
except that columns are mapped from `visibleColumns`, which is stable, so the shape is
correct whenever `columns` is known. Two caveats: `skeletonRows` defaults to 8
(`DataTable.tsx:413`) regardless of the real page size, and a column whose `width` is
`undefined` renders an ambiguous `w-24` block.

---

## 2. "Swap out the component" survey — the core of complaint (A)

Legend: **SS** = same-shape skeleton · **WS** = wrong-shape skeleton · **SP** =
spinner/indicator instead of content · **BL** = whole-section blank/empty while
loading · **KP** = keeps previous content + inline indicator (refetch).

> **BL does not occur during loading anywhere in the app.** Every first-load branch
> renders *something* (a skeleton or the banner); empty/error states are strictly
> post-load. This refutes one interpretation of (A): the user is not seeing "a bare
> empty state" *while loading*. They are seeing a **shape change** when the placeholder
> is swapped for the real content.

### 2.1 Master table

| # | Surface | file:line (condition → render) | loading branch condition (quoted) | what renders while loading | Class | Shape match? |
|---|---|---|---|---|---|---|
| 1 | Dashboard — blacklist count | `DashboardPage.tsx:97-112`, render `:203` | *(none — no loading state; `blacklistCount` starts `null`)* | `value={blacklistCount !== null ? blacklistCount.toLocaleString() : "—"}` | **no loading UI** | n/a — a bare dash, not a skeleton |
| 2 | Dashboard — tracked count | `DashboardPage.tsx:114-129`, render `:222` | *(none)* | `value={trackedCount !== null ? trackedCount.toLocaleString() : "—"}` | **no loading UI** | n/a |
| 3 | Dashboard — recent findings, first load | `:296` → `:297-299` | `{recentLoading && recentFindings.length === 0 ? (` | `<div className="space-y-3" aria-busy="true"><Skeleton className="h-32 w-full" /></div>` | **WS** | No — one `h-32` block vs a 3-column `SimpleTable` |
| 4 | Dashboard — recent findings, refetch | `:287-292` | `<LoadingIndicator label="Loading recent findings" active={recentLoading} …>` | banner above kept table (`:300-301 <div aria-busy={recentLoading}>`) | **KP** | Yes |
| 5 | Analytics — stat grid, first load | `:675-682` | `{loading && !summary ? (` | `<div className="grid grid-cols-2 gap-3 lg:grid-cols-3 xl:grid-cols-5">` + `<Skeleton className="h-28 w-full" />` ×5 | **SS** | **Yes** — same wrapper as `:684`, 5-for-5 StatCards, `h-28` ≈ card height |
| 6 | Analytics — bandwidth chart | `:714-715` | `{loading && !bandwidth ? (` | `<Skeleton className="h-64 w-full" />` | **WS** | No — a flat block vs `TrendCharts height={260}` + axis/legend chrome |
| 7 | Analytics — enforcements chart | `:729-730` | `{loading && !enforcements ? (` | `<Skeleton className="h-64 w-full" />` | **WS** | No — same, vs a stacked-bar chart |
| 8 | Analytics — top-domains table | `:752` → `DataTable.tsx:1224-1240` | `loading={loading && !topDomains}` | DataTable skeleton rows | **WS** | Partial — identity column (`domain`) has no `width`, so the skeleton drops 1 of 4 columns; 8 rows vs a 10-row payload |
| 9 | Analytics — top-clients table | `:768` → `DataTable.tsx:1224-1240` | `loading={loading && !topClients}` | DataTable skeleton rows | **WS** | Partial — `client_ip` has no `width` → 2 skeleton cells for a 3-column table |
| 10 | Analytics — raw findings table | `:828-829` → `DataTable.tsx` | `loading={rawLoading && raw.length === 0}` | DataTable skeleton rows | **SS** | Yes (columns have widths); 8 rows vs page 50 |
| 11 | Analytics — refetch banner | `:666-671` (`refreshing = loading && hasLoaded`, `:164`) | `{refreshing && (` | `<LoadingIndicator label="Refreshing analytics aggregates" …>`; all 5 panels stay mounted | **KP** | Yes |
| 12 | Query — first load | `:954` → `:955-971` | `{firstLoad ? (` | `<LoadingIndicator label="Querying Elasticsearch" active={loading} …>` + `<Skeleton className="h-40 w-full" />` + grid of 3× `<Skeleton className="h-56 w-full" />` | **WS** | **No** — skeleton is 1 bar + 3 boxes; final content is a 6-up StatCard row, two ranked tables, a Sankey panel and a DataTable |
| 13 | Query — refetch | `:981-987` | `{loading && (` (inside the `:989` `) : (` branch) | `<LoadingIndicator label="Refreshing query" …>`; `:990 <div className="space-y-6" aria-busy={loading}>` keeps all panels | **KP** | Yes |
| 14 | Query — Run/Refresh buttons | `:894-901`, `:1073-1076` | `disabled={loading}` | `{loading ? <LoadingIcon /> : <Play …/>}` label swap | **SP (control-scope)** | n/a — not content-replacing |
| 15 | Query — documents DataTable | `:1187` | `busy={loading}` — **no `loading` prop is passed** | rows dim but DataTable's own skeleton path can never fire | **KP** | Yes (but the first-load skeleton is suppressed here) |
| 16 | PatternTable — first load | `:394` → `DataTable.tsx:1224-1240` | `loading={loading && patterns.length === 0}` | DataTable skeleton rows | **WS** | No — `PATTERNS_COLUMNS` declare no `width`, so every cell is `w-24`; 8 rows vs page 50 |
| 17 | PatternTable — refetch | `:381-387` | `{loading && loadedRef.current && patterns.length > 0 && (` | `<LoadingIndicator label="Loading patterns" …>` above kept rows | **KP** | Yes — the exact requested branch |
| 18 | PatternTable — header cue | `:361-369` | `{loading && (` | `aria-hidden` `Loader2 animate-spin` + "Loading patterns · {elapsed}" | **SP (header mirror)** | n/a |
| 19 | Findings — first load | `:674` → `DataTable.tsx:1224-1240` | `loading={loading}` (set by `if (!loadedRef.current) setLoading(true)` at `:345`) | DataTable skeleton rows | **SS** | Yes — `FINDINGS_COLUMNS` declare widths; 8 rows vs page 25 |
| 20 | Findings — refetch | `:660-664` | `{refreshing && (` | `<LoadingIndicator label="Refreshing findings" …>`; `:666 <div aria-busy={refreshing}>` keeps the table | **KP** | Yes |
| 21 | Findings — header mirror | `:627-635` | `{refreshing && !loading && (` | `aria-hidden` `RefreshCcw animate-spin` + elapsed | **SP (header mirror)** | n/a |
| 22 | Findings — badge indexes | `:386-411` | *(no loading flag exists; `Promise.allSettled`, no spinner)* | nothing; failure only raises a warning Callout `:648-655` | **no loading UI** | n/a |
| 23 | Blacklist — URL/IP feed, first load | `BlacklistPage.tsx:227-229` | `{loading && entries.length === 0 ? (` | `<div className="space-y-3" aria-busy="true"><Skeleton className="h-40 w-full" /></div>` | **WS** | Partial — one 160px block vs an unbounded `max-h-80` scrolling `<ul>` of one-line rows |
| 24 | Blacklist — feed, refetch | `:217-225` (`refreshing={loading && haveEntries}`, `:621/:646`) | `refreshing` | `<span aria-hidden="true"><LoadingIcon className="h-3.5 w-3.5" />Refreshing feed…</span>`; list kept | **KP** | Yes |
| 25 | Blacklist — Add / Fetch-upstream buttons | `:568-571`, `:178-179` | `adding` / `upstreamSyncing` | `{adding && <LoadingIcon />}{adding ? "Adding…" : "Add"}` | **SP (button-scope)** | n/a |
| 26 | Jaillist — feed, first load | `JaillistPage.tsx:316-317` → `FeedCard` `BlacklistPage.tsx:227-229` | `loading && entries.length === 0` | same `Skeleton h-40 w-full` | **WS** | Partial (same as #23) |
| 27 | Jaillist — feed, refetch | `JaillistPage.tsx:316-317` | `refreshing={loading && haveEntries}` (`:34`) | `Refreshing feed…` + kept list | **KP** | Yes |
| 28 | Redirects — table, first load | `RedirectsPage.tsx:845` → `DataTable.tsx:1224-1240` | `loading={loading && items.length === 0}` | DataTable skeleton rows | **SS** | Yes |
| 29 | Redirects — table, refetch | `:818-824` | `{loading && items.length > 0 && (` | `<LoadingIndicator label="Loading tracked URLs" …>` above dimmed rows | **KP** | Yes |
| 30 | Redirects — graph panel, first load | `:730-733` | `{graphLoading && !graph ? (` | `<div className="space-y-3 p-4" aria-busy="true"><Skeleton className="h-64 w-full" /></div>` | **WS** | No — a rectangle vs a `NetworkGraphDiagram` DAG (nodes+links) |
| 31 | Redirects — graph panel, refetch | `:730` | `graphLoading && !graph` is false once `graph` exists | diagram kept — but **no inline cue** | **KP (silent)** | Yes for content; **no visible refetch indicator** (the header spinner tracks the *table*, not the graph) |
| 32 | Redirects — history drawer | `:924-927` | `historyLoading` | `<div className="space-y-3" aria-busy="true"><Skeleton className="h-40 w-full" /></div>` | **WS** | No — a block vs a list of variable-height edge cards; and `openHistory` nulls history first, so it can never keep content |
| 33 | Redirects — header / Check buttons | `:680-688`, `:692-695` | `loading` / `checking` | `aria-hidden` `RefreshCcw animate-spin` + elapsed; button label swap | **SP (header/button-scope)** | n/a |
| 34 | Logs — table, first load | `LogsPage.tsx:736-738` | `{loading && items.length === 0 ? (` | `<div className="space-y-3" aria-busy="true"><Skeleton className="h-56 w-full" /></div>` | **WS** | No — one 224px block vs a full multi-column `DataTable`; the block pre-empts DataTable's own row skeleton |
| 35 | Logs — table, refetch | `:724-730` | `{loading && items.length > 0 && (` | `<LoadingIndicator label="Loading logs" …>` + dimmed rows | **KP** | Yes |
| 36 | Logs — header / export / restore | `:697-705`, `:465-467`, `:482-486` | `loading` / `exporting` / `working` | header `aria-hidden` spinner; `"Exporting…"`; `<span role="status">Working…</span>` | **SP (header/button-scope)** | n/a |
| 37 | HostInspector — top-level lookup | `HostInspectorPage.tsx:1040-1053` | `{loading && (` | `<LoadingIndicator label="Resolving host profile…" …>` + `<Skeleton className="h-40 w-full" />` + `<Skeleton className="h-24 w-full" />` | **WS** | No — 2 flat blocks vs a `HostEntityCard` + sections |
| 38 | HostInspector — sections, first load | `:1097-1098`, `:1116-1117`, `:1132-1133`, `:1164-1165` | `sectionsLoading && !sections` (per panel) | `<Skeleton className="h-60 w-full" />`, `h-64`, `h-48`, `h-64` | **WS** | Partial — height approximates each panel; internal shape (timeline/ranked list/Sankey) is not mirrored |
| 39 | HostInspector — sections, refetch | `:1084-1090` | `{sectionsLoading && sections && (` | `<LoadingIndicator label="Refreshing host sections" …>`; panels kept | **KP** | Yes |
| 40 | HostInspector — findings 5-card grid | `:1242-1245` | `{reportLoading && !report ? (` | `<div className="grid grid-cols-2 gap-3 lg:grid-cols-3 xl:grid-cols-5">` + 5× `<Skeleton className="h-28 w-full" />` | **SS** | **Yes** — mirrors the 5 StatCards at `:1250-1256` |
| 41 | HostInspector — raw findings DataTable | `:1290` | `loading={rawLoading && raw.length === 0}` / `busy={rawLoading}` | DataTable skeleton rows / dim | **SS / KP** | Yes |
| 42 | UrlInvestigation — first load | `UrlInvestigationPage.tsx:283-292` | `{loading && !result ? (` | `<div className="grid grid-cols-2 gap-3 lg:grid-cols-4">` + 4× `Skeleton h-28` + `<Skeleton className="h-64 w-full" />` | **SS (near)** | Yes — 4-card grid matches the real `:296` grid; the `h-64` body is approximate |
| 43 | UrlInvestigation — Investigate button | `:263-265` | `disabled={loading}` | `{loading ? <LoadingIcon /> : <Search … />}{loading ? "Investigating..." : "Investigate"}` | **SP (button-scope)** | n/a |
| 44 | AttckFleet — whole result | `AttckFleetPage.tsx:290-294` | `{loading && (` | `<div aria-busy="true" aria-live="polite"><span className="sr-only">Loading fleet ATT&CK mapping</span><Skeleton className="h-40 w-full" /></div>` | **WS** | **No** — a single `h-40` for a whole multi-panel result |
| 45 | AttckPanel — whole panel | `AttckPanel.tsx:65-69` | `{loading && (` | `<Skeleton className="h-40 w-full" />` inside the Panel | **WS** | **No** — same |
| 46 | ReportPage — per-section skeletons | `ReportPage.tsx:445-449`, `:458-462`, `:476-480`, `:532-536`, `:557-561` | `profile.loading` / `breakdown.loading` / `report.loading` / `enrichLoading` | inside each `Panel`: `<span className="sr-only">Loading …</span>` + `<Skeleton className="h-28/h-40/h-32 w-full" />` | **WS** | Partial — heights approximate each section; but there is **no page-level loading branch**, so Provenance/Notes paint final content while sections skeleton independently |
| 47 | ReportPage — provenance badges | `:435`, `:437`, `:439` | `profileLoading ? … : …` | `<Badge variant="secondary">loading</Badge>` | **SP (badge-scope)** | n/a |

### 2.2 Per-surface notes (the non-obvious ones)

**DashboardPage.** The only page that discriminates first-load from refetch by **data
presence** rather than a `loadedRef` (`:296 recentLoading && recentFindings.length === 0`).
Consequence: **an empty result set re-skeletons on every interval tick** — the one place
in the app that violates the "keep previous content" rule for a *successful* read. It is
also one of two surfaces with a pair of reads that have **no loading UI at all**
(`:97-135`).

**AnalyticsPage.** Each of the five aggregate panels has its **own** `!x` first-load
gate (`:675/:714/:729/:752/:768`), yet `fetchAll` (`:171-177`) is a single `Promise.all`
— so the gates can only be null together; they are shape/anti-flicker devices, not
partial-failure handling. The stat grid and raw table are shape-faithful; the two chart
blocks and the two aggregation tables are not.

**QueryPage.** This is the only page with real cancellation, and the only one whose
first-load skeleton is a *generic* block set (`h-40` + 3× `h-56`) for a rich 6-section
page. It is also the only page that deliberately **does not pass `loading`** to its
DataTable (`:1187` passes only `busy`) — so a first load of the documents table shows no
row skeleton at all (the page level covers it).

**PatternTable.** No page-level `Skeleton` import at all; first load is entirely
delegated to `DataTable`. But `PATTERNS_COLUMNS` declare no `width`, so every skeleton
cell is the ambiguous `w-24` fallback — a de-facto wrong-shape result despite delegating
to the good primitive.

**FindingsPage.** The most careful first/refetch split, and the one whose comment spells
out the rationale (`:342-344`). Its `refetchIndexes` (`:386-411`) issues four network
reads (whitelist, tracked, blacklist, jaillist) with **zero loading affordance** by design.

**BlacklistPage / JaillistPage.** Share one `FeedCard` (`BlacklistPage.tsx:95-276`). The
first-load `h-40` block stands in for a `max-h-80` scrolling list — right position,
wrong internal structure. The refetch cue is a separate always-evaluated block
(`:217-225`) so it shows above the kept list.

**RedirectsPage.** Two independent lifecycles. The **graph refetch is silent** — the
diagram stays mounted but there is no inline cue (the header spinner tracks the table).
The **history drawer** always blanks (`openHistory` does `setHistory(null)` before
`setHistoryLoading(true)`, `:623`), so it can never keep previous content and its `h-40`
block is wrong-shaped for variable-height edge cards.

**LogsPage.** `loadedRef` is set (`:602`) but **never read in JSX** — dead as a render
gate. The first-load `h-56` block pre-empts `DataTable`'s own (shape-faithful) row
skeleton, so Logs shows a *worse* first load than Findings/Redirects for the same
primitive.

**HostInspectorPage.** Ten loading surfaces. The per-panel skeletons (`h-60/h-64/h-48`)
approximate height but not internal shape. The findings tab's 5-card grid (`:1242-1245`)
**is** shape-faithful and is the template the other multi-panel skeletons should follow.

**AttckFleetPage / AttckPanel.** The two worst single-block skeletons: one `h-40`
standing in for an entire multi-panel ATT&CK mapping (`AttckFleetPage.tsx:293`) and one
`h-40` inside a panel (`AttckPanel.tsx:68`).

**ReportPage.** The outlier: **no page-level loading branch**. Six parallel fetches
(`:336/:339/:343` host, `:348/:352` url) each drive only a per-section `Skeleton` and a
Provenance `loading` badge, while the surrounding Panels paint final content
immediately. A cold report therefore shows a fully-drawn frame with three independently
skeletoned holes.

---

## 3. Cancellation / stale-response survey — the core of complaint (B)

### 3.1 Search results for the cancellation vocabulary

Grep of the whole `admin-ui/src` for `AbortController`, `AbortSignal`, `signal:`,
`.abort()`, `cancel`, `abort`, `DOMException`, `AbortError`:

**REAL network cancellation — exactly one file, `QueryPage.tsx`:**

| file:line | quoted code | verdict |
|---|---|---|
| `api.ts:300` | `signal?: AbortSignal` | REAL — `runQuery` option type |
| `api.ts:311` | `return request(\`/query/run?${params}\`, opts?.signal ? { signal: opts.signal } : undefined)` | REAL — the only signal forwarding in the tree |
| `QueryPage.tsx:633` | `const abortRef = useRef<AbortController \| null>(null)` | REAL |
| `QueryPage.tsx:634-636` | `useEffect(() => () => { abortRef.current?.abort() }, [])` | REAL — abort on unmount |
| `QueryPage.tsx:639` | `abortRef.current?.abort()` | REAL — abort previous before new (anti-pileup) |
| `QueryPage.tsx:640` | `const controller = new AbortController()` | REAL |
| `QueryPage.tsx:652` | `signal: controller.signal,` | REAL — passed to `runQuery` |
| `QueryPage.tsx:659` | `if ((e as Error).name === "AbortError") return` | REAL — the only `AbortError` reference in the tree |
| `QueryPage.tsx:642,655,658,670,676` | `let cancelled = false` … `cancelled = true` | Unmount guard layered on top of the real abort |

**`DOMException`: zero hits anywhere in `admin-ui/src`.** Aborts are detected only by
name-string comparison (`:659`).

**Everything else that matches `cancel`/`abort` is unrelated** — UI labels, dialog
`onCancel` props, a local edit-reset alias, or a cleanup-function name: e.g.
`BlacklistPage.tsx:157,200,716` (button text), `ui.tsx:675-684` (`ConfirmDialog`
`onCancel` plumbing), `BlockDomainPage.tsx:46-49` / `WhitelistDomainPage.tsx:42-45`
(`cancelEdit` — a local state reset, not a fetch cleanup),
`FindingsPage.tsx:379-380` `const cancel = refetch()` (`cancel` is only the returned
`cancelled=true` cleanup — it cancels no request), `DashboardPage.tsx:132-134`
(`cancelBlacklist`/`cancelTracked` — unmount-guard aliases),
`RedirectsPage.tsx:437-439` (clears a poll timer, does not abort the in-flight
`getRedirectCheckStatus`).

**Conclusion:** one of ~15 request sites cancels the network. The other ~14 cannot be
cancelled at all, because **no `api.ts` reader except `runQuery` accepts a signal**.

### 3.2 `api.ts` — how requests are made

The generic wrapper (`api.ts:472-489`):

```ts
async function request<T>(url: string, opts?: RequestInit): Promise<T> {
  const headers: Record<string, string> = { "Content-Type": "application/json" }
  const tok = getToken()
  if (tok) headers["X-API-Key"] = tok

  const res = await fetch(`${API}${url}`, { headers, ...opts })
  if (res.status === 401 && !url.includes("/auth/")) {
    setToken(null)
    _onSessionExpired?.()
    throw new Error("Session expired")
  }
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: res.statusText }))
    throw new Error(err.detail || "Request failed")
  }
  if (res.status === 204) return undefined as T
  return res.json()
}
```

`request()` **does** accept a full `RequestInit`, so it *could* carry a `signal` today —
but **no exported reader passes one**. Every reader builds its own params and calls
`request(url)` with no second argument, e.g. `getFindings`, `listPatterns`, `listLogs`,
`listTrackedUrls`, `getRedirectGraph`, all analytics readers, all blacklist/jaillist
readers. Roughly a dozen functions bypass `request()` entirely and call `fetch()`
directly with no `init` (`getBlacklistUrls` `:1275`, `getBlacklistIps` `:1284`,
`getJaillistIps` `:1381`, `probeEsHealth` `:509`, `login` `:458`, backup export `:2239`).

The only signal-aware reader is `runQuery` (`api.ts:292-312`):

```ts
export async function runQuery(
  minutes: number,
  opts?: {
    q?: string
    ip?: string
    excludeWhitelist?: boolean
    excludeBlacklist?: boolean
    viewMode?: "all" | "flagged"
    signal?: AbortSignal
  },
): Promise<QueryResult> {
  …
  return request(`/query/run?${params}`, opts?.signal ? { signal: opts.signal } : undefined)
}
```

So the plumbing exists in exactly one place. **No abort facility is exposed for any
other endpoint, and `api.ts` exports no `AbortController`-related helper.**

### 3.3 The `cancelled`-flag pattern — every site

~24 sites use the same shape: `let cancelled = false` inside a callback, checked before
each `setState`, and returned as the effect cleanup `() => { cancelled = true }`. **This
guards against *setState after unmount or effect re-run* only. It does NOT abort the
network request** — the fetch runs to completion and the server still does the work; the
response is merely discarded. No `let active`, `isMounted`, or `isCancelled` identifiers
exist anywhere in the tree.

| # | file:line | callback / effect | dependency array | guard |
|---|---|---|---|---|
| 1 | `DashboardPage.tsx:98,102,105,111` | `fetchBlacklistCount` | `[toast]` (`:112`) | `cancelled` |
| 2 | `DashboardPage.tsx:115,119,122,128` | `fetchTrackedCount` | `[toast]` (`:129`) | `cancelled` |
| 3 | `DashboardPage.tsx:131-135` | effect calling both | `[fetchBlacklistCount, fetchTrackedCount]` | aliases returned cleanups |
| 4 | `DashboardPage.tsx:138,144,147,154,158` | `fetchRecent` | `[toast]` (`:159`) | `cancelled` |
| 5 | `DashboardPage.tsx:161` | effect | `[fetchRecent]` | returns cleanup |
| 6 | `FindingsPage.tsx:341,355,360,367,374` | `refetch` | `[debouncedSearch, page, pageSize]` (`:376`) | `cancelled` |
| 7 | `FindingsPage.tsx:378-381` | `useEffect(() => { const cancel = refetch(); return cancel }, [refetch])` | `[refetch]` | returns cleanup |
| 8 | `LogsPage.tsx:576,589,594,601,607` | `load` | `[kind, page, pageSize, sortBy, sortDir, debouncedSearch]` (`:609`) | `cancelled` |
| 9 | `LogsPage.tsx:611` | effect | `[load]` | returns cleanup |
| 10 | `QueryPage.tsx:575,578,584,587` | jailed-index effect | `[]` (`:589`) | `cancelled` |
| 11 | `QueryPage.tsx:642,655,658,670,676` | `fetchQuery` | `[timeRange, whitelistMode, blacklistMode, debouncedEsSearch, viewMode]` (`:678`) | guard **+ real abort** |
| 12 | `HostInspectorPage.tsx:374,377,383,386` | jailed-index effect | `[]` (`:388`) | `cancelled` |
| 13 | `HostInspectorPage.tsx:452,457,460,463` | domain-match effect | `[host, timeRange]` (`:466`, eslint-disabled) | `cancelled` |
| 14 | `UrlInvestigationPage.tsx:83,86,92,95` | jailed-index effect | `[]` (`:97`) | `cancelled` |
| 15 | `RedirectsPage.tsx:340,352,357,364,367` | `loadTable` | `[debouncedSearch, page, pageSize, sortBy, sortDir]` (`:369`) | `cancelled` |
| 16 | `RedirectsPage.tsx:372,377,380,386,389` | `loadGraph` | `[]` (`:391`) | `cancelled` |
| 17 | `RedirectsPage.tsx:393-394` | two effects | `[loadTable]` / `[loadGraph]` | returned cleanups |
| 18 | `ReportPage.tsx:316,318,319,320` | `probeEsHealth` effect | `[]` (`:321`) | `cancelled` |
| 19 | `ReportPage.tsx:331,337,338,340,341,343,344,349,350,352,353,355` | entity load effect | `[kind, value]` (`:356`) | `cancelled` |
| 20 | `ZoneContext.tsx:17-19` | `getOperatorZone` effect | `[]` (`:20`) | `cancelled` |
| 21 | `useDelayedVisible.ts:90` | `useEffect(() => () => clearTimer(), [])` | `[]` | timer cleanup (unrelated) |
| 22 | `ui.tsx:636` | toast timer cleanup | `[]` | unrelated |
| 23 | `loading/LoadingIndicator.tsx:106-109` | announce-state reset | — | state reset, not a request guard |
| 24 | `ListActionDropdown.tsx:135-138` | container cleanup | `[]` | DOM cleanup (unrelated) |

### 3.4 The RACE class — user-controlled input, no signal, no generation guard

> **Criterion:** a request fired from a `useEffect` (or a callback invoked from an
> effect) whose deps include user-controlled values (search text, filters, page, time
> range, selected host/url/id). A **generation guard** — a monotonically increasing ref
> compared before `setState` — **does not exist anywhere in the tree.** The `cancelled`
> flag is per-invocation; when an effect re-runs the *old* invocation's flag flips, but
> it does not stop the network, and for the auto-refresh path the cleanup is discarded
> entirely, so two invocations can be live simultaneously with no ordering guarantee.

**Completely unguarded — no `cancelled`, no aborted signal:**

| file:line | effect deps (quoted) | request | race trigger |
|---|---|---|---|
| `AnalyticsPage.tsx:194-196` | `[fetchAll]`; `fetchAll` deps `[range, compare, toast]` (`:193`) | `Promise.all` of 5 `getAnalytics*` (`:171-177`) | time range, compare |
| `AnalyticsPage.tsx:222-224` | `[fetchRaw]`; deps `[range, rawSearch, rawPage, toast]` (`:220`) | `getFindings({ search, minutes, limit, offset })` (`:205-210`) | search, range, page |
| `PatternTable.tsx:209-211` | `[fetchPatterns]`; deps `[debouncedSearch, filterType, page, pageSize, sortBy, sortDir]` (`:207`) | `listPatterns({…})` (`:192-199`) | search, filter, page, sort |
| `AttckFleetPage.tsx:241-243` | `[fetchFleet]`; deps `[timeRange]` (`:239`) | `getFleetAttckMapping({ timeRange })` (`:232`) | time range |
| `UrlInvestigationPage.tsx:122-126` | `[globalFilter]` (eslint-disabled) → `void investigate(globalFilter)`; `investigate` deps `[toast, uSource]` (`:98-116`) — **no guard at all** | `getUrlBreakdown(trimmed, { limit: 100, source: uSource })` (`:108`) | selected URL / global filter |
| `HostInspectorPage.tsx:394-399` | `[globalFilter]` → `void lookup(globalFilter)`; `lookup` is a plain async fn (`:488`) — **no guard** | `getHostProfile` (`:506`) then `getClientReport` (`:526`) / `fetchSections` (`:535`) | selected host |
| `HostInspectorPage.tsx:556` | `[fetchRaw]`; `fetchRaw` deps `[report, rawSearch, rawPage, toast]` (`:552`) — **no guard** | `getClientReportFindings(report.client_ip, { search, limit, offset })` (`:540-543`) | raw search, raw page |
| `HostInspectorPage.tsx:409-427` | `[hSource]` (eslint-disabled) — **no guard** | `getClientReport(…)` (`:415`) | Live/Findings toggle |
| `HostInspectorPage.tsx:430-446` | `[hSource]` — **no guard** | `fetchHostSections(ip, timeRange, "live")` (`:439`) | Live/Findings toggle |
| `BlacklistPage.tsx:376-379` | `[load, loadUpstreamStatus]`; `load` deps `[splitLines, toast]` (`:365`) — no guard; also re-called after mutations (`:466`) | `getBlacklistUrls`, `getBlacklistIps`, `getBlacklistUpstreamStatus` (`:356-358,:370`) | not user-keyed (lower risk) |
| `JaillistPage.tsx:92-95` | `[load, loadUpstreamStatus]`; `load` deps `[splitLines, toast]` (`:82`) — no guard | `getJaillistIps`, `getJaillistUpstreamStatus` (`:73,:86`) | not user-keyed |

**Guarded but still racy** (per-invocation `cancelled` only; a slow earlier response can
still land after a fast newer one whenever the cleanup does not run — e.g. the
auto-refresh path, or an effect that discards the returned cleanup):

- `FindingsPage.tsx:378` — deps `[refetch]`, `refetch` deps `[debouncedSearch, page, pageSize]` → `getFindings` (`:349-353`). Also driven by `useAutoRefresh` (`:384`) which discards the cleanup.
- `LogsPage.tsx:611` — deps `[load]`, `load` deps `[kind, page, pageSize, sortBy, sortDir, debouncedSearch]` → `listLogs` (`:580-587`).
- `RedirectsPage.tsx:393` — deps `[loadTable]`, `loadTable` deps `[debouncedSearch, page, pageSize, sortBy, sortDir]` → `listTrackedUrls` (`:344-350`).
- `RedirectsPage.tsx:394` — deps `[loadGraph]`, deps `[]` → `getRedirectGraph` (`:375`). Not user-keyed; still uncancellable.
- `QueryPage.tsx:681` — `useEffect(() => fetchQuery(), [fetchQuery])` **discards the returned cleanup**, so its inner `cancelled` never flips on dep change; safety rests entirely on the `abortRef.current?.abort()` at `:639`. The only effect-keyed request that is genuinely safe.
- `HostInspectorPage.tsx:450-466` — deps `[host, timeRange]` → `getHostProfile(ip, timeRange)` (`:455`); guarded, no abort.
- `ReportPage.tsx:323-356` — deps `[kind, value]` → up to 3 parallel host requests / 2 url requests (`:336,:339,:343` / `:348,:352`); one shared `cancelled`, no abort.
- `DashboardPage.tsx:131-135,161` — deps stable (`[toast]`), fixed params → benign, but still uncancellable and overlappable via `useAutoRefresh`.

**Inline-vs-memoized distinction:** effects that call a memoized `refetch()`/`load()`
useCallback: `FindingsPage.tsx:379`, `LogsPage.tsx:611`, `RedirectsPage.tsx:393-394`,
`DashboardPage.tsx:161`. Effects/callbacks that **inline** the request body:
`QueryPage.tsx:647` (aborted), `AnalyticsPage.tsx:169,205` (unguarded),
`PatternTable.tsx:191` (unguarded), `AttckFleetPage.tsx:232` (unguarded),
`HostInspectorPage.tsx:455,506,526,535,540` (unguarded),
`ReportPage.tsx:336,339,343,348,352` (guarded), `BlacklistPage.tsx:358` (unguarded),
`UrlInvestigationPage.tsx:110` (unguarded), `JaillistPage.tsx:73` (unguarded).

### 3.5 `useAutoRefresh` — can a poll overlap an in-flight request?

`lib/utils.ts:30-66`:

```ts
/**
 * Periodically re-run `refresh` every `seconds` (0 = off). The interval is
 * persisted per `key` in localStorage and ticks are skipped while the tab is
 * hidden, so background tabs never hammer the API.
 */
export function useAutoRefresh(
  refresh: () => void,
  key: string,
  defaultSeconds = 0,
): { refreshSeconds: number; setRefreshSeconds: (s: number) => void } {
  const [refreshSeconds, setRefreshSeconds] = useState<number>(() => { … })

  useEffect(() => { … localStorage … }, [refreshSeconds, key])

  useEffect(() => {
    if (!refreshSeconds) return
    const id = window.setInterval(() => {
      if (document.visibilityState !== "hidden") refresh()
    }, refreshSeconds * 1000)
    return () => window.clearInterval(id)
  }, [refreshSeconds, refresh])

  return { refreshSeconds, setRefreshSeconds }
}
```

**Answer: yes, it can overlap.** `refresh` is typed `() => void` and the interval
callback is **fire-and-forget** — it neither awaits nor tracks the previous call. If a
tick's request is still in flight when the next tick fires, two requests run
concurrently with **no ordering guarantee**; whichever resolves last wins. The hook
also discards any cleanup the callback returns, so a callback that *does* maintain a
`cancelled` guard (e.g. `FindingsPage.refetch`) gets no benefit on this path.

The four call sites:

| file:line | key | default | callback | overlap? |
|---|---|---|---|---|
| `AnalyticsPage.tsx:198` | `"analytics"` | `0` | `fetchAll` (`:167-193`) — `Promise.all` of 5 requests | **YES** — 5 requests/tick, no guard, no abort |
| `DashboardPage.tsx:167` | `"dashboard"` | `60` | `refreshAll` (`:163-166`) = `{ onRefresh(); fetchRecent() }` | **YES** — `fetchRecent`'s guard is discarded |
| `FindingsPage.tsx:384` | `"findings"` | `0` | `refetch` (`:340-376`) | **YES** — cleanup discarded; also can race the debounced-search effect (a tick mid-typing issues a request for the previous search) |
| `QueryPage.tsx:685` | `"query"` | `0` | `fetchQuery` (`:638-678`) | **NO** — begins with `abortRef.current?.abort()` (`:639`), so ticks cannot pile up. (Comment at `:683-684` says "every 30s by default" but the actual default is `0`.) |

**`useDebounce` never cancels a request** — it only delays the *value* (`lib/utils.ts:21-28`
is a pure `setTimeout` debounce). Seven sites feed a fetch through it
(`FindingsPage.tsx:314`, `LogsPage.tsx:556`, `RedirectsPage.tsx:337`,
`QueryPage.tsx:591` & `:730`, `PatternTable.tsx:142`, plus `AnalyticsPage`'s
`rawSearch` which is **not** debounced at all). Debouncing reduces the *number* of
requests but does not stop a superseded one.

---

## 4. Concrete recommendations

> Design proposals only — no code was written. Every anchor is a place to change.

### 4.1 The N worst "component swap" sites, ranked

Ranked by how jarring the layout change is when the placeholder is replaced by the real
content (size of the mismatch × how often a user sees it).

1. **`QueryPage.tsx:962-971`** — first-load skeleton is one `h-40` bar + three `h-56`
   boxes, but the final page is a 6-card StatCard row, two ranked tables, a Sankey panel
   and a documents table. The largest shape delta in the app, on the highest-traffic page.
2. **`AttckFleetPage.tsx:290-294`** — a single `<Skeleton className="h-40 w-full" />`
   for an entire multi-panel ATT&CK fleet mapping.
3. **`AttckPanel.tsx:65-69`** — the same single `h-40` for a whole panel (embedded in
   other pages, so it is seen in several contexts).
4. **`HostInspectorPage.tsx:1040-1053`** — two flat blocks (`h-40`, `h-24`) for a
   `HostEntityCard` + multi-section investigation.
5. **`LogsPage.tsx:736-738`** — one `h-56` block for a full multi-column `DataTable`;
   the block *pre-empts* the app's own shape-faithful `DataTable` skeleton, so Logs shows
   a worse first load than pages that delegate.
6. **`RedirectsPage.tsx:730-733`** — one `h-64` rectangle for a DAG (`NetworkGraphDiagram`).
7. **`RedirectsPage.tsx:924-927`** — one `h-40` block for a list of variable-height edge
   cards (and it can never keep content, because `openHistory` nulls history first).
8. **`BlacklistPage.tsx:227-229`** (and `JaillistPage.tsx` via the shared `FeedCard`) —
   one `h-40` block for a `max-h-80` scrolling list of one-line rows.
9. **`AnalyticsPage.tsx:714-715` and `:729-730`** — flat `h-64` blocks for two
   `TrendCharts` (`height={260}` + axis/legend chrome).
10. **`AnalyticsPage.tsx:752` and `:768`** — delegated to `DataTable`, but the identity
    columns carry no `width`, so the skeleton silently drops a column.
11. **`ReportPage.tsx:445-449, 458-462, 476-480, 532-536, 557-561`** — per-section
    blocks that approximate height only; compounded by there being **no page-level
    loading branch**, so the frame paints while three holes skeleton independently.

Honourable mention (not a skeleton, but a swap): **`FindingsPage.tsx:361-362`**
(`setFindings([])`) and **`QueryPage.tsx:666`** (`setResult(null)`) — a *failed refetch*
throws away a perfectly good table, which is the same jarring swap the refetch pattern
exists to prevent.

### 4.2 Proposed `SkeletonShape` / `TableSkeleton` primitive design

**Problem:** `Skeleton` (`ui.tsx:435-441`) is shape-less. Every wrong-shape site is a
call-site that hand-rolls a box. Adding two composed primitives would let each surface
mirror its real layout in one line and would make mismatches visible in review.

Proposed primitives (design only):

**`TableSkeleton`** — mirrors `DataTable`'s own row skeleton (`DataTable.tsx:1224-1240`)
so it can be *lifted out of `DataTable`* and reused by the pages that currently
hand-roll a block:

```
<TableSkeleton
  columns={Array<{ width?: string }>}   // same col.width contract DataTable already uses
  rows={number}                          // default = page size, not the fixed 8
  selectable?: boolean
  header?: boolean                       // renders a skeleton header row too
/>
```

- **Replaces the wrong-shape blocks at** `LogsPage.tsx:736-738` (`h-56`),
  `AnalyticsPage.tsx:752` & `:768` (which today lose the identity column because no
  `width` is declared — the primitive should render a default-width cell for every
  column, not only the width-declared ones).
- Should realign `DataTable.tsx:1224-1240` to be implemented *in terms of* it so there is
  one skeleton row implementation.

**`SkeletonShape`** — an explicit layout mirror, composed from slots:

```
<SkeletonShape
  variant="stat-grid"      // 2-col → 5-col grid of card-height blocks
    | "chart"                // axis + plot area, matching TrendCharts chrome
    | "panel-stack"          // N stacked panel blocks with header bars
    | "feed-list"            // N one-line rows inside a bordered scrolling list
    | "dag"                  // node/edge silhouettes for NetworkGraphDiagram
    | "edge-list"            // variable-height edge cards
  count={5}                  // number of cards/rows/panels
  height={…}
/>
```

**Where each variant would replace a wrong-shape skeleton (file:line each):**

| Variant | Replaces | Current code |
|---|---|---|
| `stat-grid` | `QueryPage.tsx:965-969`, `HostInspectorPage.tsx:1244` *(already good — keep as the reference)*, `AnalyticsPage.tsx:676-682` *(already good)* | `h-28` grid already correct in 2 of 3 |
| `panel-stack` | `QueryPage.tsx:962-971` (the whole first-load block), `AttckFleetPage.tsx:293`, `AttckPanel.tsx:68`, `HostInspectorPage.tsx:1049-1050` | single/dual flat blocks |
| `chart` | `AnalyticsPage.tsx:715`, `AnalyticsPage.tsx:730` | `h-64 w-full` |
| `feed-list` | `BlacklistPage.tsx:229` (and `JaillistPage` via `FeedCard`) | `h-40 w-full` |
| `dag` | `RedirectsPage.tsx:732` | `h-64 w-full` |
| `edge-list` | `RedirectsPage.tsx:926` | `h-40 w-full` |
| `panel-stack` (per-section) | `ReportPage.tsx:448,461,479,535,560` | `h-28/h-40/h-32` |

Additionally, every hand-rolled `<Skeleton className="h-N w-full" />` block that sits
inside `aria-busy` should keep doing so; `SkeletonShape` should render the same
`aria-hidden` + shimmer contract as `Skeleton` so reduced-motion coverage
(`index.css:170,173`) is inherited unchanged.

Optionally address the **faintness** of the shimmer (complaint (A) may partly be "I
can't see it animating"): the current tile is a 1px line at 6% opacity sweeping every
0.9s (`index.css:167-168`). Raising the gradient opacity or widening the moving band —
behind the existing reduced-motion guard — would make the animation legible without
introducing any new motion primitive.

### 4.3 Proposed cancellation contract

**Today:** only `runQuery` accepts a `signal` (`api.ts:300,311`); only `QueryPage`
threads one (`QueryPage.tsx:633-676`); everything else relies on a `cancelled` flag that
does not stop the network.

**Proposed contract (design only):**

1. **`api.ts` — thread an optional signal through every reader.**
   - Add a shared options type, e.g. `type ReqOpts = { signal?: AbortSignal }`, and give
     every exported reader an optional trailing `opts?: ReqOpts` that is forwarded to
     `request(url, opts)`.
   - `request()` already forwards `...opts` into `fetch` (`api.ts:477`), so no change to
     the wrapper body is required beyond widening the type and merging the caller signal
     with the existing `headers`.
   - The ~dozen direct `fetch()` sites (`:458,:509,:1275,:1284,:1296,:1310,:1381,:1393,
     :1407,:2239`) should either route through `request()` or accept and forward `signal`
     explicitly, for consistency.
   - Keep `runQuery`'s existing signature; a shared `ReqOpts` supersedes its bespoke
     `signal?: AbortSignal`.

2. **A `useAbortable` hook (per-invocation AbortController).**
   ```
   const run = useAbortable()               // returns (fn) => Promise<T>
   useEffect(() => { run((signal) => getFindings({…}, { signal })) }, [deps])
   ```
   Contract: each call aborts the previous controller, creates a fresh one, passes its
   `signal` to the reader, and swallows `AbortError` (mirroring `QueryPage.tsx:659`).
   Cleanup aborts on unmount. This is the generalization of the one good implementation.

3. **A generation guard for the cases a signal cannot cover** (a request already in
   flight that must be *ignored* rather than aborted, or a poll tick whose cleanup was
   discarded):
   ```
   const gen = useGeneration()              // monotonically increasing ref
   useEffect(() => {
     const g = gen.next()
     load().then(d => { if (gen.isCurrent(g)) setState(d) })
   }, [deps])
   ```
   This is the safer default for the `useAutoRefresh` paths, because the hook discards
   the callback's cleanup (`lib/utils.ts:57-63`).

4. **`useAutoRefresh` should track in-flight state** so a slow tick cannot overlap the
   next (`lib/utils.ts:57-63`): e.g. a `useRef<boolean>` guard, or awaiting the previous
   promise, or routing the callback through `useAbortable`. This is the single change
   that fixes the three overlapping poll sites (analytics, dashboard, findings).

5. **Migration sites (ordered by risk):**
   - **Unguarded, user-keyed (do first):** `AnalyticsPage.tsx:194-196,222-224`;
     `PatternTable.tsx:209-211`; `AttckFleetPage.tsx:241-243`;
     `UrlInvestigationPage.tsx:122-126` (`investigate` itself needs the signal);
     `HostInspectorPage.tsx:394-399,409-427,430-446,556`.
   - **Guarded-but-racy, user-keyed:** `FindingsPage.tsx:378`; `LogsPage.tsx:611`;
     `RedirectsPage.tsx:393-394`; `HostInspectorPage.tsx:450-466`;
     `ReportPage.tsx:323-356`.
   - **Poll callbacks:** `AnalyticsPage.tsx:198`; `DashboardPage.tsx:167`;
     `FindingsPage.tsx:384` (leave `QueryPage.tsx:685` as-is — already correct).
   - **Low risk (not user-keyed):** `DashboardPage.tsx:131-135,161`;
     `BlacklistPage.tsx:376-379`; `JaillistPage.tsx:92-95`.

### 4.4 The four "no loading UI" gaps

| Surface | file:line | Gap | Suggested fix |
|---|---|---|---|
| Dashboard blacklist count | `DashboardPage.tsx:97-112` (render `:203`) | bare `—`, no skeleton, no elapsed | skeleton-in-place of the `StatCard` value, or a delayed `LoadingIndicator` |
| Dashboard tracked count | `DashboardPage.tsx:114-129` (render `:222`) | same | same |
| Findings badge indexes | `FindingsPage.tsx:386-411` | four reads, zero affordance | acceptable (badges are decoration) — but add the elapsed cue if it stays silent |
| Query documents table | `QueryPage.tsx:1187` | passes `busy` but not `loading`, so no first-load row skeleton | pass `loading={firstLoad && loading}` to get `DataTable`'s row skeleton |

### 4.5 Where "cancelling" would be WRONG

Cancellation must be applied only to **superseded reads**, never to writes or to work
whose result is still wanted:

1. **Mutations must never be aborted mid-flight.** A delete/add/clear/import that is
   half-sent has unknown server-side outcome; aborting the client promise does not undo
   it and would leave the UI unable to report success/failure. Concretely: the `busy`
   write paths — e.g. `BlacklistPage.tsx:466` (`load()` after add/delete),
   `FindingsPage.tsx` delete/clear/bulk (driven by `busy`), `RedirectsPage.tsx` delete &
   `checkRedirectsBackground` (`:1494`), `LogsPage.tsx` clear/delete and the
   `BackupPanel` export/restore (`exporting`/`working`, `:465/:482`). **Do not thread an
   abort signal into any POST/DELETE/PUT reader.** The current design (a `busy` flag that
   disables controls, never blanks content) is correct and should stay.
2. **Background redirect checks are fire-and-forget by design.** `checkRedirectsBackground`
   (`api.ts:1494`) returns an accepted `check_id` and the page polls
   `getRedirectCheckStatus` (`RedirectsPage.tsx:437-439`). Aborting that poll because the
   user navigated away would abandon a server-side job the operator asked for; the timer
   cleanup at `:437-439` should keep running or the job should be allowed to complete.
   Poll *reads* (`getRedirectCheckStatus`) may be aborted on unmount, but the background
   *job* must not be cancelled.
3. **The auto-refresh poll itself should be allowed to complete**, not aborted, when the
   only reason is that another tick is due — the correct behavior is to **skip** the new
   tick while one is in flight (see §4.3.4), or to let the older one finish and discard
   it with a generation guard. Aborting every tick would defeat the purpose of a
   periodic refresh on a slow backend (the exact wall-display scenario the loading
   module was built for).
4. **`probeEsHealth`** (`ReportPage.tsx:315-321`, `api.ts:507`) is a cheap reachability
   probe whose result is provenance metadata; aborting it on a fast nav change saves
   nothing and risks a report claiming "unknown (not probed)".

---

## 5. Answers to the two interpretations

- **(A) "swap the whole view out instead of animating a skeleton."** *Partly confirmed.*
  The app does render a *different* node during loading, but it is a skeleton (not a
  spinner or a blank), the skeleton already shimmers, and the animation is
  reduced-motion-safe. The genuine defect is that **11 of those skeletons do not match
  the final content's shape** (§2, §4.1), so the user perceives a layout jump — plus the
  shimmer is deliberately very faint (1px @ 6%). The fix is shape (a `SkeletonShape`
  primitive) and legibility (a stronger shimmer), **not** adding an animation that is
  already there.
- **(B) "the loading should be cancelled."** *Confirmed.* Exactly one of ~15 request
  sites cancels the network (`QueryPage.tsx`). Elsewhere the fetch always runs to
  completion; ~24 `cancelled` flags suppress only `setState`; **15 race sites** can let a
  stale response overwrite a newer one. Adding an optional `AbortSignal` to `api.ts`,
  a `useAbortable` hook, a generation guard for discarded-cleanup paths, and in-flight
  tracking in `useAutoRefresh` would remove all of them — while deliberately leaving
  writes (§4.5) uncancellable.
