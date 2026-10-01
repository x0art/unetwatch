# uNetWatch — Loading UX + Request Cancellation Revamp: Design Specification

Status: **Design only — no source file has been modified by this document.**
Owner: Design lead. Scope: the loading surfaces of every page/section in
`admin-ui/src/components/` and the request-cancellation contract of
`admin-ui/src/api.ts` + `admin-ui/src/lib/utils.ts`.
Authoritative inputs (cited throughout as **Audit §n**):
`docs/loading-audit.md`. Extended — never contradicted — are
`docs/component-canon.md` (cited as **Canon §n**) and `docs/table-revamp-spec.md`
(cited as **Grid §n**).

All paths are relative to `admin-ui/src/` unless stated otherwise. Line numbers
are from the revision read while authoring this document; where the docs were
authored against a slightly older snapshot the **symbol name** is the durable
anchor and the line is indicative — every claim names both.

The one problem this document solves: **the app swaps a *differently-shaped*
skeleton for real content (so the page jumps), and superseded reads are never
cancelled (so a stale response can overwrite a fresh one)**. Every rule below is
tied to a real `file:line`, states the single canonical className or signature,
and names the losers it replaces.

---

## 1. Problem statement

The user reported two things. Both are substantiated; the first needs one
correction.

### 1.1 (A) "why dont add animation in the skeleton during loading instead of showing new components"

**The corrected understanding: the animation already exists — the *shape* is
wrong, and the shimmer is too faint to read.**

The shimmer is present and animating today. `.skeleton-shimmer` (`index.css:167-168`)
is a `repeating-linear-gradient` swept by `@keyframes skeleton-shimmer`
(`0% translateX(-100%) → 100% translateX(100%)`, `0.9s linear infinite`), and it
is consumed by `Skeleton` (`ui.tsx:437-440`, as an `absolute inset-0` child of a
`relative overflow-hidden rounded-md border border-border bg-muted` box). It is
already motion-safe: frozen by `html[data-paused] *` (`index.css:170`, toggled at
`App.tsx` `data-paused`) and collapsed by `@media (prefers-reduced-motion: reduce)`
(`index.css:173-175`). So there is **no missing animation to add** (Audit §1.1
"Assessment of (A) against the primitive", Audit §0).

What is actually wrong is two-fold:

1. **Shape mismatch — the core defect.** Eleven first-load branches replace the
   real layout with a skeleton that does **not** mirror it: one flat block (or a
   mismatched set) standing in for a multi-panel or multi-row surface. The user
   perceives the *page jump* when the block is swapped for the real content, not
   a missing keyframe. The ranked list is Audit §4.1; the worst are
   `QueryPage.tsx:962-971` (one `h-40` + three `h-56` for a 6-panel page),
   `AttckFleetPage.tsx:290-294` and `AttckPanel.tsx:65-69` (a single `h-40` for a
   whole multi-panel result), `LogsPage.tsx:736-738` (one `h-56` **pre-empting**
   `DataTable`'s own shape-faithful row skeleton), and the two identity columns
   `AnalyticsPage.tsx:752` / `:768` that silently drop a column because no
   `width` is declared.
2. **Legibility.** The shimmer is deliberately faint: a **1px band at 6%
   foreground opacity** on a 16px repeating tile (Audit §1.1). At that strength
   many users do not read it as motion at all. This is the second half of (A),
   and it is a **design-tuning** problem, not an architecture gap.

The corrected statement for the record: *the shimmer animates; the skeleton is
the wrong shape, and the shimmer is too quiet to see.* The fix is a shape-mirroring
primitive (§3) plus one legibility change to the single shimmer source (§3.4) —
**not** adding an animation that is already there.

### 1.2 (B) "the loading should be cancelled"

**Confirmed.** Exactly one of ~15 request sites cancels the network:
`QueryPage.tsx:633-676` (`AbortController` at `:640`, `.abort()` at `:639`/`:635`,
`signal:` at `:652`, `AbortError` swallow at `:659`). The plumbing exists in
exactly one place in the API layer too: only `runQuery` accepts a signal
(`api.ts:300` type, `api.ts:311` the only forwarding), because `request()` already
spreads `...opts` into `fetch` (`api.ts:477`) — but no other exported reader ever
passes one (Audit §3.2).

Everywhere else the fetch runs to completion. The ~24 `let cancelled = false`
guards (Audit §3.3) suppress only `setState`; they do **not** abort the request
and the server still does the work. There are **15 race sites** (Audit §3.4)
where user-keyed input fires a request with neither a signal nor a generation
guard, so a slow earlier response can silently overwrite a newer one. And
`useAutoRefresh` (`lib/utils.ts:35-66`) is fire-and-forget, so three poll sites
(Analytics, Dashboard, Findings — Audit §3.5) can overlap with no ordering
guarantee.

The fix is: an optional `AbortSignal` threaded through every **read** reader, a
`useAbortable` hook that generalizes the one good implementation, a generation
guard for paths whose cleanup is discarded, and in-flight tracking in
`useAutoRefresh` — while deliberately leaving writes uncancellable (§5).

---

## 2. Design principles

These are the rules that make every choice in §3–§6 inevitable. Each cites the
evidence it generalizes.

1. **A skeleton must occupy the same boxes as its content.** A placeholder is a
   promise about the shape that is coming; breaking it is the layout jump the
   user reported. Therefore every skeleton is *composed* from the real surface's
   container + grid + padding (Canon §1.3 `gap-3`, `p-5`; `StatCard` `p-5`) — never
   a bare `h-N w-full` block standing in for a multi-box surface. (Audit §4.1.)

2. **One skeleton implementation per shape.** `DataTable` already renders the only
   shape-faithful skeleton in the app (`DataTable.tsx:1224-1240`). Any page that
   re-hand-rolls a block for a table is a second implementation that can drift.
   The primitive is the source; call sites compose it. (Audit §4.2; Canon §3.16.)

3. **Cancel reads, never writes.** Cancellation is for *superseded reads*. A
   half-sent mutation has unknown server-side outcome; aborting the client
   promise neither undoes it nor lets the UI report success/failure. So the
   cancellation contract is expressible **only for `GET`-style readers.** (Audit
   §4.5.)

4. **A stale response must never win.** Whatever the mechanism — abort or a
   monotonic generation — the ordering rule is absolute: the result of the
   *current* invocation always supersedes any earlier one, and an earlier
   response that lands late is discarded without touching state.

5. **Loading must never blank good data on a *refetch*.** Keeping the last good
   rows on screen is the single biggest perceived-performance win (Audit §4.3.1,
   `DataTable.tsx` loader doc-block). Skeletons are reserved for the genuinely
   empty first load; a refetch dims + cues and keeps content. Corollary: **a
   failed refetch must not throw away a good table** (Audit §4.1 honourable
   mention).

6. **Loading must be honest.** No synthesised percentage; anti-flicker
   (250ms/400ms) and elapsed-not-clock are preserved from
   `components/loading/index.tsx:1-53`. Composition never bypasses
   `LoadingIndicator`; skeletons are *additional*, not a replacement for the
   honest banner.

7. **Extend the canon, do not redesign it.** Every className below comes from the
   existing token/radius/shadow/spacing lockup (Canon §1) and the existing
   primitives. No new radius, no new shadow, no new color, no new motion
   primitive.

---

## 3. The skeleton primitive contract

Two composed primitives, both **additive** and both living in
`components/ui.tsx` next to `Skeleton` (`ui.tsx:435-441`, the shape-less box they
build on). Neither introduces a new duration, ease, radius, color, or shadow:
they reuse `Skeleton`'s shimmer contract, the canon's `rounded-md` +
`border border-border bg-card` containers, `shadow-sm` for floating surfaces and
`gap-3` for card grids (Canon §1.2, §1.3, Rule R1–R3).

Because both render only the existing `Skeleton` boxes, the accessibility,
reduced-motion and paused-tab behaviour are inherited unchanged (§3.6).

### 3.1 `TableSkeleton` — the grid mirror

**Purpose.** Render `DataTable`'s own row skeleton so it can be *lifted out of
`DataTable`* and reused by pages that currently hand-roll a block, while becoming
the single implementation of "rows loading".

**Signature (exact):**

```tsx
export interface TableSkeletonProps {
  /** One entry per rendered column. `width` is a Tailwind width class
   *  (e.g. "w-28", "w-[320px]"); absent ⇒ the primitive picks a stable
   *  default so the cell NEVER vanishes (fixes the Analytics dropped column). */
  columns: Array<{ width?: string }>
  /** Row count. Default: the surface's page size, never the fixed 8. */
  rows?: number
  /** Leading 48px checkbox cell, matching DataTable's select slot. */
  selectable?: boolean
  /** Render a skeleton header row too. Default true. */
  header?: boolean
  /** Density padding; default "comfortable". */
  density?: "comfortable" | "compact"
  className?: string
}

export function TableSkeleton({
  columns,
  rows = 8,
  selectable = false,
  header = true,
  density = "comfortable",
  className,
}: TableSkeletonProps): JSX.Element
```

**Exact DOM** (mirrors `DataTable.tsx:1224-1240` byte-for-byte, plus the header
row from `:1146-1219`):

```tsx
<div className={cn(
  "overflow-x-auto rounded-md border border-border bg-card shadow-none",
  className,
)} aria-hidden="true">
  <table className="w-full text-sm" aria-hidden="true">
    {header && (
      <thead>
        <tr className="border-b border-border bg-muted/50">
          {selectable && <th scope="col" className={cn(pad.th, "w-12")} aria-hidden="true" />}
          {columns.map((col, i) => (
            <th key={i} scope="col" className={pad.th} aria-hidden="true">
              <Skeleton className="h-3.5 w-16" />
            </th>
          ))}
        </tr>
      </thead>
    )}
    <tbody>
      {Array.from({ length: rows }).map((_, r) => (
        <tr key={r} className="border-b border-border last:border-b-0">
          {selectable && (
            <td className={pad.td}>
              <Skeleton className="h-4 w-4" />
            </td>
          )}
          {columns.map((col, c) => (
            <td key={c} className={pad.td}>
              <Skeleton className={cn("h-4", col.width ?? "w-24")} />
            </td>
          ))}
        </tr>
      ))}
    </tbody>
  </table>
</div>
```

where `pad = DENSITY_PAD[density]` and `DENSITY_PAD` is promoted to a shared
export (`DataTable.tsx:368-371`: `comfortable { th: "px-4 py-3", td: "px-4 py-3" }`,
`compact { th: "px-3 py-2", td: "px-3 py-1.5" }`, Canon §1.3 "Grid cell padding").

**The two contracts this fixes** (both from Audit §4.2):

- **Every column gets a cell, not only width-declared ones.** The current
  `DataTable` maps `visibleColumns` and does emit a cell for every column
  (`DataTable.tsx:1233-1237`) — but the pages that hand-roll (and the
  `AnalyticsPage` identity columns, Audit §4.1 #10) lose a column because too few
  width strings were declared against too few cells. `TableSkeleton` takes
  **one `columns` entry per rendered column** and always emits a cell, falling
  back to `w-24` — so the skeleton cell count equals the real column count, full
  stop. Mis-declaring `columns` is now a visible bug, not a silent omission.
- **`rows` defaults to the real page size, not the hard-coded 8.** Callers pass
  the surface's `pageSize` (e.g. 50 for Patterns/Query, 25 for Findings,
  `DEFAULT_PAGE_SIZE` for Redirects) so a first load does not advertise 8 rows for
  a 50-row page (Audit §4.2).

**One implementation rule.** `DataTable` is refactored so its
`loading && data.length === 0` branch (`DataTable.tsx:1224-1240`) renders
`<TableSkeleton columns={visibleColumns.map(c => ({ width: c.width }))} rows={skeletonRows} selectable={selectable} density={density} />`
inside its **existing** `<table>`/`<thead>` (the header row must stay the real,
sortable header, so `header={false}` there and the primitive renders only the
skeleton `<tbody>` rows). After this refactor there is exactly **one** place that
draws a skeleton table row. `skeletonRows` becomes an optional override rather
than a default constant (`DataTable.tsx:413`).

### 3.2 `SkeletonShape` — the layout mirror

**Purpose.** Mirror a non-grid surface's layout so the swap to real content does
not move boxes. Composed from slots; each variant names the real component it
mirrors and quotes that component's markup.

**Signature (exact):**

```tsx
export type SkeletonVariant =
  | "stat-grid"
  | "chart"
  | "panel-stack"
  | "feed-list"
  | "dag"
  | "edge-list"

export interface SkeletonShapeProps {
  variant: SkeletonVariant
  /** Cards / rows / panels depending on the variant. Default per variant. */
  count?: number
  /** Plot/diagram body height in px for `chart`/`dag`; ignored elsewhere. */
  height?: number
  className?: string
}

export function SkeletonShape({
  variant,
  count,
  height,
  className,
}: SkeletonShapeProps): JSX.Element
```

The whole component is `aria-hidden="true"` (§3.6). Exact per-variant DOM +
classNames + mirror:

#### `variant="stat-grid"`

Mirrors a `StatCard` row. Reference (already-correct) real markup:
`AnalyticsPage.tsx:684` wrapper
`grid grid-cols-2 gap-3 lg:grid-cols-3 xl:grid-cols-5` and `HostInspectorPage.tsx:1242-1245`
(same, 5 cards). Real card is `StatCard` = `overflow-hidden rounded-md border
border-border bg-card p-5 shadow-sm` with a `text-3xl font-bold` value line
(`ui.tsx:1133-1144`); `h-28` ≈ its measured height at the 5-up breakpoint.

```tsx
<div className={cn(
  "grid grid-cols-2 gap-3 lg:grid-cols-3 xl:grid-cols-5",
  className,
)} aria-hidden="true">
  {Array.from({ length: count ?? 5 }).map((_, i) => (
    <Skeleton key={i} className="h-28 w-full" />
  ))}
</div>
```

`count` default **5**. Replaces `QueryPage.tsx:965-969`; **keeps** the two sites
that are already correct (`AnalyticsPage.tsx:675-682`, `HostInspectorPage.tsx:1244`)
by migrating them onto the primitive so all three cannot drift.

#### `variant="chart"`

Mirrors `TrendCharts` (`TrendCharts.tsx:238-297`): a bare `w-full` ECharts host
of `style={{ height }}` (default `height=260`), which sits inside a `Panel`
(`ui.tsx:840-869` — `rounded-md border border-border bg-card shadow-sm`, header
`border-b border-border px-4 py-3`, body `p-4 sm:p-5`). The skeleton mirrors the
**plot area plus the axis/legend chrome** of the real chart rather than one flat
rectangle: a slim x-axis strip along the bottom and a legend row on top.

```tsx
<div className={cn("relative w-full", className)} style={{ height: height ?? 260 }} aria-hidden="true">
  {/* legend row — mirrors the ECharts legend at the top of the plot */}
  <div className="mb-3 flex items-center gap-3">
    <Skeleton className="h-3 w-16" />
    <Skeleton className="h-3 w-16" />
  </div>
  {/* plot area — fills the remaining height, leaving room for the axis strip */}
  <Skeleton className="h-[calc(100%-2.5rem)] w-full" />
  {/* x-axis strip */}
  <div className="mt-2 flex items-center justify-between">
    {Array.from({ length: 6 }).map((_, i) => (
      <Skeleton key={i} className="h-2.5 w-10" />
    ))}
  </div>
</div>
```

`height` default **260** (the `TrendCharts` default, `TrendCharts.tsx:244`).
Replaces `AnalyticsPage.tsx:714-715` and `:729-730` (Audit §4.1 #9).

#### `variant="panel-stack"`

Mirrors a stacked column of titled `Panel`s — the generic multi-section surface.
Reference real markup: `Panel` (`ui.tsx:840-869`). Each block is a panel frame
with a header bar and a body of skeleton lines:

```tsx
<div className={cn("space-y-5", className)} aria-hidden="true">
  {Array.from({ length: count ?? 3 }).map((_, i) => (
    <div key={i} className="overflow-hidden rounded-md border border-border bg-card shadow-sm">
      {/* header — mirrors Panel's Toolbar header: border-b border-border px-4 py-3 */}
      <div className="flex items-center gap-2 border-b border-border px-4 py-3">
        <Skeleton className="h-4 w-4" />
        <Skeleton className="h-4 w-40" />
      </div>
      {/* body — mirrors Panel's p-4 sm:p-5 */}
      <div className="space-y-3 p-4 sm:p-5">
        <Skeleton className="h-4 w-3/4" />
        <Skeleton className="h-4 w-2/3" />
        <Skeleton className="h-4 w-5/6" />
      </div>
    </div>
  ))}
</div>
```

`count` default **3**. `space-y-5` is the canonical page root rhythm and Panel
stack (Canon Rule R3). Replaces `QueryPage.tsx:962-971` (whole first-load block
→ a `stat-grid` + two `panel-stack`s + a `TableSkeleton`, see §3.3),
`AttckFleetPage.tsx:293`, `AttckPanel.tsx:68`, `HostInspectorPage.tsx:1049-1050`,
and the per-section `ReportPage.tsx:448,461,479,535,560`.

#### `variant="feed-list"`

Mirrors the `FeedCard` scrolling list (real markup `BlacklistPage.tsx:227-270`):
a `ul className="max-h-80 divide-y divide-border overflow-y-auto rounded-md
border border-border bg-muted/30 shadow-sm"` of one-line `li px-3 py-1.5` rows
tall enough to fill `max-h-80` (320px). The skeleton mirrors the container and the
row height, not a single 160px block.

```tsx
<div className={cn(
  "divide-y divide-border overflow-hidden rounded-md border border-border bg-muted/30 shadow-sm",
  "max-h-80",
  className,
)} aria-hidden="true">
  {Array.from({ length: count ?? 10 }).map((_, i) => (
    <div key={i} className="flex items-center gap-2 px-3 py-1.5">
      <Skeleton className="h-3.5 flex-1" />
      <Skeleton className="h-4 w-4 shrink-0" />
    </div>
  ))}
</div>
```

`count` default **10** (enough one-line rows to fill `max-h-80` at `py-1.5`).
Replaces `BlacklistPage.tsx:229` and, via the shared `FeedCard`, the Jaillist
first load (Audit §4.1 #8).

#### `variant="dag"`

Mirrors `NetworkGraphDiagram` (`NetworkGraphDiagram.tsx:368-407`): a
`div.relative` containing a `w-full` ECharts host of `style={{ height }}` plus an
absolute bottom-right zoom-control stack. The skeleton mirrors the node/edge
silhouette *and* the control overlay position.

```tsx
<div className={cn("relative w-full", className)} style={{ height: height ?? 360 }} aria-hidden="true">
  {/* node/edge silhouette — a few node plates joined by hairline edges */}
  <div className="flex h-full items-center justify-center gap-6 px-6">
    {Array.from({ length: count ?? 3 }).map((_, col) => (
      <div key={col} className="flex flex-col items-center gap-4">
        <Skeleton className="h-8 w-24 rounded-md" />
        <Skeleton className="h-8 w-24 rounded-md" />
      </div>
    ))}
  </div>
  {/* control overlay — mirrors the absolute bottom-3 right-3 zoom stack */}
  <div className="absolute bottom-3 right-3 flex flex-col gap-1" aria-hidden="true">
    <Skeleton className="h-8 w-8" />
    <Skeleton className="h-8 w-8" />
    <Skeleton className="h-8 w-8" />
  </div>
</div>
```

`count` default **3** columns; `height` default **360** (the Redirects graph host
height). Replaces `RedirectsPage.tsx:732` (Audit §4.1 #6).

#### `variant="edge-list"`

Mirrors the redirect-history drawer body: a list of **variable-height** edge
cards, not one flat block. Real content is a stack of bordered edge cards
(`RedirectsPage.tsx:924-927` is the placeholder; the loaded body is a list of
`Callout`/card rows). Each skeleton card is a bordered `Card` slab with a
variable-height body:

```tsx
<div className={cn("space-y-3", className)} aria-hidden="true">
  {Array.from({ length: count ?? 4 }).map((_, i) => (
    <div key={i} className="overflow-hidden rounded-md border border-border bg-card p-5 shadow-sm">
      <div className="flex items-center justify-between gap-3">
        <Skeleton className="h-4 w-40" />
        <Skeleton className="h-5 w-16 rounded-md" />
      </div>
      <div className="mt-3 space-y-2">
        <Skeleton className="h-3.5 w-full" />
        <Skeleton className={cn("h-3.5", i % 2 === 0 ? "w-5/6" : "w-2/3")} />
      </div>
    </div>
  ))}
</div>
```

`count` default **4**. Replaces `RedirectsPage.tsx:926` (Audit §4.1 #7). Note the
companion behaviour fix (§6, Batch 3): `openHistory` nulls history *before*
setting loading (`RedirectsPage.tsx:610-611`), so this variant can never keep
previous content until that ordering is corrected — see §4.6.

### 3.3 Worked example — the Query first load (the worst site)

`QueryPage.tsx:962-971` today: one `h-40` + a `lg:grid-cols-3` of three `h-56`.
The final page is a 6-up `StatCard` grid (`QueryPage.tsx:905`), a timeline
`Panel`, two ranked `SimpleTable`s, a Sankey `Panel`, and a `DataTable`
(Audit §4.1 #1). After the revamp the first-load branch is:

```tsx
<SkeletonShape variant="stat-grid" count={6} />
<SkeletonShape variant="panel-stack" count={2} />
<div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
  <SkeletonShape variant="chart" height={260} />        {/* timeline */}
  <SkeletonShape variant="panel-stack" count={1} />      {/* sankey panel */}
</div>
<TableSkeleton columns={QUERY_DOC_COLUMNS} rows={25} />
```

(the `StatCard` grid there uses `xl:grid-cols-6`, so `stat-grid` gains an optional
`cols="6"` escape hatch; default stays `5` per the canonical Analytics grid.)

### 3.4 Shimmer legibility — the single-source CSS change

The complaint (A) also covers "I cannot see it animating". The shimmer is a 1px
band at 6% opacity (`index.css:167`). Raise the **band width** and the **band
opacity** just enough to read as motion while staying Notion-quiet, in the one
place that feeds `Skeleton`, `ProgressHint` and `LoadingIndicator`
(Audit §1.1 consumers). This is a single-source change — never per-call-site.

**Exact change to `index.css:167-168`:**

```css
/* before */
.skeleton-shimmer { background: repeating-linear-gradient(90deg, transparent 0 16px, color-mix(in oklch, var(--color-foreground) 6%, transparent) 16px 17px); animation: skeleton-shimmer 0.9s linear infinite; }
@keyframes skeleton-shimmer { 0%{transform:translateX(-100%)} 100%{transform:translateX(100%)} }

/* after */
.skeleton-shimmer { background: repeating-linear-gradient(90deg, transparent 0 14px, color-mix(in oklch, var(--color-foreground) 10%, transparent) 14px 22px); animation: skeleton-shimmer 1.1s ease-in-out infinite; }
@keyframes skeleton-shimmer { 0%{transform:translateX(-100%)} 100%{transform:translateX(100%)} }
```

What changes, and why each stays appropriate:

| Axis | Before | After | Rationale |
|---|---|---|---|
| Band width | 1px (`16px 17px`) | 8px (`14px 22px`) | A 1px hairline is invisible at a glance; an 8px soft band is a readable sweep but still a *comb*, not a solid bar. |
| Band opacity | 6% | 10% | Doubling legibility without becoming a hard stripe; still far below the muted fill so the shimmer reads as sheen, not content. |
| Duration | `0.9s linear` | `1.1s ease-in-out` | A slightly slower, eased sweep reads as deliberate motion; `linear` at 0.9s can strobe faintly. Ease is a standard timing function, not a new motion primitive (`--default-transition-timing-function` is already `cubic-bezier(.16,1,.3,1)`; this inline `ease-in-out` avoids importing the token into raw CSS). |
| Tile | 16px | 22px | Keeps the comb spacing proportional to the wider band so the sweep does not look like a dense raster. |

**Guards are untouched and still cover the new values:**

- `html[data-paused] *` (`index.css:170`) freezes every animation, including the
  edited one, when the tab is hidden.
- `@media (prefers-reduced-motion: reduce)` (`index.css:173-175`) collapses
  `animation-duration` to `0.01ms`; a reduced-motion user sees a static filled
  band (the gradient background remains), which is the correct fallback.

No new keyframe, no new utility, no change to `Skeleton` (`ui.tsx:435-441`) and
no per-call-site override. Because there is exactly one `.skeleton-shimmer`
definition, `Skeleton`, `ProgressHint.tsx:50` and `LoadingIndicator.tsx:156` all
inherit the legibility change at once.

### 3.5 Skeletons as *additional*, never instead of, the honest banner

Composition must not regress the honest-loading contract
(`components/loading/index.tsx:1-53`). Rule: **a first-load branch renders the
`SkeletonShape`/`TableSkeleton` *and* keeps the `LoadingIndicator`** (as
`QueryPage.tsx:956-961` already does, and as `DataTable` does via its delayed
toolbar hint at `DataTable.tsx:192-203,1006-1018`). The skeleton mirrors shape;
the indicator supplies the honest elapsed figure and the phase sentences. Neither
replaces the other. Anti-flicker (250ms/400ms), elapsed-not-clock, the 10s/45s
phase transitions and the `role="status"` announcement all stay exactly as
specified in `loading/index.tsx`.

### 3.6 Accessibility contract

- **Skeletons are silent.** `Skeleton` is already `aria-hidden="true"`
  (`ui.tsx:437`). Both new primitives set `aria-hidden="true"` on their root and
  on every `Skeleton` they render, so a screen reader never enumerates placeholder
  boxes. `TableSkeleton` sets `aria-hidden` on the `<table>` and each `<th>`
  (`aria-hidden` cells are excluded from the table's accessible name traversal
  because the whole subtree is hidden).
- **The busy region keeps `aria-busy`.** The *host* keeps the
  `aria-busy="true"` on its wrapper exactly as today
  (e.g. `QueryPage.tsx:963`, `BlacklistPage.tsx:228`, `DataTable.tsx:1139`
  `aria-busy={loading || undefined}`). The primitives do **not** add or move
  `aria-busy`; the page owns it.
- **The honest `LoadingIndicator` still announces.** Only phase *changes* are
  announced, once, through its single `sr-only role="status" aria-live="polite"`
  node (`LoadingIndicator.tsx:91-101,122-125`). A fast read announces nothing. The
  skeleton never announces; the indicator always owns the live region.
- **Reduced motion / paused tab** are inherited from the CSS guards (§3.4); the
  primitives introduce no framer-motion, so `MotionGate` has nothing to gate.

---

## 4. The cancellation contract

### 4.1 `api.ts` — the `ReqOpts` type and which readers get it

**Exact type (new, exported from `api.ts`):**

```ts
/** Cancellation option for READ endpoints. Deliberately
 *  `AbortSignal`-only: writes never receive one (see §5 / Audit §4.5), so
 *  there is no room in the type for a mistake. */
export type ReqOpts = { signal?: AbortSignal }
```

**The `request()` wrapper needs no body change.** It already spreads `...opts`
into `fetch` (`api.ts:477` `fetch(\`${API}${url}\`, { headers, ...opts })`), so a
`signal` forwarded as `{ signal }` reaches `fetch` today. The only change is
widening the callers' types and forwarding.

**Rule R-C1 — which readers get `opts?: ReqOpts`.** Every exported reader that
performs a **read** (`GET`) gets an optional trailing `opts?: ReqOpts` and
forwards it, e.g.:

```ts
export async function listFindings(params?: {...}, opts?: ReqOpts): Promise<...> {
  return request(`/findings?...`, opts)   // forwards { signal } if present
}
```

`runQuery` already does this (`api.ts:300,311`); a shared `ReqOpts` **supersedes
its bespoke inline `signal?: AbortSignal`** so there is one spelling.

The readers in scope (representative, from the current `api.ts` reader index):

| Reader | Site | Notes |
|---|---|---|
| `runQuery` | `api.ts:292-312` | already signal-aware; signature normalized to `ReqOpts` |
| `listLogs` | `api.ts:366` | Logs table race |
| `listPatterns` | `api.ts:525` | PatternTable race |
| `getFindings` | `api.ts:783` | Findings + Analytics raw race |
| `getFindingsGraph` | `api.ts:812` | |
| `getLiveSankey` | `api.ts:891` | |
| `getTopClients` | `api.ts:1213` | |
| `getClientBreakdown` | `api.ts:1223` | HostInspector |
| `getUrlBreakdown` | `api.ts:1261` | UrlInvestigation race |
| `getBlacklistUrls` / `getBlacklistIps` / `getBlacklistSet` | `api.ts:1274,1283,1306` | direct `fetch()` — route through `request()` **or** accept + forward `signal` (Audit §4.3.1) |
| `getBlacklistUpstreamStatus` | `api.ts:1360` | |
| `getJaillistIps` / `getJaillistSet` / `getJaillistUpstreamStatus` | `api.ts:1380,1403,1438` | direct `fetch()` for the two `*Ips` |
| `listTrackedUrls` | `api.ts:1448` | Redirects table race |
| `getRedirectCheckStatus` | `api.ts:1502` | poll read — abortable **on unmount only** (§5.2) |
| `getRedirectGraph` | `api.ts:1506` | Redirects graph |
| `getUrlRedirectHistory` | `api.ts:1510` | history drawer |
| `getHostProfile` | `api.ts:1830` | HostInspector race |
| `getClientReport` / `getClientReportFindings` | `api.ts:2201,2205` | HostInspector race |
| `getHostAttckMapping` / `getUrlAttckMapping` / `getFleetAttckMapping` | `api.ts:2333,2344,2387` | Attck race |
| `getAnalyticsSummary` / `…Bandwidth` / `…Enforcements` / `…TopDomains` / `…TopDenied` / `…TopEnforced` / `…TopClients` | `api.ts:2013,2025,2037,2049,2063,2077,2091` | Analytics race (5 of these fire in one `Promise.all`) |
| `getLiveMetrics` | `api.ts:700` | |
| `getHostEnrichment` / `getUrlEnrichment` | `api.ts:2404,2407` | |
| `getPatternCounts` / `getPatternStats` / `getMonitorStatus` / `getKibanaSettings` / `getFieldMap` / `getAlerts` / `getOperatorZone` | `api.ts:573,639,681,2138,2153,2161,2427` | cheap reads; optional but harmless |

**Rule R-C2 — the type forbids a write from acquiring a signal.** Only readers
above get `ReqOpts`. Mutations keep their current signatures and **never** gain a
`ReqOpts` parameter — the omission is the enforcement (§5).

**Rule R-C3 — the ~dozen direct `fetch()` sites route through `request()` or
forward `signal` explicitly** (Audit §4.3.1), so there is one place signals are
attached. `login` (`api.ts:458`) and `probeEsHealth` (`api.ts:507-521`) are the
documented exceptions: `probeEsHealth` is **never** cancelled (§5.4) and `login`
is a write-shaped auth call. The backup export (`api.ts:2239`) is a write (§5.1).

### 4.2 `useAbortable()` — the per-invocation AbortController

The generalization of `QueryPage.tsx:633-676`. Lives in `lib/utils.ts` (or a new
`lib/abort.ts` re-exported from `lib/utils.ts`).

**Signature (exact):**

```ts
/** Run an abortable READ and get its typed result.
 *
 *  Each call: aborts the previous in-flight call, creates a FRESH
 *  AbortController, passes its `signal` to `fn`, and resolves with `fn`'s
 *  value. Aborted calls reject with the original `AbortError` (the caller's
 *  `catch` decides, but see `runQuietly` below). Unmount aborts the current
 *  call. Safe to call from an effect that re-runs on dep change. */
export function useAbortable(): <T>(
  fn: (signal: AbortSignal) => Promise<T>,
) => Promise<T>
```

**Semantics** (mirroring `QueryPage.tsx:633-676` exactly):

1. A `useRef<AbortController | null>` holds the current controller.
2. On each invocation: `abortRef.current?.abort()` **then**
   `const controller = new AbortController(); abortRef.current = controller`
   (the anti-pileup order at `QueryPage.tsx:638-641`).
3. `signal` is the **fresh** controller's signal — never a shared one — so a
   superseded call is aborted while the new one proceeds
   (`QueryPage.tsx:640,652`).
4. A `useEffect(() => () => abortRef.current?.abort(), [])` aborts on unmount
   (`QueryPage.tsx:634-636`).
5. **`AbortError` is swallowed** by the hook's internal `.catch`: if
   `(e as Error).name === "AbortError"` the returned promise resolves to a
   sentinel (`undefined`) rather than rejecting, so a superseded request never
   flashes an error (`QueryPage.tsx:657-659`). Non-abort errors still reject.
6. A small companion, `useAbortableQuiet()`, returns the same runner but with a
   typed `T | undefined` result for the common "ignore the aborted case" call
   site.

**Preferred usage:**

```tsx
const run = useAbortable()
const load = useCallback(() => {
  void run((signal) => getFindings({ search, page, limit: pageSize }, { signal }))
    .then((res) => { if (res !== undefined) { setFindings(res.items); setTotal(res.total) } })
}, [run, search, page, pageSize])
useEffect(() => { void load() }, [load])
```

### 4.3 `useGeneration()` — for discarded-cleanup paths

Iteration-2: because `useAutoRefresh` discards the callback's returned cleanup
(`lib/utils.ts:57-63`), an abort-on-cleanup cannot run there. For these paths a
**monotonic generation guard** is the correct mechanism: it does not cancel the
in-flight request, it discards its result if a newer generation has started.

**Signature (exact):**

```ts
/** A monotonically increasing generation counter. `next()` claims a new
 *  generation and returns its id. `isCurrent(g)` is true only while `g` is
 *  still the newest claimed generation. */
export function useGeneration(): {
  next: () => number
  isCurrent: (g: number) => boolean
}
```

**When to prefer it over `useAbortable`:**

- The callback returns a cleanup that is **discarded** by its caller — the
  `useAutoRefresh` poll paths (Audit §3.5), and
  `QueryPage.tsx:681 useEffect(() => fetchQuery(), [fetchQuery])` which discards
  the returned cleanup.
- The request is a **poll tick that should *skip*, not abort** when a newer tick
  is due (Audit §4.5.3) — the older tick is allowed to finish; its result is
  merely ignored.
- The request is a **read whose result is still wanted** but must be ordered
  behind a newer one.

Rule of thumb: **`useAbortable` when the superseded work is worthless and should
stop; `useGeneration` when the superseded work may finish but must not win.**

### 4.4 `useAutoRefresh` fix — a slow tick must *skip*, not overlap

**Today** (`lib/utils.ts:35-66`): the interval callback
`() => { if (document.visibilityState !== "hidden") refresh() }` (`:59-61`) is
fire-and-forget; it neither awaits nor tracks the previous call, and the
callback's return value is discarded.

**API change (exact).** `refresh` is permitted to return a promise; the hook
tracks in-flight state and **skips** a tick while one is running. The
localStorage persistence and visibility behaviour are unchanged.

```ts
export function useAutoRefresh(
  /** May be sync (legacy) or async. While a returned promise is pending,
   *  the next tick is SKIPPED (not queued, not aborted). */
  refresh: () => void | Promise<unknown>,
  key: string,
  defaultSeconds = 0,
): { refreshSeconds: number; setRefreshSeconds: (s: number) => void }
```

Body change (only the interval effect):

```ts
const inFlightRef = useRef(false)
useEffect(() => {
  if (!refreshSeconds) return
  const id = window.setInterval(() => {
    if (document.visibilityState === "hidden") return   // unchanged: skip hidden
    if (inFlightRef.current) return                     // NEW: skip while a tick is in flight
    const out = refresh()
    if (out && typeof (out as Promise<unknown>).then === "function") {
      inFlightRef.current = true
      void Promise.resolve(out).finally(() => { inFlightRef.current = false })
    }
  }, refreshSeconds * 1000)
  return () => window.clearInterval(id)
}, [refreshSeconds, refresh])
```

Why **skip** and not abort (Audit §4.5.3): aborting every tick would defeat a
periodic refresh against a slow backend — the exact wall-display scenario the
loading module was built for (`loading/index.tsx:4-6`). A skipped tick is honest:
the next tick fires normally. This single change fixes the three overlapping poll
sites (Analytics/Dashboard/Findings — Audit §3.5) and leaves `QueryPage.tsx:685`
correct as-is (its callback already aborts, so `inFlightRef` is moot but harmless).

The returned promise is what the callbacks must now return: `fetchAll`
(`AnalyticsPage.tsx:167-193`), `refreshAll` (`DashboardPage.tsx:163-166`) and
`refetch` (`FindingsPage.tsx:340-376`) become `async` and `return` their request
promise.

### 4.5 Migration table — every race site (Audit §4.3.5)

**Unguarded, user-keyed (highest risk — do first):**

| # | Site | Mechanism | Risk |
|---|---|---|---|
| 1 | `AnalyticsPage.tsx:194-196` (`fetchAll`, 5 requests) | `useAbortable` + `Promise.all` with the same signal on all five; `useGeneration` on the poll path | Medium — 5 parallel reads share one signal; a range change must abort all five |
| 2 | `AnalyticsPage.tsx:222-224` (`fetchRaw`) | `useAbortable` | Medium — rawSearch is **not** debounced (`AnalyticsPage.tsx:201-210`); every keystroke re-fires |
| 3 | `PatternTable.tsx:209-211` (`fetchPatterns`) | `useAbortable` | Low–Medium — debounced; filter/page/sort dep changes race |
| 4 | `AttckFleetPage.tsx:241-243` (`fetchFleet`) | `useAbortable` | Medium — time-range change can land a stale mapping |
| 5 | `UrlInvestigationPage.tsx:122-126` → `investigate` (`:98-116`) | `useAbortable`; `getUrlBreakdown` needs the signal (§4.1) | High — no guard at all; selected URL keyed |
| 6 | `HostInspectorPage.tsx:394-399` (`lookup`) | `useAbortable` + `useGeneration` (lookup fires 3 chained reads) | **Highest** — see §6 |
| 7 | `HostInspectorPage.tsx:409-427` (Live/Findings `getClientReport`) | `useAbortable` | High — toggle keyed, eslint-disabled deps |
| 8 | `HostInspectorPage.tsx:430-446` (`fetchHostSections`) | `useAbortable` | High — toggle keyed |
| 9 | `HostInspectorPage.tsx:556` (`fetchRaw`) | `useAbortable` | Medium |

**Guarded-but-racy, user-keyed (per-invocation `cancelled` only):**

| # | Site | Mechanism | Risk |
|---|---|---|---|
| 10 | `FindingsPage.tsx:378-381` (`refetch`) | `useAbortable` + `useGeneration` (also a poll target) | Medium — cleanup discarded by `useAutoRefresh` |
| 11 | `LogsPage.tsx:611` (`load`) | `useAbortable` | Low–Medium |
| 12 | `RedirectsPage.tsx:393` (`loadTable`) | `useAbortable` | Low–Medium |
| 13 | `RedirectsPage.tsx:394` (`loadGraph`) | `useAbortable` | Low — not user-keyed, still uncancellable |
| 14 | `HostInspectorPage.tsx:450-466` (`getHostProfile`) | `useAbortable` | Medium |
| 15 | `ReportPage.tsx:323-356` (up to 5 parallel reads) | `useAbortable` (one shared signal) + keep the shared `cancelled` | Medium — one abort must cover all five |

**Poll callbacks:**

| Site | Mechanism | Risk |
|---|---|---|
| `AnalyticsPage.tsx:198` | `useAutoRefresh` in-flight skip + `useGeneration` | Low once §4.4 lands |
| `DashboardPage.tsx:167` | `useAutoRefresh` in-flight skip + `useGeneration` on `fetchRecent` | Low — `fetchRecent`'s guard is currently discarded (Audit §3.5) |
| `FindingsPage.tsx:384` | `useAutoRefresh` in-flight skip + `useAbortable` in `refetch` | Medium — also races the debounced-search effect |
| `QueryPage.tsx:685` | **leave as-is** — already correct (`:639` aborts) | none |

**Low risk (not user-keyed):**

| Site | Mechanism | Risk |
|---|---|---|
| `DashboardPage.tsx:131-135,161` | `useAbortable` (optional) | Benign but uncancellable/overlappable |
| `BlacklistPage.tsx:376-379` (`load`) | `useGeneration` for the post-mutation re-load | Low — re-called after writes; must not cancel the writes |
| `JaillistPage.tsx:92-95` (`load`) | `useGeneration` | Low |

**Explicitly NOT migrated:** `ReportPage.tsx:315-321` `probeEsHealth` (§5.4);
`RedirectsPage.tsx:437-439` background check poll (§5.2);
`FindingsPage.tsx:386-411` `refetchIndexes` (decoration; leave silent — Audit §4.4).

### 4.6 The "never blank good data on a failed refetch" rule

**Rule R-NB.** A read that has already produced data keeps it on screen across a
subsequent **failed** attempt. A failed refetch sets an error cue; it must not
call `setX([])` / `setX(null)` on data the operator is reading.

Two violating sites (Audit §4.1 honourable mention):

- **`FindingsPage.tsx:360-363`** — the `.catch` does
  `setFindings([]); setTotal(0); setError(...)`. On a failed *interval tick* after
  a good load, the table blanks. **Fix:** guard the reset with the first-load ref:

  ```ts
  if (!cancelled) {
    if (!loadedRef.current) { setFindings([]); setTotal(0) }  // first load only
    setError((e as Error).message)
  }
  ```

  (`loadedRef` already exists at `FindingsPage.tsx:319`.) Keep the error cue;
  keep the rows.

- **`QueryPage.tsx:666`** — the `.catch` does `setResult(null)` on any non-abort
  error. After a good `result`, a failed refetch blanks the whole page. **Fix:**

  ```ts
  // only a failed FIRST load has nothing to keep
  if (firstLoad) setResult(null)
  setError(...)
  ```

  `firstLoad` is already tracked (`QueryPage.tsx:600,672`). The existing
  `AbortError` early-return at `:659` already prevents the aborted case from
  reaching this line.

Companion rule: the `RedirectsPage` history drawer ordering
(`RedirectsPage.tsx:610-611`, `setHistory(null)` **before** `setHistoryLoading(true)`)
guarantees it can never keep content. **Fix:** null only when there is nothing to
keep (a target change), not on the same-target reopen:

```ts
if (historyTarget?.id !== target.id) setHistory(null)
setHistoryLoading(true)
```

so the `edge-list` skeleton from §3.2 is a first-open affordance, and a reopen
dims-and-cues like every other refetch.

---

## 5. Where NO change is made (do-not-touch list)

Audit §4.5, restated as an explicit contract. Cancellation applies **only to
superseded reads**, never to writes or to work whose result is still wanted.

1. **Mutations must never be aborted mid-flight.** Do **not** thread an abort
   signal into any POST/PUT/DELETE reader. The `busy`-flag design (disable
   controls, never blank content) is correct and stays. Concretely do-not-touch:
   blacklist/jaillist add/delete/clear (the `busy` write paths;
   `BlacklistPage.tsx:466` re-load after a write), Findings
   delete/clear/bulk (driven by `busy`), `RedirectsPage` delete
   (`RedirectsPage.tsx` delete handler), `LogsPage` clear/delete,
   `BackupPanel` export/restore (`exporting`/`working`), `login`
   (`api.ts:454-468`), backup export (`api.ts:2239`). The re-load *after* a write
   may use `useGeneration` (ordering), but the write itself gets no signal.
2. **`checkRedirectsBackground` is fire-and-forget by design.**
   `api.ts:1494`; the page polls `getRedirectCheckStatus`
   (`RedirectsPage.tsx:437-439`). The background **job** must not be cancelled.
   The poll **read** may be aborted on unmount (`getRedirectCheckStatus` at
   `api.ts:1502` gets `ReqOpts`), but the timer cleanup at `RedirectsPage.tsx:437-439`
   keeps running so the server-side job completes.
3. **The auto-refresh poll must be allowed to complete, not aborted, when another
   tick is merely due.** Correct behaviour is **skip** the new tick (§4.4) — never
   `abort()` the older one. This is why `useAutoRefresh` uses an in-flight *flag*,
   not a controller.
4. **`probeEsHealth` is never cancelled.** `ReportPage.tsx:315-321`, `api.ts:507-521`.
   It is a cheap reachability probe whose result is provenance metadata; aborting
   it saves nothing and risks a report claiming "unknown (not probed)". It gets
   **no** `ReqOpts`. `getOperatorZone` (`api.ts:2427`) is the same kind of cheap
   provenance read and is likewise left signal-free.
5. **Writes never receive `opts?: ReqOpts`.** Rule R-C2 + the `ReqOpts` type
   (§4.1) make this a type-level guarantee, not a convention.

---

## 6. Migration batches

Ordered, independently shippable. Each batch is `tsc --noEmit` + lint green on
its own. **Files that must not be edited concurrently** are called out — one
integration owner per file.

### Batch 0 — Primitives (purely additive)

**Files:** `components/ui.tsx` (+ `SkeletonShape`, `TableSkeleton`, and the
`DENSITY_PAD` export shared with `DataTable`), `index.css` (the §3.4 shimmer
change only). Nothing consumes the new primitives yet; the app is unchanged.
**Do not touch `DataTable.tsx` in this batch** (it is touched in Batch 2).
Ship: two new exports + one CSS line.

### Batch 1 — Cancellation infra (additive, no call sites)

**Files:** `lib/utils.ts` (`useAbortable`, `useGeneration`, the `useAutoRefresh`
in-flight change), `api.ts` (add `export type ReqOpts`; add optional
`opts?: ReqOpts` and forwarding to every reader in §4.1; route the direct
`fetch()` readers through `request()`). No page consumes the hooks yet, so the
behaviour change is limited to `useAutoRefresh` (safe: it only adds a skip).
Ship: types + hooks + threaded readers.

**Do not edit `api.ts` concurrently with any page** — pages in Batch 3 depend on
the exact reader signatures Batch 1 freezes.

### Batch 2 — Shape adoption where the primitive already owns the markup

**Files:** `components/DataTable.tsx` (render its skeleton through
`TableSkeleton`; `skeletonRows` becomes an override). Then the pages whose
first-load branch is a single delegated table that just needs the primitive, and
the two no-loading gaps:
`QueryPage.tsx:1187` (pass `loading={firstLoad && loading}` — Audit §4.4),
`DashboardPage.tsx:298` (`SkeletonShape variant="feed-list"`/table mirror) and
the two bare-dash stat gaps (`DashboardPage.tsx:234,248` → a `stat-grid` of the
real grid, or a delayed `LoadingIndicator` — Audit §4.4).
Ship: `DataTable`'s one-implementation refactor + Dashboard no-loading gaps.

### Batch 3 — Shape adoption for the 11 wrong-shape sites

**Files, one owner each (do not parallel-edit a file):**
`QueryPage.tsx` (the §3.3 composition — highest value),
`AttckFleetPage.tsx:293` + `AttckPanel.tsx:68` (`panel-stack`),
`LogsPage.tsx:738` (`TableSkeleton`, and it must stop pre-empting `DataTable`),
`AnalyticsPage.tsx:714-715,729-730` (`chart`), `:752,:768` (pass `columns` with a
width for every column), `RedirectsPage.tsx:732` (`dag`) + `:926` (`edge-list`) +
the `openHistory` ordering fix (§4.6), `BlacklistPage.tsx:229` (`feed-list`,
inherited by Jaillist via `FeedCard`), `HostInspectorPage.tsx:1049-1050,1098,1117`,
`ReportPage.tsx:448,461,479,535,560`.
Ship: all 11 wrong-shape sites replaced.

### Batch 4 — Cancellation adoption (unguarded, user-keyed first)

In the Audit §4.3.5 order (highest risk first): the five pages with **no guard
at all** — `AnalyticsPage.tsx`, `PatternTable.tsx`, `UrlInvestigationPage.tsx`,
`AttckFleetPage.tsx`, `HostInspectorPage.tsx`. One file per owner. Then the
guarded-but-racy set — `FindingsPage.tsx`, `LogsPage.tsx`, `RedirectsPage.tsx`,
`ReportPage.tsx`. Finally the poll callbacks (§4.4 call-site updates:
`AnalyticsPage.tsx:198`, `DashboardPage.tsx:167`, `FindingsPage.tsx:384`).
Include the two "never blank" fixes (§4.6: `FindingsPage.tsx:360-363`,
`QueryPage.tsx:666`) — these are small and belong with the page they fix.

**Do not edit `api.ts` in this batch** (frozen by Batch 1); if a reader turns out
to need a signal that Batch 1 missed, that is a Batch-1 amendment, sequenced
before Batch 4's dependent page.

**Files that must never be touched concurrently across batches:**
`DataTable.tsx` (Batch 2 only), `api.ts` (Batch 1 only; amendments sequenced),
`lib/utils.ts` / `index.css` (Batch 0/1 only), and any single page file
(one owner per batch).

### Batch 5 — Verification / hardening (no new behaviour)

**Files:** none (or a `scripts/verify-loading.sh`). Run the §7 checks; add the
grep gates to CI if the repo has one.

---

## 7. Acceptance criteria

Objective and checkable. All commands run from `admin-ui/`. Every criterion is
all-or-nothing.

1. **Every wrong-shape site replaced.** No first-load branch renders a bare
   `h-N w-full` block for a multi-panel/multi-row surface. The eleven Audit §4.1
   sites use `SkeletonShape`/`TableSkeleton`:

   ```bash
   grep -rnE '<Skeleton className="h-(24|28|32|40|48|56|60|64|96)[^"]*w-full"' \
     src/components --include='*.tsx' | grep -v 'components/ui.tsx'
   ```
   → **expect zero matches** outside `ui.tsx` (the primitive's own internals).
   (Grep for the whole family, not only the `h-40`/`h-56`/`h-64` the brief names,
   because the audit ranks `h-24`/`h-32`/`h-48`/`h-60` too.)

2. **No raw tall block standing in for a multi-panel surface.**

   ```bash
   grep -rnE 'h-(40|56|64)([^0-9]|$)' src/components --include='*.tsx' \
     | grep 'Skeleton'
   ```
   → **expect zero matches**. (A legitimately single-panel surface, if any
   remains, must switch to `SkeletonShape` and be listed in the PR body — there
   is no such legitimate case today.)

3. **Every user-keyed request has a signal or a generation guard.** For each
   file in the §4.5 migration table, the request call site is inside a
   `useAbortable`/`useGeneration` construction:

   ```bash
   grep -rnE 'AbortController|useAbortable|useGeneration|signal:' src/components src/lib --include='*.tsx' --include='*.ts' \
     | grep -vE 'components/loading|DataTable' | wc -l
   ```
   → **≥ 16** (was 1). Manual cross-check: every row of the §4.5 table appears
   with a mechanism.

4. **NO write path accepts a signal.**

   ```bash
   # Every mutation signature must be free of ReqOpts / signal.
   grep -rnE '(create|update|delete|add|set|clear|import|restore|sync|login)\w*\(' src/api.ts \
     | grep -E 'ReqOpts|signal'
   ```
   → **expect zero matches**. Additionally:
   ```bash
   grep -n 'export type ReqOpts' src/api.ts && \
   grep -c 'opts?: ReqOpts' src/api.ts
   ```
   → the type exists and the count equals the number of read readers in §4.1
   (documented in the PR).

5. **`useAutoRefresh` cannot overlap.**

   ```bash
   grep -n 'inFlightRef' src/lib/utils.ts
   ```
   → the in-flight flag appears (declaration + the `if (inFlightRef.current) return`
   skip + the `.finally` reset). Manual test: set the interval to 1s against a
   >1s endpoint and confirm ticks skip rather than pile up (network panel shows
   non-overlapping requests).

6. **No `let cancelled`-only guard remains on a user-keyed request.** Every
   site in §4.5 that today relies solely on `cancelled` also has an abort or a
   generation guard:

   ```bash
   grep -rn 'let cancelled' src/components --include='*.tsx' \
     | grep -vE 'QueryPage'   # QueryPage is already correct
   ```
   → each remaining match is in a file that also contains `useAbortable` or
   `useGeneration` (or is on the do-not-touch list §5).

7. **Build / lint / typecheck green.**

   ```bash
   npx tsc --noEmit && npm run lint && npm run build
   ```

8. **Honest-loading invariants preserved.** `components/loading/index.tsx`
   still exports `LoadingIndicator`, `LOADER_DELAY_MS = 250`,
   `LOADER_MIN_VISIBLE_MS = 400`; the `role="status"` announcement and the
   10s/45s phases are unchanged; no synthesised percentage appears anywhere:

   ```bash
   grep -rn '%' src/components/loading --include='*.tsx' | grep -vi 'percent\|progress\|width'
   ```

9. **Motion safety preserved.** `index.css:170` (`html[data-paused] *`) and
   `index.css:173-175` (`prefers-reduced-motion`) are unchanged, and every new
   primitive is CSS-only (no framer-motion):

   ```bash
   grep -rn 'framer-motion' src/components/ui.tsx
   ```
   → **expect zero matches**.

---

## Appendix — anchor index

| Topic | Anchor |
|---|---|
| Shimmer source (single) | `index.css:167-168`; guards `:170`, `:173-175` |
| `Skeleton` primitive | `ui.tsx:435-441` |
| `DataTable` row skeleton | `DataTable.tsx:1224-1240`; header `:1146-1219`; `DENSITY_PAD` `:368-371` |
| `DataTable` refetch loader | `DataTable.tsx:192-203`, `:1133-1145` |
| Reference cancellation | `QueryPage.tsx:633-676` |
| `request()` spread | `api.ts:472-489` (`...opts` at `:477`) |
| `runQuery` signal | `api.ts:292-312` |
| `useAutoRefresh` | `lib/utils.ts:35-66` |
| Canons extended | `component-canon.md` §1 (visual lockup), §3.16 (`Skeleton`); `table-revamp-spec.md` §2 |
| Do-not-touch | `loading-audit.md` §4.5; this doc §5 |
| Wrong-shape ranked list | `loading-audit.md` §4.1 |
| Race-site list | `loading-audit.md` §3.4, §4.3.5 |
