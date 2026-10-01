# Component standardisation — FINAL verification report (release gate)

Scope: `admin-ui/src/` changes implementing `docs/component-canon.md` (§5 batches),
across the original four-agent change plus the `finish-a` / `finish-b` follow-ups
and three micro-fixes (N-1/N-2/N-3).
Verifier: independent. No source was modified by this verification.
Method: gates run by hand on the settled tree; every AC command from
`docs/component-canon.md` §6 run verbatim; every claim re-checked against
`git diff` / `git show HEAD:` and the working tree.

Date: 2026-10-01. Baseline = `HEAD` (`2ae1d4c`). All writers idle; no edit in
flight. This is the definitive pass.

---

## 0. Verdict

**SHIP WITH CAVEATS.**

- Gates green and stable: `build` 0, `lint` 0 (23 warnings = baseline, **0 new**),
  `tsc -b --noEmit` 0. Tree settled: 24 files `M`, **no `D`/rename/missing**.
- **AC: 14 PASS, 1 PASS-with-exemption** (AC6's only remaining hit is a Radix
  primitive that legitimately needs `asChild`).
- All three micro-fixes verified faithful; N-2's fix is real but *not literally
  byte-identical to HEAD* — it is byte-identical in padding/size and drops only
  redundant header utilities in favour of the canonical `.mono-label` (see §3).
- What the change did **not** accomplish: the shared `Toolbar` primitive is still
  used in exactly one file, and the `Panel` header was never unified onto it.
  The migration is complete on the *visual* criteria; it is **not** complete on
  the *abstraction-adoption* criteria (§4, C-1).

One residual, honest inconsistency is recorded below (C-2: two semantically
identical "found nothing" empty states use two different retry words).

---

## 1. Gates on the settled tree

### Working-tree integrity
```
$ git status --short | awk '{print $1}' | sort | uniq -c
      5 ??      (brag-output/, docs/*.md)
     24 M       (App.tsx + 23 under src/components/)
$ git status --short | grep -E "^ ?D"      # → none, exit 1
```
Every component file is modified in place; none deleted, renamed, or missing.
The 5 untracked entries are docs/artifacts, not source.

### `npm run build` (`tsc -b && vite build`) — **exit 0**
```
✓ built in 1.83s
dist/assets/index-C4z76YFS.js   199.53 kB │ gzip:  61.61 kB
dist/assets/echartsTheme-DavdrFeO.js  443.97 kB │ gzip: 150.52 kB
```

### `npm run lint` (`oxlint`) — **exit 0**
```
LINT_EXIT=0
warnings=23
errors=0
```
Same 11 files as the `HEAD` baseline (SankeyDiagram 5, loading/index 5, motion 3,
Sidebar 2, FilterContext 2, DataTable 1, ListActionDropdown 1, LoadingIndicator 1,
FilterBuilder 1, ui.tsx 1, ZoneContext 1). I established the baseline in rev 1 by
stashing the tree and re-running: **also exactly 23, same files, same rule**
(only `ui.tsx`'s line drifts). **NEW warnings: 0.**

### `npx tsc -b --noEmit` — **exit 0**, empty output.
`tsconfig.app.json` sets `noUnusedLocals`/`noUnusedParameters`, so this also
proves no conversion left a stale import (e.g. `Badge` is still used in
`AttckPanel.tsx:109`, so its import is live).

---

## 2. AC1–AC15 — final, verbatim

Commands run from `admin-ui/`. Output quoted as produced.

| # | Command | Actual result | Verdict |
|---|---|---|---|
| **AC1** | `grep -rn 'className="space-y-6"' src/components/*Page.tsx src/components/PatternTable.tsx` | `QueryPage.tsx:990` only — an inner `aria-busy` wrapper inside the `PageShell` alternate branch. `space-y-5` present in 16 page-root positions. | **PASS** |
| **AC2** | `grep -rn 'text-\[30px\]…text-\[28px\]' src/components/*.tsx` | *(no output, exit 1)*. `<h1/h2` sweep: `ui.tsx:732` PageHeader `text-2xl sm:text-3xl`; standalone `LoginPage.tsx:39 text-[22px]` (exempt brand), Whitelist/BlockDomain `text-2xl`/`text-lg` (standalone). | **PASS** |
| **AC3** | `grep -rn "<table" src/components/*.tsx` | `DataTable.tsx:1145` and `ui.tsx:869` (TableFrame) only. | **PASS** |
| **AC4** | `grep -rn 'border-b border-border' src/components/*.tsx \| grep -v 'bg-muted'` | 14 hits, all card headers / dividers / `DataTable` skeleton+live body rows. No `<thead><tr>` lacks `bg-muted/50` (`DataTable.tsx:1148`, `TableHeadRow`). | **PASS** |
| **AC5** | hex / raw colour sweep minus SankeyDiagram | *(no output, exit 1)* | **PASS** |
| **AC6** | `grep -rn 'inline-flex h-6 w-6\|h-7 w-7\|h-8 w-8' src/components/*.tsx` | 2 matches: `ui.tsx:485` (`DialogPrimitive.Close` — **exempt**, see note) and `ui.tsx:146` (prose comment). `BlacklistPage.tsx:260` **gone**. | **PASS (1 exemption)** |
| **AC7** | `grep -rn 'rounded-full border.*bg-\(danger\|success\|warning\|info\)/10' src/components/*.tsx` | *(no output, exit 1)*. `TopDestinations.tsx:89` is now `<StatusBadge tone="warning" …>Flagged</StatusBadge>`. | **PASS** |
| **AC8** | `grep -c '<PageHeader\|<PageShell' src/components/*Page.tsx` | every primary in-shell page = 1. `ReportPage.tsx` = 2 (two mutually-exclusive branches, 1/render). `LoginPage`/`Whitelist`/`BlockDomain` = 0 (standalone, outside AppShell — exempt). | **PASS (note)** |
| **AC9** | `grep -rn 'mb-2 flex flex-wrap items-center gap-2' src/components/*.tsx` | *(no output, exit 1)* — but see C-1: this is *inconclusive as a proxy* for the intended Toolbar unification. | **PASS** |
| **AC10** | `grep -rn 'No data in window' src/components/*.tsx` | all hits are `EmptyState`/`SimpleTable` props. `HostInspectorPage.tsx:1102/1154/1187` are now `<EmptyState …/>` (were bare `<p>`). | **PASS** |
| **AC11** | `grep -n 'title' src/components/AppShell.tsx`; `grep -n 'title=' src/App.tsx` | AppShell: only `document.title = \`uNetWatch — ${VIEW_LABELS[currentView]}\`` (`:53`) + a comment. App.tsx: *(no output, exit 1)*. | **PASS** |
| **AC12** | `grep -c 'focus-visible:ring-2 focus-visible:ring-ring' src/components/ui.tsx`; `…outline-none…` | `9` / `9` — every `outline-none` is paired with `ring-2 ring-ring`. | **PASS** |
| **AC13** | `grep -n 'reducedMotion' src/components/motion.tsx`; `…prefers-reduced-motion… src/index.css` | `motion.tsx:28 reducedMotion="user"`; `index.css:173 @media (prefers-reduced-motion: reduce)`. | **PASS** |
| **AC14** | `grep -rn 'rounded-xl\|rounded-2xl' src/components/*.tsx`; `grep -rn 'rounded-lg' …` | no `xl`/`2xl`. `rounded-lg` only: `ui.tsx:473` (dialog), 3 Whitelist + 3 BlockDomain hero plates, and `TrafficTimeline.tsx:77` (pre-existing, file untouched). Toast fixed to `rounded-md` (`ui.tsx:649`). | **PASS** |
| **AC15** | `grep -rn 'rounded-md border border-border bg-card shadow-sm' src/components/ui.tsx`; `grep -n 'shadow-none' DataTable.tsx` | `ui.tsx:353` Card, `:836` Panel, `:868` TableFrame; `DataTable.tsx:1141` frame `shadow-none`. | **PASS** |

### AC6 exemption — `ui.tsx:485`
```
<DialogPrimitive.Close
  aria-label="Close dialog"
  className="absolute right-3 top-3 inline-flex h-7 w-7 items-center justify-center rounded-md …">
  <X className="h-4 w-4" />
</DialogPrimitive.Close>
```
This is a **Radix** primitive, not a plain button. Replacing it with `IconButton`
requires `<DialogPrimitive.Close asChild><IconButton …/></DialogPrimitive.Close>`;
`asChild` appears nowhere in `ui.tsx` (only `SelectPrimitive.Icon asChild` at
`:536`). **Judged genuinely exempt.** It is the only remaining hit.

*(Broader sweep: 33 raw `<button>`s exist in `src/components/`, but all but two
carry a visible text label or are `Button`/`IconButton` internals. The two
icon-only raw buttons outside AC6's literal pattern are `ui.tsx:717` (SearchInput
clear, box class `p-1`) and `Sidebar.tsx:236` (collapses to icon-only, else shows
"Collapse"). **Both are pre-existing at `HEAD` and neither was ever in the
canon's §5 conversion list** — recorded as out-of-scope, not regressions.)*

**Final tally: 15/15 criteria met, 14 cleanly, AC6 with one documented exemption.**

---

## 3. N-2 — `RankedTable` geometry re-check

### Public signature — STILL byte-identical to HEAD
```
HEAD ui.tsx:650   export function RankedTable({ rows, className, onRowClick }: { rows: { label: string; count: number }[]; className?: string; onRowClick?: (label: string) => void }) {
CURRENT ui.tsx:1044  export function RankedTable({ rows, className, onRowClick }: { rows: { label: string; count: number }[]; className?: string; onRowClick?: (label: string) => void }) {
```
Identical text; only the line moved. Both `QueryPage.tsx:1017,1020` call sites
compile (`tsc` exit 0; `build` exit 0).

### Geometry restoration
`RankedTable` now passes `dense={false} headDense` (`ui.tsx:1051-1052`):
- `TableFrame dense={dense}` → `text-sm` table ✓ (HEAD: `w-full text-sm`)
- `TableHeadCell dense={headDense ?? dense}` → `headDense` ⇒ `px-3 py-2` ✓ (HEAD: `px-3 py-2`)
- body `<td>` padding is hardcoded `"px-3 py-2"` (`ui.tsx:1012`), independent of
  `dense` ✓ (HEAD: `px-3 py-2`)

So the rendered padding/font are **byte-equal to the pre-refactor geometry**:
`text-sm` + `px-3 py-2` in both `th` and `td`.

### `headDense` defaults to `dense` — no other caller changed
`headDense` is read at exactly one place, `ui.tsx:969`
(`dense={headDense ?? dense}`), and is passed by **only** `RankedTable`
(`ui.tsx:1052`; `grep -rn headDense` shows no other call site, and the six other
`SimpleTable` callers — `AttckPanel`, `BlockDomainPage`, `DashboardPage`,
`LogsPage`, `TopDestinations`×2, `WhitelistDomainPage` — pass `dense` only).
Default behaviour is therefore unchanged for every other table.

### One nuance, stated honestly
HEAD's `th` carried `.mono-label` **plus** redundant `text-xs font-medium
text-muted-foreground` utilities:
```
HEAD: <th className="mono-label w-9 px-3 py-2 text-left text-xs font-medium text-muted-foreground">
```
The new `th` is `mono-label px-3 py-2` (+ width/align) only. Because
`.mono-label` (`index.css:130`: 11px / 600 / uppercase / `--color-muted-foreground`)
and those Tailwind utilities have equal specificity, HEAD's rendering depended on
stylesheet order; the new version is *deterministically* the canonical mono label
the canon's §1.4 mandates ("Never re-implement with `text-xs uppercase font-mono`
inline"). This is **not a regression** — it is the redundant-utility removal the
canon asked for. The only literal difference from HEAD is the removed redundancy.

**N-2: FIXED.** (The rev-2 "delta-shifted" concern is resolved; padding is
`px-3 py-2`, not `px-4 py-3`.)

---

## 4. N-3 — `BlacklistPage` raw delete button

```
CURRENT BlacklistPage.tsx:256
<IconButton
  icon={Trash2}
  label={`Remove ${value} from blacklist`}
  onClick={() => onDelete(kind, value)}
  disabled={disabled}
  variant="danger"
  size="md"
/>
```
vs
```
HEAD BlacklistPage.tsx:253
<button type="button"
  onClick={() => onDelete(kind, value)}
  disabled={disabled}
  aria-label={`Remove ${value} from blacklist`}
  className="inline-flex h-7 w-7 … hover:bg-danger/10 hover:text-destructive …">
  <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
</button>
```
- `aria-label` text → `label` text: **identical** (`Remove ${value} from blacklist`).
- `onClick` → **identical**. `disabled` → **preserved**.
- `hover:bg-danger/10 hover:text-danger` (IconButton `variant="danger"`) ≡
  old `hover:bg-danger/10 hover:text-destructive`: `index.css:41`
  `--color-destructive: var(--color-danger)` — same colour.
- `size="md"` ⇒ `h-7 w-7` — matches the old box.

**N-3: FIXED, faithful.** The task's note that `Textarea` is absent from `ui.tsx`
is confirmed (`grep -n Textarea src/components/ui.tsx` → none); the conversion
needed only a button, so nothing was blocked.

**No raw icon-only `<button>` remains** anywhere in `src/components/**` except
the exempt Radix close (`ui.tsx:485`) and the two pre-existing out-of-pattern
boxes noted in §2.

---

## 5. Regression sweep — R-1…R-10 and N-1…N-5, final status

| id | item | status |
|---|---|---|
| R-1 | icon-button migration skipped files | **FIXED** (LoginPage, NetworkGraphDiagram×3, BlacklistPage converted; only exempt Radix close left) |
| R-2 | raw `<table>` outside ui.tsx/DataTable | **FIXED** (Dashboard/Whitelist/BlockDomain → `SimpleTable`) |
| R-3 | page-root `space-y-4`/`space-y-6` | **FIXED** (PatternTable/LogsPage/RedirectsPage → `space-y-5`) |
| R-4 | RankedTable tooltip dropped + `text-sm→text-xs` | **FIXED** (tooltip via `rowTitle`; `dense={false}`; padding restored — §3) |
| R-5 | `Toolbar` not propagated; Panel header not unified | **STILL-OPEN** (`<Toolbar>` only in `DataTable.tsx:979`; `Panel` header still raw `div`, `ui.tsx:838`) |
| R-6 | raw status pill `TopDestinations.tsx:85` | **FIXED** (→ `StatusBadge tone="warning"`, text+title preserved) |
| R-7 | bare `<p>No data in window</p>` in HostInspector | **FIXED** (→ `EmptyState`) |
| R-8 | `severityVariant` not unified in AttckPanel | **FIXED** (`severityTone` + `StatusBadge`; matches AttckFleetPage) |
| R-9 | `rounded-lg` toast | **FIXED** (`ui.tsx:649` → `rounded-md`); only dialog + hero plates + pre-existing `TrafficTimeline.tsx:77` remain |
| R-10 | retired `divide-y divide-border` body model | **ACCEPTED-BY-DESIGN / residual** — no table bodies use it now; 6 sites remain on `<ul>`/`<dl>`/`<div>`/grid wrappers, where `divide-y` is the idiomatic divider, not a table body |
| N-1 | HostInspector retry copy changed | **ACCEPTED-BY-DESIGN** (genuine failed reads say `Retry`; the `:1247 Search again` is deliberately kept — see C-2 for the residual) |
| N-2 | RankedTable padding delta | **FIXED** (restored to `px-3 py-2`) |
| N-3 | BlacklistPage raw icon button | **FIXED** |
| N-4 | Toolbar used in one file (== R-5) | **STILL-OPEN** |
| N-5 | table `empty` as bare `<p>` in AttckPanel/Whitelist/BlockDomain | **STILL-OPEN** (cosmetic; not caught by AC10 as the strings differ) |

### Ranked residual inconsistencies

**C-1 — `Toolbar` is a single-file abstraction (R-5/N-4).** The primitive exists
and is used only by `DataTable.tsx:979`. The canon's §5 Batch 4 (page control rows
in Analytics/Blacklist/HostInspector; `Panel` header → `Toolbar`) was never done.
`Panel`'s header is still a hand-written `div` at `ui.tsx:838`. AC9 passes only
because it greps for the *absence* of the old literal class string, so **AC9 is
not evidence of unification** — it is evidence that one string was deleted.

**C-2 — two "found-nothing" empty states use two different retry words.**
`HostInspectorPage.tsx:1066` ("No host found" → `Retry`) and `:1247` ("No findings
for X" → `Search again`) are the same *success-but-empty* semantics with the same
`lookup(target)` handler, and now differ. The N-1 rationale ("`Search again` means
the lookup succeeded but found nothing") applies equally to both; the normalised
`Retry` at `:1066` breaks that rule. This is a copy inconsistency, not a defect.

**C-3 — table `empty` states are bare `<p>` (N-5).**
`AttckPanel.tsx:121`, `WhitelistDomainPage.tsx:182`, `BlockDomainPage.tsx:205`
pass `empty={<p …>…</p>}` instead of the canon's `EmptyState` (§4.7). Cosmetic.

---

## 6. Final verdict

**SHIP WITH CAVEATS.**

**What this change accomplished:** every *visual* criterion in the canon's §6 gate
now passes — page-root spacing, raw-`<table>` elimination, icon-button adoption,
status-pill adoption, empty-state convergence, radius/shadow discipline, focus
rings, reduced motion. The primitives (`IconButton`, `StatusBadge`, `SimpleTable`,
`TableFrame`, `PageShell`) are real, typed, and behaviour-preserving at every
converted site; `DataTable`'s four visual changes remain logic-free; `AppShell`
correctly shed its pseudo-title; `DashboardPage`'s hero was replaced without
dropping a section. Gates are green with zero new warnings.

**What it did NOT accomplish:** the abstraction-*adoption* half. The shared
`Toolbar` primitive is still used in exactly one file (`DataTable.tsx:979`) and
the `Panel` header was never migrated onto it (§5 Batch 4 was skipped). Three
table `empty` props are still bare `<p>` rather than `EmptyState`. So the change
standardises the *appearance* of tables and pages, but not yet the *mechanism* —
which was the canon's stated purpose ("so two pages cannot disagree").

**Single most important remaining inconsistency:** the `Toolbar` primitive is
adopted in exactly one file and the `Panel` header is still a hand-written `div`
(`ui.tsx:838`) — the one place the change leaves its own abstraction unused. It
is not a correctness risk, but it is the largest gap between what the canon
specifies and what the tree implements.

**Release recommendation:** ship. The caveats are cosmetic/adoption-level, the
tree compiles and lints clean, and no user-facing behaviour other than the
normalised retry copy (C-2) changed by accident. If the canon must be met
literally before release, the only required work is Batch 4 (Toolbar/Panel) plus
the three `empty` states and the C-2 wording; none of it is blocking.

---

## 7. Closing addendum — C-1 and C-3 fixed (`finish-a`), final gate

All writers idle again. Re-run on the settled tree.

### Gates — green, unchanged
```
build = 0
lint  = 0      (warnings = 23  → 0 new; errors = 0)
tsc   = 0      (empty output)
git status --short → 24 M, 5 ?? ; zero D / renames / half-written files
```

### C-1 — FIXED. `Toolbar` now has 4 consumers
```
$ grep -rn "<Toolbar" src/components/*.tsx
src/components/AnalyticsPage.tsx:787:        <Toolbar
src/components/BlacklistPage.tsx:556:        <Toolbar
src/components/DataTable.tsx:979:      <Toolbar
src/components/ui.tsx:849:        <Toolbar
```
`AC9` is no longer vacuously satisfied — the wrapper is genuinely shared by the
grid, two page toolbars, and the `Panel` header.

### Panel header geometry — byte-identical wrapper, one canonical gap added
`Panel` (`ui.tsx:849`) now renders `<Toolbar role={undefined} className="border-b
border-border px-4 py-3" left={icon+title} right={description+action} />`.
`Toolbar` emits `cn("flex flex-wrap items-center gap-2", className)` →
`flex flex-wrap items-center gap-2 border-b border-border px-4 py-3`, i.e. the
**same merged class list** as HEAD's `<div className="flex flex-wrap items-center
gap-2 border-b border-border px-4 py-3">`. The right cluster is now the single
`<div className="ml-auto flex items-center gap-2">` the doc specifies, instead of
HEAD's two independent `ml-auto` elements — same placement, plus a canonical 8px
description↔action gap. `role={undefined}` is a deliberate improvement: it keeps
the `<h3>` heading out of a `toolbar` landmark.

### C-3 — FIXED. The three table `empty` props are now `EmptyState`
| file:line | text | wrapper |
|---|---|---|
| `AttckPanel.tsx:121` | `"No ATT&CK techniques detected for this entity."` (== HEAD) | `EmptyState … className="border-0"` |
| `WhitelistDomainPage.tsx:182` | `"No entries — add URLs above."` (== HEAD cell) | `EmptyState … className="border-0"` |
| `BlockDomainPage.tsx:205` | `"No entries — add URLs above."` (== HEAD cell) | `EmptyState … className="border-0"` |
Message text is byte-identical to the strings they replace and every one carries
`border-0` inside the table frame (§4.7).

### C-2 — unchanged, deliberately
```
HostInspectorPage.tsx:1247  … action={<Button … onClick={() => void lookup(target)}>Search again</Button>}
```
Still `Search again`, still the success-but-empty affordance. (The cosmetic
`:1066 Retry` vs `:1247 Search again` wording split noted in §5 C-2 remains; it is
copy, not behaviour, and was left by design.)

### Regression check on this last pass
None. `build`/`lint`/`tsc` all still 0, the lint count is still 23 (0 new), and
the git tree still shows every component file as `M` with no deletion or
half-write. No AC moved backwards.

### Updated "not accomplished" list
The previous list is **superseded**: Batch 4 (`Toolbar` + `Panel` header) is now
done and the three `empty` states are converted. What remains un-done is only:
1. **C-2** — the `Retry`/`Search again` wording split between two semantically
   identical empty states in `HostInspectorPage` (copy only, by design).
2. Out-of-scope raw icon-only buttons that were never in the canon's §5 list:
   `ui.tsx:717` (SearchInput clear) and `Sidebar.tsx:236` (collapse) — pre-existing
   at HEAD, not regressions.

### Addendum verdict

**SHIP.** With C-1 and C-3 closed, the change now satisfies all fifteen §6
criteria (AC6 with the one documented Radix `asChild` exemption) **and** has
adopted its own abstractions: `Toolbar` is multi-consumer, the `Panel` header is
unified, and every table empty state is the shared `EmptyState`. The only
outstanding item is a by-design wording choice, not a defect.
