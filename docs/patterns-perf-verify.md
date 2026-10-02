# Patterns page performance fix — independent verification

**Date:** 2026-10-02
**Scope:** READ-ONLY verification of the `Stagger` row-count cap and secondary fixes in `admin-ui`.
**Verdict:** **FIXED** — no remaining gap that reproduces the hang.

---

## Step 1 — Gates

All commands run in `/home/x0art/Project/uNetWatch/admin-ui`.

### `npm run build` → exit 0

```
dist/assets/PatternTable-t2_CJXur.js                 8.68 kB │ gzip:   3.14 kB
dist/assets/DataTable-DtlCezYy.js                   61.21 kB │ gzip:  18.65 kB
✓ built in 2.34s
BUILD_EXIT=0
```

### `npx tsc -b --noEmit` → exit 0

```
TSC_EXIT=0
```

### `npm run lint` → exit 0, **23 warnings / 0 errors**

```
src/components/motion.tsx:22:14: warning react(only-export-components): …
src/components/motion.tsx:45:14: warning react(only-export-components): …
src/components/motion.tsx:50:14: warning react(only-export-components): …
… (23 total)
LINT_EXIT=0
```

Warnings are all the pre-existing `react(only-export-components)` fast-refresh class; 3 of them now sit in `motion.tsx` (the new `STAGGER_MAX_ITEMS`, `staggerVariants`, `staggerItemVariants` exports). Count matches the expected 23/0.

### `git status --short`

```
 M admin-ui/src/api.ts
 M admin-ui/src/components/DataTable.tsx
 M admin-ui/src/components/PatternTable.tsx
 M admin-ui/src/components/motion.tsx
 M admin-ui/src/components/ui.tsx
?? brag-output/
?? docs/patterns-perf-audit.md
```

Modified files exactly as expected (`motion.tsx`, `DataTable.tsx`, `ui.tsx`, `api.ts`, `PatternTable.tsx`) + untracked `docs/patterns-perf-audit.md`.

**Throwaway-file check** (`_capmeasure.mjs`, `_verify.mjs`, `*.bundle.cjs`, `_toastentry.tsx`):

```
NO throwaway files in repo
```

**Note — brief inaccuracy:** `git status` also shows an untracked `brag-output/` directory (a pre-existing video/composition artifact from a different task, dated Oct 1). The brief said the only untracked entry would be `docs/patterns-perf-audit.md`. `brag-output/` is **not** part of this fix and is not a throwaway test file; flagging it for completeness, not as a defect of the change.

---

## Step 2 — The cap actually engages

### 2.1 `motion.tsx` constant + decision + plain branch

- `export const STAGGER_MAX_ITEMS = 40` — **`motion.tsx:65`**. ✅
- Single decision line — **`motion.tsx:97`**:
  ```ts
  const animated = count === undefined || count <= STAGGER_MAX_ITEMS
  ```
  Exactly one writer of the budget (can't drift between callers). ✅
- Plain branch (**`motion.tsx:110-114`**) passes **only `className`**:
  ```tsx
  ) : (
    // Plain, un-animated element: same class/children, no motion props, so
    // the rows are simply visible immediately and never left at opacity 0.
    <PlainTag className={className}>{children}</PlainTag>
  )
  ```
  No `initial` / `animate` / `variants`. ✅
- `StaggerItem` plain branch — **`motion.tsx:148-165`** — reads the module-private
  `StaggerBudgetContext` (`createContext(true)`, `motion.tsx:71`) and, when `!animated`,
  renders `<Tag className onClick onKeyDown onDoubleClick onContextMenu tabIndex role title>`
  with **no motion props**. The animated branch (`motion.tsx:167-181`) passes the
  *identical* DOM props plus `variants={staggerItemVariants}`. ✅

### 2.2 Call sites — **the most important check**

| File | Line | Exact prop expression | Passes `count`? |
|---|---|---|---|
| `DataTable.tsx` | 1280 | `<Stagger as="tbody" count={displayData.length}>` | ✅ YES |
| `ui.tsx` (SimpleTable) | 1267 | `<Stagger as="tbody" count={data.length}>` | ✅ YES |

### 2.3 Every `Stagger` usage in `src/`

`grep -rn "<Stagger" src/components/*.tsx` (expanded to every component file):

```
src/components/DataTable.tsx:1280:  <Stagger as="tbody" count={displayData.length}>
src/components/ui.tsx:1267:         <Stagger as="tbody" count={data.length}>
```

Only **two** `Stagger` call sites exist in the entire `src/` tree, and **both pass `count`**.
`StaggerItem` has exactly two call sites (`DataTable.tsx:1285`, `ui.tsx:1271`), both inside
these `Stagger` parents. `RankedTable` (`ui.tsx:1319+`) is a thin wrapper over `SimpleTable`,
so it inherits the cap.

**No `Stagger` wraps a potentially-large list without `count`. No hole found.** ✅

### 2.4 The non-animated path cannot leave rows invisible — proof from code

`StaggerItem`'s plain branch (`motion.tsx:149-164`) returns a bare intrinsic element with
`className/onClick/onKeyDown/onDoubleClick/onContextMenu/tabIndex/role/title` — **no
`initial`, no `variants`, no `style`**. framer-motion is the only thing that can set
`style="opacity:0"` on these nodes, and it is not invoked on this branch. Therefore the
cells render fully visible on the plain path, with no animation dependency. This is
confirmed empirically in Step 3 (0/41 and 0/500 rows carry a motion style).

---

## Step 3 — Proof by rendering (real code, SSR)

A throwaway harness was placed at `admin-ui/_ssr_verify.mjs` (deleted afterwards), loading
the **real `src/components/motion.tsx`** through Vite's `createServer` + `ssrLoadModule`
(so the actual React plugin/JSX pipeline is used) and rendering with `react-dom/server`
`renderToString`. It rendered `<Stagger as="tbody" count={N}>` containing N
`<StaggerItem as="tr">` rows and counted motion inline styles, leaked motion attributes,
and React warnings. Raw output:

```
### N = 40 (at cap -> animated)
  STAGGER_MAX_ITEMS = 40
  <tbody> tag       = <tbody class="tbody-cls">
  <tr> total           = 40
  <tr> w/ motion style = 40
  any initial=/animate=/variants= in html = false
  sample tr[0]: <tr class="row cv-auto" tabindex="0" role="row" title="t0" style="opacity:0;transform:translateY(8px)">

### N = 41 (over cap -> plain)
  STAGGER_MAX_ITEMS = 40
  <tbody> tag       = <tbody class="tbody-cls">
  <tr> total           = 41
  <tr> w/ motion style = 0
  any initial=/animate=/variants= in html = false
  sample tr[0]: <tr class="row cv-auto" tabindex="0" role="row" title="t0">

### N = 500 (over cap -> plain)
  STAGGER_MAX_ITEMS = 40
  <tbody> tag       = <tbody class="tbody-cls">
  <tr> total           = 500
  <tr> w/ motion style = 0
  any initial=/animate=/variants= in html = false
  sample tr[0]: <tr class="row cv-auto" tabindex="0" role="row" title="t0">

### count=undefined (unknown length -> animated)
  <tr> total           = 60
  <tr> w/ motion style = 60

### React "does not recognize prop" warnings
  total warnings captured = 0
  'does not recognize prop' warnings = 0

### bare StaggerItem (no <Stagger> parent, default context = animated)
  html = <tr class="x"><td>z</td></tr>
```

**Measured numbers requested by the brief:**

| N | `<tr>` total | `<tr>` w/ motion inline style | leaked `initial/animate/variants` | React "does not recognize prop" warnings |
|---|---|---|---|---|
| 40 | 40 | **40** | none | **0** |
| 41 | 41 | **0** | none | **0** |
| 500 | 500 | **0** | none | **0** |
| undefined (60 rows) | 60 | 60 (by design: unknown ⇒ animated) | none | 0 |

This is a real measurement, not static reasoning. Notes:
- At N=40 the animated rows SSR to `style="opacity:0;transform:translateY(8px)"` (framer's
  `initial="hidden"` paint); the client hydrates and runs the entrance. At N>40 the plain
  rows emit **no `style` attribute at all** — they cannot be stuck invisible.
- `style=` is legitimately present on the animated path; the harness's `anyMotionAttr` flag
  deliberately checks only for the *leaked* motion props (`initial/animate/variants`), of
  which there are **zero** on every path.
- The `bare StaggerItem` case (no parent) defaults to the animated context (`true`), and
  framer suppresses `initial` styling on the very first SSR pass — output `<tr class="x">`
  with no style. Non-issue.

---

## Step 4 — Secondary fixes

### 4.1 `getPatternStats` / `PatternStats` fully removed

```
$ grep -rn "getPatternStats\|PatternStats" src/
NO MATCHES (removed)
```
✅ Dead code (`listPatterns({ limit: 5000 })` to count two numbers) is gone.

### 4.2 `listPatterns` still used — nothing broke

```
src/components/PatternTable.tsx:4, 208   (the patterns table fetch)
src/components/FindingsPage.tsx:24, 411  (whitelist summary count)
src/api.ts:517                           (definition)
```
✅ Still exported and used — build/tsc pass proves no dangling import.

### 4.3 `created_at` hoisted formatter

`PatternTable.tsx:39`:
```ts
const DATE_FMT = new Intl.DateTimeFormat(undefined)
```
Cell at `PatternTable.tsx:105`:
```tsx
{p.created_at ? DATE_FMT.format(new Date(p.created_at)) : "—"}
```
✅ Module-scope formatter, called once per row instead of constructing per cell/render.

**Equivalence check** (node, real runtime):
```
toLocaleDateString() = "3/5/2024"
DateTimeFormat(undefined).format() = "3/5/2024"
IDENTICAL = true
2024-01-01        -> "1/1/2024"   "1/1/2024"   true
2025-12-31        -> "12/31/2025" "12/31/2025" true
2023-06-15T23:59:59Z -> "6/16/2023" "6/16/2023" true
```
✅ `Intl.DateTimeFormat(undefined)` (no options) with no locale argument is **exactly**
equivalent to `Date.prototype.toLocaleDateString()` with no arguments — same default locale,
same default `dateStyle`/options. Output is byte-identical across UTC-boundary cases.

---

## Step 5 — Regression sweep

### 5.1 Animated vs plain paths render identical DOM apart from the motion wrapper

`motion.tsx:148-181` — both branches pass the **same** props:
`className`, `onClick`, `onKeyDown`, `onDoubleClick`, `onContextMenu`, `tabIndex`, `role`,
`title`. The animated branch adds only `variants={staggerItemVariants}`; the plain branch
adds nothing. Same tag (`motion[as]` resolves to the intrinsic tag `as`). ✅

For `Stagger` itself (`motion.tsx:100-116`): both branches use the same `as` tag and the
**same `className`**; animated adds `initial="hidden" animate="show" variants={staggerVariants}`. ✅

Verified empirically: `tbody` class is `"tbody-cls"` in both the N=40 and N>40 SSR runs
(Step 3 output), and each `<tr>` in the plain run carries the full
`class="row cv-auto" tabindex="0" role="row" title="t0"`. ✅

`DataTable.tsx` and `SimpleTable` (`ui.tsx`) both place the per-row handlers (`onClick`,
`onKeyDown`), `tabIndex`, `role`, `title` on the `StaggerItem` itself — so the plain path
keeps row-click, keyboard parity, and a11y roles identically. ✅

### 5.2 `cv-auto` on both paths

- `DataTable.tsx:1289` row className includes `cv-auto`; goes on the row on **both** paths
  (the class string is identical, only the wrapper changes). ✅
- `index.css:169` defines `@utility cv-auto { content-visibility: auto; contain-intrinsic-size: 1px 300px; }`.

**Adversarial finding:** `SimpleTable` (`ui.tsx:1271-1282`) rows **do not carry `cv-auto`**.
This is **not a regression**: `git show HEAD:admin-ui/src/components/ui.tsx | grep cv-auto`
returns nothing — SimpleTable rows never had `cv-auto`. The brief's Step 5 wording ("still
on the rows") is only true for `DataTable`; for SimpleTable `cv-auto` was never present. No
behaviour changed by this fix on either component. ⚠️ (pre-existing gap, unrelated to this change)

### 5.3 Motion gate / reduced-motion / paused CSS untouched

- `MotionGate` — `motion.tsx:27-29`, `<MotionConfig reducedMotion="user">`; mounted in
  `App.tsx:362-366`. Not in any diff. ✅
- `index.css:173` `@media (prefers-reduced-motion: reduce)` — untouched (not in diff). ✅
- `index.css:170` `html[data-paused] *, … { animation-play-state: paused !important; }` — untouched. ✅

None of the 5 modified files is `index.css`, `App.tsx`, or the `MotionGate` body.

### 5.4 DataTable behaviour unchanged (diff-check)

The `DataTable.tsx` diff is **6 insertions / 3 deletions**, all inside the `Stagger`
opening tag and its comment:

```diff
-            // Stagger only the visible page of rows on first paint — never the
-            // full dataset (internalPagination keeps displayData ≤ page size).
-            <Stagger as="tbody">
+            // Stagger the rows only while the table is small enough …
+            <Stagger as="tbody" count={displayData.length}>
```

No change to sorting, filtering, selection, bulk actions, export, persistence
(`viewKey`), sticky header, context menu, row-click, empty state, or skeleton. `ui.tsx`
diff is likewise a **single line** (`<Stagger as="tbody">` → `<Stagger as="tbody" count={data.length}>`).
✅

### 5.5 Does the cap actually cover the reported 200/1000-row scenario? (adversarial)

The brief claims 200-row / 1000-row tables hang. Two things constrain how many rows render
per page:

- `PatternTable` uses **external** pagination: it fetches `limit: pageSize`
  (`PatternTable.tsx:211`) and `DataTable` does **not** set `internalPagination` there
  (only `QueryPage.tsx:1238` uses `internalPagination`). So `displayData.length === pageSize`.
- `Pagination` page-size options default to `[25, 50, 100, 200]` (`ui.tsx:1441`), and
  `pageSizeOptions` is **never overridden** anywhere (`grep -rn pageSizeOptions src/` shows
  only the definition/usage in `ui.tsx`). `PatternTable`'s default is `DEFAULT_PAGE_SIZE = 50`.

Therefore the only selectable row counts are **25, 50, 100, 200**:
- **25** → 25 ≤ 40 → animates (fine: ~1.25s tail, the intended enhancement).
- **50 / 100 / 200** → all **> 40** → plain path, zero stagger. ✅

**So no user-selectable page size animates a large list.** The 200-row hang is closed (200
is exactly a selectable page size and now takes the plain path). A literal 1000-row render
cannot occur here without `internalPagination` + `pageSize=1000`, which no caller sets.
The `FindingsPage` `limit: 5000` fetches (`FindingsPage.tsx:411-412`) feed summary numbers
only, not a rendered table. ✅

---

## Check table

| # | Check | Result | Evidence |
|---|---|---|---|
| 1 | `npm run build` exit 0 | **PASS** | `✓ built in 2.34s` / `BUILD_EXIT=0` |
| 2 | `npx tsc -b --noEmit` exit 0 | **PASS** | `TSC_EXIT=0` |
| 3 | lint 23 warnings / 0 errors | **PASS** | `LINT_EXIT=0`, 23 warning lines |
| 4 | Modified file set matches | **PASS** | git status: 5 expected files (+ audit doc) |
| 5 | No throwaway files | **PASS** | `NO throwaway files in repo` |
| 6 | `STAGGER_MAX_ITEMS === 40` | **PASS** | `motion.tsx:65` |
| 7 | Single decision line | **PASS** | `motion.tsx:97` |
| 8 | Plain branch passes only `className` | **PASS** | `motion.tsx:113` |
| 9 | `DataTable` passes `count` | **PASS** | `DataTable.tsx:1280` `count={displayData.length}` |
| 10 | `SimpleTable` passes `count` | **PASS** | `ui.tsx:1267` `count={data.length}` |
| 11 | Every `Stagger` call site passes `count` | **PASS** | only 2 sites, both pass count |
| 12 | Plain path cannot be stuck `opacity:0` | **PASS** | code `motion.tsx:149-164` + SSR 0 styled rows |
| 13 | Motion-styled `<tr>`: 40 @ N=40 | **PASS** | SSR: `styledTrs = 40` |
| 14 | Motion-styled `<tr>`: 0 @ N=41/500 | **PASS** | SSR: `styledTrs = 0` both |
| 15 | No leaked `initial/animate/variants` | **PASS** | SSR `anyMotionAttr = false` all runs |
| 16 | Zero React "does not recognize prop" | **PASS** | SSR `recog = 0` |
| 17 | `getPatternStats`/`PatternStats` removed | **PASS** | `grep` → NO MATCHES |
| 18 | `listPatterns` still used | **PASS** | PatternTable, FindingsPage, api.ts |
| 19 | `created_at` uses hoisted `DATE_FMT` | **PASS** | `PatternTable.tsx:39,105` |
| 20 | `Intl(undefined)` ≡ `toLocaleDateString()` | **PASS** | node: IDENTICAL for all cases |
| 21 | Animated/plain DOM identical bar wrapper | **PASS** | `motion.tsx:148-181` + SSR class/attr match |
| 22 | `cv-auto` on DataTable rows both paths | **PASS** | `DataTable.tsx:1289` (path-independent class) |
| 23 | `cv-auto` on SimpleTable rows | **N/A (pre-existing)** | never present in HEAD `ui.tsx` |
| 24 | `MotionGate` / `reducedMotion="user"` untouched | **PASS** | `motion.tsx:27-29`, not in diff |
| 25 | CSS `prefers-reduced-motion` + `data-paused` untouched | **PASS** | `index.css:170,173`, not in diff |
| 26 | No DataTable behaviour change | **PASS** | diff = comment + `count` prop only |
| 27 | No selectable page size renders a large animated list | **PASS** | options `[25,50,100,200]`; only 25 ≤ 40 |

---

## Verdict

**FIXED.**

- The single most important requirement — **both** `Stagger` call sites pass `count` — holds.
  There are no other `Stagger` call sites, so there is no uncovered large list.
- The cap was **proven by rendering**, not merely reasoned: 40 motion-styled `<tr>` at N=40,
  **0** at N=41 and N=500, no leaked `initial/animate/variants` attributes, and **zero**
  React "does not recognize prop" warnings.
- The non-animated path emits no `initial`/`variants`, so rows cannot be stuck at `opacity: 0`.
- The dead `getPatternStats`/`PatternStats` code is fully removed; `listPatterns` is intact.
- The `Intl.DateTimeFormat` hoist is output-equivalent to the previous `toLocaleDateString()`.
- No behavioural regression in `DataTable`/`SimpleTable`; the motion gate and reduced-motion
  CSS are untouched.

**Most important remaining gap:** **none** that reproduces the reported hang. Two
non-defect observations (not gaps in this fix):

1. `git status` shows an untracked `brag-output/` directory in addition to
   `docs/patterns-perf-audit.md` — the brief's expected-status list omitted it. It is
   unrelated to this change.
2. `SimpleTable` rows lack `cv-auto` (DataTable rows have it). This is **pre-existing**
   (absent from `HEAD:ui.tsx`), not introduced by this fix, and does not affect correctness
   of the stagger cap.
