# Query-page layout-shift (CLS) fix — independent verification

**Scope:** READ-ONLY verification of the header-status-slot CLS fix in `admin-ui`
(React 19 + TS + Tailwind v4). All writers had stopped. No file in `admin-ui/` was modified
by this review; the only file written is this report.

**Verdict up front: PARTIALLY FIXED.** The three cited header slots are genuinely fixed
(byte-identical classes, always mounted). But (1) one *other* page (`LogsPage.tsx`) still has
the original defect unfixed, and (2) within `QueryPage` itself a **refetch** still shifts
content because the refetch banner is inserted as a new block in the vertical flow.

---

## Step 1 — Gates (raw output + exit codes)

### `npm run build`
```
> tsc -b && vite build

vite v8.2.0 building client environment for production...
transforming...✓ 2901 modules transformed.
rendering chunks...
computing gzip size...
dist/index.html                                 1.49 kB │ gzip:   0.66 kB
dist/assets/index-DKd5sC8A.css                 56.22 kB │ gzip:  10.34 kB
dist/assets/QueryPage-By4vCG2P.js              33.58 kB │ gzip:  10.02 kB
…
✓ built in 1.41s
```
**exit code: 0**

### `npm run lint`
```
23 diagnostics in 11 files
src/components/SankeyDiagram.tsx (5 diagnostics)
  25:3: warning react(only-export-components): …
  … (all 23 are `react(only-export-components)` fast-refresh warnings)
src/components/ui.tsx (1 diagnostics)
  891:17: warning react(only-export-components): …
```
**exit code: 0** — 23 warnings, 0 errors. All 23 are pre-existing `only-export-components`
warnings; **none are in QueryPage.tsx / PatternTable.tsx / AnalyticsPage.tsx**, so **0 new warnings**.

### `npx tsc -b --noEmit`
```
(no output)
```
**exit code: 0**

### `git -C /home/x0art/Project/uNetWatch status --short`
```
 M admin-ui/src/components/AnalyticsPage.tsx
 M admin-ui/src/components/PatternTable.tsx
 M admin-ui/src/components/QueryPage.tsx
?? brag-output/
```
- Modified files are **exactly** the three expected. `brag-output/` is outside `admin-ui/`.
- **No new/deleted files** in `admin-ui/` (`git status --short -- admin-ui` shows only the 3 `M`).
- **`lib/useMediaQuery.ts` does NOT exist** — confirmed both by directory listing
  (`src/lib/` contains only `echartsTheme.ts`, `logRow.ts`, `utils.ts`) and by a
  repo-wide `find … -name 'useMediaQuery*'` that returned nothing. Its responsive mode is
  pure CSS, as claimed.

---

## Step 2 — The fix is real, in the code

All three slots live as the **last child** of a `PageHeader` children row.
`PageHeader` (`ui.tsx:951`) renders children as:
```jsx
{children && <div className="flex flex-wrap items-center gap-2">{children}</div>}
```
A `flex-wrap` row, so inserting/removing one child genuinely re-wraps it — the original diagnosis.
The row's cross-axis alignment is `items-center`; **the row's height is the natural maximum of its
items' heights (the tallest control, not the content), and `basis-full` forces the slot onto its
own line, so the slot can never raise the row above the controls' height** (see Step 2.5).

### 2.1 Always-mounted proof

**QueryPage.tsx `:901-922`**
```jsx
        <span
          className="order-last flex h-5 basis-full items-center gap-1.5 text-xs font-medium text-muted-foreground lg:order-none lg:h-auto lg:basis-auto lg:w-52 lg:min-w-52"
          aria-hidden="true"
        >
          {loading && (
            <>
              <LoadingIcon className="h-3.5 w-3.5" />
              Querying Elasticsearch · <span className="font-mono tabular-nums">{queryElapsed}</span>
            </>
          )}
        </span>
        {/* Fixed label + fixed min-width: … */}
        <Button className="min-w-24" aria-busy={loading} onClick={handleRun} disabled={loading}>
          {loading ? <LoadingIcon /> : <Play className="h-4 w-4" />}
          Run
        </Button>
        <Button className="min-w-28" variant="outline" size="sm" aria-busy={loading} onClick={handleRun} disabled={loading}>
          {loading ? <LoadingIcon /> : <RefreshCcw className="h-4 w-4" />}
          Refresh
        </Button>
```

**PatternTable.tsx `:400-410`**
```jsx
        <span
          className="order-last flex h-5 basis-full items-center gap-1.5 text-xs font-medium text-muted-foreground lg:order-none lg:h-auto lg:basis-auto lg:w-52 lg:min-w-52"
          aria-hidden="true"
        >
          {loading && (
            <>
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              Loading patterns · <span className="font-mono tabular-nums">{elapsed}</span>
            </>
          )}
        </span>
```

**AnalyticsPage.tsx `:654-664`**
```jsx
        <span
          className="order-last flex h-5 basis-full items-center gap-1.5 text-xs font-medium text-muted-foreground lg:order-none lg:h-auto lg:basis-auto lg:w-52 lg:min-w-52"
          aria-hidden="true"
        >
          {loading && (
            <>
              <Activity className="h-3.5 w-3.5 animate-pulse" />
              Loading analytics · <span className="font-mono tabular-nums">{elapsed}</span>
            </>
          )}
        </span>
```

**Proof of always-mounted:** in every file the `{loading && ( … )}` guard is *inside* the `<span>`
and wraps a fragment (`<>…</>`) — the `<span>` itself is a plain, unconditional sibling of the
buttons. There is no `{loading && <span>…</span>}` anywhere in these three files (verified by
grep, see Step 3.1). The `<span>` element is always present in the rendered tree, so the flex
child sequence is constant; only its text children change. **PASS.**

### 2.2 Class string identical across the three files — PASS

Extracted each `className` and compared byte-for-byte:

| file | length | sha1[0:16] |
|---|---|---|
| QueryPage.tsx | 151 | `2283a8b7a23126a6` |
| PatternTable.tsx | 151 | `2283a8b7a23126a6` |
| AnalyticsPage.tsx | 151 | `2283a8b7a23126a6` |

**All three class strings are byte-identical (same length, same SHA-1; `ALL IDENTICAL: True`).**
No whitespace, ordering, or token difference.

### 2.3 Class string identical in BOTH loading states — PASS

The `className` is a **single string literal** — there is no ternary, no `cn(...)` call, and
no `loading` reference anywhere on that line in any of the three files. The `loading` flag is
referenced only *inside* the JSX children. Therefore the computed class list is invariant with
respect to `loading` by construction. Additionally, the only difference between the two states is
the presence of the icon + text nodes inside the span, and the span is a **flex container with
`h-5`/`lg:h-auto` + `basis-full`/`lg:h-auto` + `lg:w-52 lg:min-w-52`**: neither the row's line
structure (it is `basis-full`, always its own line below `lg`; `lg:w-52 lg:min-w-52`, always a
fixed 208 px box at/above `lg`) nor the row's height can change. **PASS.**

### 2.4 The QueryPage buttons cannot resize — PASS (with a nuance)

- **(a) Constant labels.** `:919` renders literal `Run`; `:922` renders literal `Refresh`. No
  ternary on the label text (unlike the old "Run"→"Running…"). **PASS.**
- **(b) Icon and spinner occupy the same box.** `LoadingIcon` (`ui.tsx:96-98`) is
  `<Loader2 className={cn("h-4 w-4 animate-spin", className)} />` → default **`h-4 w-4` (16×16)**.
  The icons are `<Play className="h-4 w-4" />` and `<RefreshCcw className="h-4 w-4" />` →
  **`h-4 w-4` (16×16)**. **Identical (16 px). PASS — no size mismatch between spinner and icon.**
- **(c) `min-w-*` pin.** Run has `min-w-24` (96 px); Refresh has `min-w-28` (112 px). Both are
  emitted in the built CSS (`.min-w-24`, `.min-w-28`). **PASS.**

Nuance (not a defect): the header Refresh is `size="sm"` → `h-8 px-3 text-sm` (`ui.tsx` `buttonSizes`),
while the header Run has no `size` prop → **default `h-9 px-4 py-2 text-sm`**. So Run and Refresh are
different heights (36 px vs 32 px) by design. At a `flex-wrap` break the row height therefore jumps
32 ↔ 36 px when items wrap/unwrap. That is independent of `loading` (Run never moves), and at `lg`
the row never wraps (see 2.5), so it is a responsive-only artifact, not the reported shift. The
`h-4` spinners are correctly chosen for both.

### 2.5 `h-5` adequate AND constant — PASS

- Slot contents: icon `h-3.5 w-3.5` = **14 px**; text `text-xs` with default line-height
  `text-sm/normal`-family ≈ **16 px**. `h-5` = `calc(var(--spacing) * 5)`; with Tailwind v4's
  `--spacing: 0.25rem` and `1rem = 16px` → **20 px**. 20 px ≥ max(14, ≈16) with `items-center`
  centering the rest → **no clipping**.
- **Same `h-5` when empty:** because `h-5` is on the constant class string and the span is always
  mounted, the 20 px box is reserved in both states. **Constant across states.**
- **`lg:h-auto` cannot change the row height:** `@media (width>=64rem)` (`lg` = 64rem = **1024px**,
  confirmed in the built CSS) applies `lg:order-none lg:h-auto lg:basis-auto lg:w-52 lg:min-w-52`.
  At `lg` the slot drops its 20 px fixed height (`h-auto`) **but** it is `basis-auto` and sits on the
  same `items-center` line as the controls, whose heights are `h-8` (32 px) / `h-9` (36 px) — both
  taller than 20 px. Under `items-center` the flex line's height is the max of item heights and the
  span contributes ≈16 px (its text), so **the row height at `lg` is governed by the buttons/selects,
  not by the slot.** Also, at `lg` the row never wraps (content is tiny vs ≥1024px), so the slot
  cannot push a control to a second line and does not move. **PASS.**

---

## Step 3 — Remaining shift sources (adversarial hunt)

### 3.1 Every `{loading|refreshing|busy &&}` in `src/components/**`, classified

Grep hit list, then classified by whether the conditional sits **inside a `PageHeader`/`Toolbar`
children row** (a `flex flex-wrap` that re-wraps on insertion) vs **body-only** vs **safe**
(inside a `Panel` body section, a full-width skeleton stack, `sr-only`, or a prop pass-through):

| file:line | conditional element | container | classify | shifts? |
|---|---|---|---|---|
| `LogsPage.tsx:707` | status `<span>` `<RefreshCcw h-3.5 w-3.5 animate-spin/> Loading logs · …` | **`PageHeader` children row** (`:681-730`) | **in-header** | **YES — re-wraps row, moves Refresh/Clear-all** |
| `LogsPage.tsx:738` | `<LoadingIndicator>` | body (`space-y-5` root) | body-only | YES (block insertion, see 3.3) |
| `RedirectsPage.tsx:704` | status `<span>` `inline-flex … Loading tracked URLs · …` | **`PageHeader` children row** (`:684-724`) | **in-header** | **YES — re-wraps row, moves Track URL / Check now / Refresh** |
| `RedirectsPage.tsx:844` | `<LoadingIndicator>` | body | body-only | YES (block insertion) |
| `AnalyticsPage.tsx:703` | `<LoadingIndicator>` | body | body-only | YES (block insertion) |
| `FindingsPage.tsx:648` | status `<span>` `inline-flex … Refreshing findings · …` | **`PageHeader` children row** (`:616-662`) | **in-header** | **YES — re-wraps row, moves Refresh / Clear all / interval select** |
| `FindingsPage.tsx:681` | `<LoadingIndicator>` | body | body-only | YES (block insertion) |
| `BlacklistPage.tsx:217` | status `<span>` `Refreshing feed…` | card `<div>` body (`PageHeader` self-closes at `:555`) | body-only (own line) | container owns full width → **minor/no** (~2px) |
| `AttckFleetPage.tsx:304` | `<div>` skeleton | body (after `PageHeader`) | body-only | YES (block insertion, full content replacement) |
| `AttckPanel.tsx:65` | `<div>` skeleton | `Panel` body children | safe | Panel body swap |
| `QueryPage.tsx:905 / :983 / :1038` | status `<span>` / skeleton / `<LoadingIndicator>` | in-header slot (**fixed**) / body / body | fixed / body | 905 no; 983, 1038 body insertion |
| `HostInspectorPage.tsx:1102` | `<LoadingIndicator>` + skeleton | page body (after header) | body-only | YES (block insertion) |
| `HostInspectorPage.tsx:1147,1160,1179,1196,1229` | `{sectionsLoading && …}` | `Panel`/section bodies | safe | section body |
| `ReportPage.tsx:511,524,542` | badge/`{…loading}` | page body / header badge | in-header **badge** | badge width can jitter (`loading`/`ok`/`unavailable`) but no flex-item insertion; low |
| `DataTable.tsx:1038/1049` | `aria-label` + `<span class="hidden sm:inline">{loading ? "Refreshing" : "Refresh"}</span>` | DataTable toolbar | **in-header (toolbar)** | no re-wrap; fixed `min`-ish button, see 3.2 |
| `PatternTable.tsx:422/435`, `RedirectsPage.tsx:871`, `AnalyticsPage.tsx:783/799`, `BlacklistPage.tsx:623/648`, `JaillistPage.tsx:317`, `DashboardPage.tsx:327`, `QueryPage.tsx:1038` | `loading={…}` prop / skeleton swap in panel body | panel/table body | safe | body-only |
| `AddBlacklistDialog.tsx:73`, `AddJaillistDialog.tsx:73`, `AddPatternDialog.tsx:85` | `{saving && <Loader2 …/>}` | dialog footer, inside a `Button` | safe | inside button label area |
| `UrlInvestigationPage.tsx:323` | `{loading && !result ? <skeleton> : …}` | body | body-only | YES (branch swap) |
| `UrlInvestigationPage.tsx:304-305` | button `{loading ? <LoadingIcon/> : <Search h-4/>}` + `{loading ? "Investigating..." : "Investigate"}` | form row (`rounded-md … p-4`, **not** `PageHeader`) | form-row | **YES, can resize** (no `min-w`; text widens) |
| `HostInspectorPage.tsx:1082-1083` | button `{loading ? <LoadingIcon/> : <Search h-4/>}` + `{loading ? "Looking up..." : "Lookup"}` | form row (not `PageHeader`) | form-row | **YES, can resize** |

**Confirmed remaining in-header conditional insertions (the original bug, still present):**
- `LogsPage.tsx:707`
- `RedirectsPage.tsx:704`
- `FindingsPage.tsx:648`

All three use the *old* markup — `{loading && (<span className="inline-flex items-center gap-1.5
text-xs font-medium text-muted-foreground" aria-hidden="true"> … </span>)}` — i.e. a flex item
inserted/removed inside `PageHeader`'s `flex flex-wrap items-center gap-2` row. This is the same
trigger that was fixed in the three target files.

### 3.2 Buttons whose label/icon changes with a loading flag

| file:line | button | resizes? | why |
|---|---|---|---|
| `QueryPage.tsx:1112-1113` | **Sankey "Traffic flow" panel action**: `{loading ? <LoadingIcon/> : <RefreshCcw h-4/>}` + `{loading ? "Refreshing…" : "Refresh"}` | **YES, can resize** | (i) label text flips `Refresh`(≈50px) ↔ `Refreshing…`(≈76px) — old "Resize" defect; (ii) no `min-w`; (iii) `LoadingIcon` default **`h-4`** vs `RefreshCcw h-4` → icons match at 16px, but **text width changes**, so the button widens. Container is the panel's `actions` (a `flex flex-wrap items-center gap-2` row inside a `Toolbar`) → this is the row that re-wraps. |
| `DataTable.tsx:1038/1049` | toolbar Refresh | **no** | label `<span className="hidden sm:inline">{loading ? "Refreshing" : "Refresh"}</span>` changes width, but the button is **not** in a `PageHeader`; it is the last item in the DataTable toolbar, so width change does not re-wrap a header. Visual width change still occurs (low severity). |
| `UrlInvestigationPage.tsx:304-305` | Investigate | **YES** | `{loading ? "Investigating..." : "Investigate"}` + no `min-w`; form row `flex-wrap` → can re-wrap locally. |
| `HostInspectorPage.tsx:1082-1083` | Lookup | **YES** | `{loading ? "Looking up..." : "Lookup"}` + no `min-w`; form row. |
| `RedirectsPage.tsx:717-720` | "Check now" | **YES (unrelated to `loading`)** | `{checking ? "Checking in background" : "Check now"}` — keyed on `checking`, not `loading`, but the same text-width flip pattern inside the `PageHeader` row. |
| `QueryPage.tsx:1106` | Hide 1-hit toggle | minor | `{hideSingletons ? "Hiding 1-hit" : "Hide 1-hit"}` — width differs by ~7px; user-triggered, not loading. |

### 3.3 The QueryPage content region and the refetch banner

Structure of `QueryPage` return (`:821-…`):
```
<div className="space-y-5">                      // root
  <PageHeader …>…slot + Run + Refresh…</PageHeader>   // fixed
  <div className="grid grid-cols-2 … xl:grid-cols-6">  // 6 StatCards, always mounted
  {firstLoad ? (<>
      <LoadingIndicator active={loading} … />
      {loading && <div className="space-y-5"><SkeletonShape…/><TableSkeleton…/></div>}
  </>) : (
    <div className="space-y-6" aria-busy={loading}>
      {error && !loading && <Callout …/>}
      {loading && <LoadingIndicator label="Refreshing query" …/>}   // :1039
      <Panel title="Requests over time" …>…</Panel>
      <div className="grid …">…Top URLs / Top client IPs…</div>
      <Panel title="Traffic flow" … action={…} />                    // :1112 button
      …
    </div>
  )}
</div>
```

- **Toolbar independence:** the toolbar (PageHeader) is *above* all of this and its height depends
  only on its own children (fixed in the target files). The StatCard grid is a fixed-column grid.
  So the `firstLoad → content` swap cannot move the toolbar. **No toolbar movement.**
- **`LoadingIndicator` insertion on refetch — THIS IS A REMAINING SHIFT.**
  `LoadingIndicator` returns `null` until `useDelayedVisible` has been active ≥ **250 ms**
  (`delayMs = LOADER_DELAY_MS = 250`, `loading/useDelayedVisible.ts`), then renders a real block
  (`loading/LoadingIndicator.tsx`: `if (!show) return null;` then
  `<div className="animate-in flex flex-col gap-1.5 rounded-md border border-border bg-card px-3 py-2 shadow-sm">`).
  At `QueryPage.tsx:1039` this block is a direct child of the `space-y-6` stack (`:1022`), placed
  **before** the timeline/rankings/Sankey panels. So when a refetch starts and passes 250 ms, a
  ~66–70 px card is **inserted at the top of the stack**, pushing every panel below it down, and it
  is removed again when the read ends (kept ≥400 ms by `minVisibleMs`). That is a genuine,
  reproducible layout shift of all panel content at refetch start/stop.
  **file:line: `QueryPage.tsx:1039` (inside `space-y-6` at `:1022`) → YES, shifts.**
  The same pattern exists on other pages (`LogsPage.tsx:738`, `RedirectsPage.tsx:844`,
  `AnalyticsPage.tsx:703`, `FindingsPage.tsx:681`, `HostInspectorPage.tsx:1102`), all inserted as
  blocks in their page flow.
  Note the *header* slot (`:905`) does **not** have this problem — it is reserved and always mounted.

### 3.4 The 6 StatCards (`QueryPage.tsx:926-969`)

`value={result ? result.total_requests.toLocaleString() : "—"}` (and the other five). `StatCard`
(`ui.tsx:1350`) is `<div className="overflow-hidden rounded-md border … p-5 …">` with an inner
`<div className="mt-1 text-3xl …">{value}</div>` and a `shrink-0` `h-9 w-9` icon box. The card is a
grid item in `grid grid-cols-2 gap-4 lg:grid-cols-3 xl:grid-cols-6`. Grid columns are sized by the
track definition (2/3/6 equal columns), **not** by content: the grid's intrinsic content size can
exceed the track, but with equal `1fr` columns and `overflow-hidden` on the card the track width
does not change with the `"—"`↔number text, and there is no `inline-block`/`w-fit` that would
shrink-wrap. The value text wrapping (`—` is short; `12,345` is wider) changes the *number of
lines inside the card*, which can change the **card's height** only if a value wraps — with
`text-3xl` and a 6-column layout on a 1440 px shell, values like `12,345`/`1,234,567` fit one line,
so height is stable in practice. **Verdict: no horizontal resize; an improbable vertical shift only
if a very long formatted number wrapped in a narrow column — not observed in the code paths. PASS.**
(`AnimatedNumber` is only used when `value` is a `number`; here values are pre-stringified, so the
mono/`tabular-nums` class keeps digit widths constant anyway.)

---

## Verdict

**PARTIALLY FIXED.**

- The three cited header slots (`QueryPage.tsx:901-922`, `PatternTable.tsx:400-410`,
  `AnalyticsPage.tsx:654-664`) are **correctly fixed**: always-mounted `<span>`, byte-identical
  151-char class string in all three files, single-constant `className` independent of `loading`,
  constant button labels with `min-w-24`/`min-w-28`, `h-4` spinners matching `h-4` icons, `h-5`
  sufficiently tall and constant. Gate evidence: build 0, lint 23 warnings/0 new, tsc 0, only the
  3 expected modified files, no `useMediaQuery.ts`.
- The reported *symptom's* trigger is nonetheless **still live elsewhere**, and one *new* mechanism
  is present in QueryPage itself.

### Single most important remaining shift

**The QueryPage refetch banner is inserted into the content flow.**
`QueryPage.tsx:1039` — `{loading && <LoadingIndicator label="Refreshing query" … />}` — is a child
of the `space-y-6` stack at `:1022`, ahead of the timeline/rankings/Sankey panels. Because
`LoadingIndicator` returns `null` until ~250 ms, then mounts a bordered card (~66–70 px), **starting
a refetch pushes the entire panel region downward by one banner height, and ending it pulls it
back** — with the "—"/elapsed content inside the panels also changing. This is exactly
"the UI is shifted during refresh or loading," just vertical instead of horizontal.

### Runners-up (also real)

1. **`LogsPage.tsx:707`** — the original horizontal defect, unfixed: a `{loading && <span…>}` status
   item inside `PageHeader`'s flex-wrap row, so the Refresh / Clear-all buttons jump when a load
   starts. (`RedirectsPage.tsx:704` and `FindingsPage.tsx:648` are the same.)
2. **`QueryPage.tsx:1112-1113`** — inside the *same file*, the Sankey "Traffic flow" panel's Refresh
   button still flips its **label** `Refresh`↔`Refreshing…` (and has no `min-w`), so it resizes and
   can re-wrap the panel's `actions` row (a `Toolbar` `flex flex-wrap`). The header was fixed; this
   copy of the same pattern was not.

### Not verified without a browser
The exact pixel delta of the banner insertion (≈66–70 px) is derived from the banner's class
(`px-3 py-2`, `flex flex-col gap-1.5`, three text lines at `text-sm`/`text-xs`), not measured. The
claim that the StatCard value never wraps is reasoned from grid-column geometry, not observed. A
browser trace (or Playwright CLS assertion) would confirm both; the markup/CSS reasoning above is
unambiguous about *existence* of the shifts, only the magnitudes are estimated.
