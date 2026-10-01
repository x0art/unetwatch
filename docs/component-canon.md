# uNetWatch — Canonical Component Contract

Status: **Design only — no source file has been modified by this document.**
Owner: Design lead. Scope: every visual surface in `admin-ui/src/components/`.
Companions: `docs/table-revamp-spec.md` (§2 principles, §3 slot grammar, §5
interaction — **extended, never contradicted**, here), `docs/table-audit.md`.

The one problem this document solves: **components do not look alike across
pages** ("table1 has a card but table2 does not"). Every rule below is tied to a
real `file:line`, states the single canonical className, and names the losers it
replaces. Where a conflict exists, exactly one winner is chosen.

File paths are relative to `admin-ui/src/` unless stated otherwise. Line numbers
are from the snapshot read while authoring this document.

---

## 1. Visual language lockup

The token sheet is `index.css` `@theme` (`index.css:9-68`) plus the `.dark`
override (`index.css:86-109`). This section fixes **which token + which scale
step** every surface must use, so two pages cannot disagree.

### 1.1 Radius scale

| Token (index.css) | px | Canonical use | Losers resolved |
|---|---|---|---|
| `--radius-sm` | 4px | Inner controls inside a framed surface: select popover items (`ui.tsx:442` uses `rounded-sm`), `IconButton` glyph plates. | — |
| `--radius-md` | 6px | **THE default.** Every card, panel, table container, button, input, select trigger, dialog close, badge-with-square-corners. | Nothing at `rounded-lg` may be a container. |
| `--radius-lg` | 8px | Only full-screen dialog content (`ui.tsx:358`) and one-off hero glyph plates on standalone review pages (`WhitelistDomainPage.tsx:167`, `BlockDomainPage.tsx:190`). | `EmptyState` today uses `rounded-lg` (`ui.tsx:579`) — **fixed to `rounded-md`** so it matches every card it sits inside. |
| `--radius-xl` / `--radius-2xl` | 12/16px | **UNUSED.** No container, card, or control may use these. | Any `rounded-xl`/`rounded-2xl` is a defect. |
| `rounded-full` | pill | **Only** `Badge`, `StatusBadge`, `ListBadge` is exception, rank progress bars (`ui.tsx:680`), status dots (`TopDestinations.tsx:48`). | `ListBadge` uses `rounded-md` (`ui.tsx:278`) — **kept as the deliberate exception** it shares with `StatusBadge` (see §3). |

**Rule R1.** A framed container is `rounded-md`. A control is `rounded-md`; a
control *inside* a popover/dialog body is `rounded-sm`. A pill is
`rounded-full`. Nothing else is allowed.

### 1.2 Border & shadow

| Property | Canonical value | Where | Losers |
|---|---|---|---|
| Border color | `border-border` (`#E9E9E8` / dark `#37352F`, `index.css:45`/`99`) | every container, control, divider | Raw `border-input` (`#E0E0DE`) only on form fields (`ui.tsx:179,213`). `border-border/20` (`DataTable.tsx:1095`) is **forbidden** — use `bg-border`. |
| Border width | `border` (1px hairline) | everywhere | — |
| Shadow | **`shadow-sm`** on every card/panel/button that lifts off the page. | `Card` `ui.tsx:293`, `Panel` `ui.tsx:634`, `StatCard` `ui.tsx:714`, `Button` `ui.tsx:43` | `DataTable`'s frame is `shadow-none` (`DataTable.tsx:1133`) — **KEPT**, because the grid sits inside a `Panel`/`Card` that already lifts; a shadow on both reads as a double frame. Recorded as the one intentional `shadow-none` container. |
| Shadow (floating) | `shadow-md` popovers (`ui.tsx:430`), `shadow-lg` dialogs (`ui.tsx:358`) + toasts (`ui.tsx:498`) | overlays only | — |

**Rule R2.** Static surface → `border border-border bg-card shadow-sm`.
Grid frame → `border border-border bg-card shadow-none`. Floating → `shadow-md`
(popovers) / `shadow-lg` (dialogs, toasts). No other shadow class may appear.

### 1.3 Spacing scale

| Purpose | Canonical | Evidence / losers |
|---|---|---|
| Page root vertical rhythm | **`space-y-5`** | Today: `space-y-6` (`AttckFleetPage.tsx:266`, `BlacklistPage.tsx:544`, `JaillistPage.tsx:248`, `QueryPage.tsx:816`, `RedirectsPage.tsx:657`), `space-y-5` (`DashboardPage.tsx:171`, `AnalyticsPage.tsx:625`, `HostInspectorPage.tsx:1002`), `space-y-4` (`PatternTable.tsx:339`, `FindingsPage.tsx:604`, `LogsPage.tsx:661`). **Winner: `space-y-5`.** Losers `space-y-4` and `space-y-6` are retired for page roots. |
| Card/panel inner padding | **`p-5`** | `CardHeader`/`CardContent` (`ui.tsx:297,305`), `StatCard` (`ui.tsx:714`). `Panel` body uses `p-4 sm:p-5` (`ui.tsx:643`) — **kept** as the compact panel body; its header is `px-4 py-3` (`ui.tsx:636`). |
| Grid cell padding | `px-4 py-3` comfortable, `px-3 py-2` compact | `DENSITY_PAD` (`DataTable.tsx:368-371`). Never hand-picked per page. |
| Toolbar gaps | **`gap-2`** between controls, `gap-3` between clusters | `DataTable` toolbar `gap-2` (`DataTable.tsx:979`). Losers: `gap-1.5` (`DataTable.tsx:1015`) → fold into the same row; `gap-4` cluster splits stay where they are clusters. |
| Section stack (inside a card) | **`space-y-3`** | e.g. `Inside CardContent` blocks. `space-y-4` inside cards (`BlacklistPage.tsx:554`) → `space-y-3`. |
| Grid gaps for card grids | **`gap-3`** | `DashboardPage.tsx:222,295`, `AttckFleetPage.tsx:311` (`gap-4`) is the loser → `gap-3`. |

**Rule R3.** Page root is `space-y-5`; cards pad `p-5`; grid cells use
`DENSITY_PAD`; inter-control gap is `gap-2`; card-grid gap is `gap-3`.

### 1.4 Typography scale

| Role | Canonical className | Evidence / losers |
|---|---|---|
| **Page title** | `text-2xl font-bold tracking-tight` (single line, `PageHeader`) | `PageHeader` `ui.tsx:617` already uses `text-2xl font-bold tracking-tight sm:text-3xl`. Losers: Dashboard hero `text-[30px] … sm:text-[36px]` (`DashboardPage.tsx:180`); Blacklist/Jaillist `text-[26px] sm:text-[30px]` (`BlacklistPage.tsx:547`, `JaillistPage.tsx:251`). All → the PageHeader scale. |
| AppShell header title | `text-[15px] font-semibold tracking-tight sm:text-[16px]` | `AppShell.tsx:72`. This is a **chrome** title, not a page title; it stays small — see §2. |
| **Section title** | `text-sm font-semibold tracking-tight` | `CardTitle` (`ui.tsx:301`), `Panel` title (`ui.tsx:638` uses `text-sm font-semibold`). Loser: `TopDestinations.tsx:49` (`text-xs font-medium`) → `text-sm font-semibold tracking-tight`. |
| Body | `text-sm` | default app body. |
| Secondary / caption | `text-xs text-muted-foreground` | descriptors, hints. |
| Mono label | `.mono-label` utility (`index.css:130-137`: 11px/600/0.06em/uppercase/muted) | `Label` (`ui.tsx:312`), column headers of `RankedTable` (`ui.tsx:659`). Never re-implement with `text-xs uppercase font-mono` inline. |
| Table cell | `text-sm` comfortable / `text-xs` compact-ish | `DataTable.tsx:1137` `text-sm`. Hand-rolled tables using `text-xs` (`TopDestinations.tsx:71`, `LogsPage.tsx:490`) keep `text-xs` **only** via `SimpleTable`'s `density="compact"` prop — not ad hoc. |
| Numeric cells | append `tabular-nums`; mono only for identifiers | `DataTable.tsx:1300` adds `tabular-nums` when `align:right`. Identifiers use `font-mono`. |

**Rule R4.** No page may render its own `h1`/`h2` larger than the `PageHeader`
title (`text-2xl font-bold tracking-tight sm:text-3xl`). The AppShell `<h1>` is
chrome at `text-[15px]`. `h3` section titles are exactly
`text-sm font-semibold tracking-tight`.

### 1.5 Color usage

| Semantic token | Use it when | Forbidden |
|---|---|---|
| `bg-background` / `text-foreground` | app canvas, default text | — |
| `bg-card` | any framed surface | — |
| `bg-muted` / `text-muted-foreground` | quiet fills, secondary text, hover row tint (`hover:bg-muted/50`) | — |
| `bg-secondary` | secondary button, chip background | — |
| `bg-primary` / `text-primary` | primary button, active nav, selection tint (`bg-primary/[0.04]`, `DataTable.tsx:1268`) | — |
| `success` / `warning` / `danger` / `info` | **only via `StatusBadge`/`Badge` variants** and the inline error/callout pattern below | raw `bg-success/10 text-success` hand-written outside a primitive |
| `border-danger/30 bg-danger/10 text-danger` | **inline error callout** (the one sanctioned raw color pattern; see §3 `Callout` note) | `text-red-*`, `bg-red-*` (none exist today — verified) |
| `text-destructive` | destructive copy that is body text, not a pill | — |

**Rule R5 (no literals).** The only hex colors permitted in component files are
in `SankeyDiagram.tsx:39-62` (canvas/SVG fill math, outside Tailwind's reach —
**grandfathered**, see §5 "must not touch"). Every other color comes from a
token via a Tailwind class. `text-red-*`/`bg-green-*`/`text-blue-*` are
forbidden.

### 1.6 Focus ring

Canonical: `focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2`
(buttons, `ui.tsx:43`) — offset-2 for controls that sit on a card edge; cells
and rows use `focus-visible:ring-inset` (`ui.tsx:669`) with the global
`::focus-visible { outline: 2px solid var(--color-ring); outline-offset: 2px }`
(`index.css:141-144`) as the base.

**Rule R6.** An interactive element must expose a `ring-2 ring-ring` focus
state. `IconButton` and every row must be keyboard reachable and carry it.

### 1.7 Motion

| Role | Value | Source |
|---|---|---|
| Ease | `cubic-bezier(0.16, 1, 0.3, 1)` = `EASE` (`motion.tsx:22`) and `--default-transition-timing-function` (`index.css:67`) | one ease everywhere |
| Duration — micro (hover/press) | `150ms` (`--default-transition-duration`, `index.css:66`) | buttons, rows |
| Duration — overlay enter/exit | `180ms` in / `140ms` out (`index.css:153-156`) | dialogs, toasts |
| Duration — route/panel | `220-240ms` enter, `160ms` exit (`index.css:157-162`, `motion.tsx:141-152`) | page transitions |
| Reduced motion | `MotionConfig reducedMotion="user"` (`motion.tsx:28`) + `@media (prefers-reduced-motion)` (`index.css:173-175`) | mandatory |

**Rule R7.** New animation must use `EASE` and one of the durations above, and
must be inside `MotionGate` (`motion.tsx:27`) so reduced-motion is honored.

---

## 2. Page anatomy — the fix for "no page looks alike"

### 2.1 The decision: **pages own the title; the AppShell owns chrome only.**

The AppShell header is **static and generic** today (`AppShell.tsx:69-78`: hard-
coded title from `App.tsx:242` `title="uNetWatch"`, description
`"Pattern console"` `App.tsx:243`). It cannot be informative because it does not
know the view. Meanwhile **one** page renders a hero
(`DashboardPage.tsx:172-203`) and **no other page renders a page title at all**
(Dashboard is the only page with an in-page title; every other page's title
exists only as chrome, e.g. Sidebar labels).

**Winner: pages own their title via `PageHeader`.** Consequences:

1. `PageHeader` (`ui.tsx:612-624`) is **the** page-title primitive and stays
   page-owned. It already matches the canonical type scale — it is the winner,
   not a loser.
2. The AppShell header becomes **navigation chrome**: mobile menu button, an
   optional breadcrumb *derived from `currentView`*, and the global add-buttons.
   It must **not** render a `text-[15px]` title claiming to be the page title
   duplicating `PageHeader`'s `text-2xl` immediately below it.
3. To keep the browser tab honest, the AppShell derives `document.title` from
   the view, not from a static prop.

### 2.2 The canonical page skeleton

Every in-shell page returns exactly this shape (no exceptions; standalone pages
excluded — §5):

```
<PageShell title="…" description="…" actions={…}>
  {/* optional Toolbar row */}
  {/* sections: StatCard grids, Panel, DataTable … each auto-spaced by space-y-5 */}
</PageShell>
```

```tsx
// components/ui.tsx — NEW. PageShell is PageHeader + the canonical root wrapper
// so the two can never drift apart.
export function PageShell({
  title, description, actions, toolbar, children, className,
}: {
  title: string
  description?: string
  actions?: ReactNode      // right cluster of the title row
  toolbar?: ReactNode      // the Toolbar row, rendered between title and content
  children: ReactNode
  className?: string
}) {
  return (
    <div className={cn("space-y-5", className)}>
      <PageHeader title={title} description={description}>{actions}</PageHeader>
      {toolbar}
      {children}
    </div>
  )
}
```

**Root wrapper class is exactly `space-y-5`** (Rule R3). No `mx-auto`, no
`max-w-*` — the AppShell already centers at `max-w-[1440px]`
(`AppShell.tsx:85`).

### 2.3 Canonical page-level action placement

Page actions (search, range select, refresh, export) go in `PageHeader`'s
`children` slot (`ui.tsx:620`, `flex flex-wrap items-center gap-2`). They must
**not collide with the AppShell global add-buttons** (`AddJaillistButton`,
`AddBlacklistButton`, `AddPatternButton`, wired at `App.tsx:244-262`), which
live in the sticky header. Rule: **global add-actions in the AppShell; contextual
page actions in `PageHeader`.** If a page needs an "Add" that is not one of the
three global adds, it renders it in `PageHeader` with `variant="default"` and
the AppShell adds keep `variant="outline"`-ish secondary weight.

### 2.4 The exact change to `AppShell.tsx`

**Before** (`AppShell.tsx:68-78`):

```tsx
<div className="flex min-w-0 flex-1 flex-col">
  <header className="sticky top-0 z-40 flex h-[64px] items-center gap-3 border-b border-border bg-card px-4 sm:px-6">
    <MobileMenuButton onClick={() => setMobileOpen(true)} />
    <div className="min-w-0 flex-1">
      <h1 className="truncate text-[15px] font-semibold tracking-tight sm:text-[16px]">{title}</h1>
      {description && (
        <p className="truncate text-xs font-medium text-muted-foreground">{description}</p>
      )}
    </div>
    {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
  </header>
```

**After** — chrome keeps a *quiet* product mark, drops the pseudo-page-title and
description props, and derives `document.title` from `currentView`:

```tsx
<div className="flex min-w-0 flex-1 flex-col">
  <header className="sticky top-0 z-40 flex h-[64px] items-center gap-3 border-b border-border bg-card px-4 sm:px-6">
    <MobileMenuButton onClick={() => setMobileOpen(true)} />
    <div className="flex min-w-0 flex-1 items-center gap-2.5">
      <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-primary text-primary-foreground">
        <ShieldCheck className="h-3.5 w-3.5" aria-hidden="true" />
      </div>
      <span className="truncate text-sm font-semibold tracking-tight">{VIEW_LABELS[currentView]}</span>
    </div>
    {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
  </header>
```

with, at module scope:

```tsx
/** Chrome breadcrumb — the view's name, sourced from the sidebar's own labels
 *  so the shell and the nav cannot disagree. No description here: the page's
 *  PageHeader owns the description. */
const VIEW_LABELS: Record<View, string> = { dashboard: "Dashboard", query: "Query", /* … */ }

useEffect(() => {
  document.title = `uNetWatch — ${VIEW_LABELS[currentView]}`
}, [currentView])
```

`title` / `description` props are **removed** from `AppShellProps`
(`AppShell.tsx:10-11,20-21`) and their values deleted at `App.tsx:242-243`.
This is the single highest-impact consistency fix: it removes a chrome title
that today *looks* like a page title but is not one, and forces every page to
render a real `PageHeader`.

### 2.5 `DashboardPage.tsx` hero → canonical `PageHeader`

The duplicate hero card (`DashboardPage.tsx:172-203`) is deleted. Its contents
are re-expressed with the canonical primitives:

**Before** (`DashboardPage.tsx:171-203`) — a card with a
`text-[30px] … sm:text-[36px]` `h2`, a bespoke `mono-label` eyebrow, and a
bespoke status pill (`:186-195`).

**After:**

```tsx
<PageShell
  title="Dashboard"
  description="Live poll health, findings, and redirect watch."
  actions={
    <>
      <StatusBadge tone={isOnline ? "success" : "danger"} dot>{statusLabel}</StatusBadge>
      <span className="rounded-md border border-border bg-muted px-2 py-1 text-xs font-medium tabular-nums">
        {formatLastUpdated(lastUpdated)}
      </span>
      <RefreshIntervalSelect value={refreshSeconds} onChange={setRefreshSeconds} />
      <Button variant="outline" size="sm" onClick={onRefresh}>
        <RefreshCcw className="h-4 w-4" aria-hidden="true" /> Refresh
      </Button>
    </>
  }
>
  {/* Banner, StatCard grids, Recent findings Panel — all unchanged, now spaced by space-y-5 */}
</PageShell>
```

The eyebrow line (`DashboardPage.tsx:176-179`) is dropped: `PageHeader` has no
eyebrow slot by design (one title system, not two).

**Remaining pages adopt `PageHeader` where missing** — every page already does
except Blacklist/Jaillist, which hand-roll an eyebrow + oversized `h2`:

- `BlacklistPage.tsx:545-552` → `<PageHeader title="Blacklist" description="…" />`.
- `JaillistPage.tsx:249-256` → `<PageHeader title="Jaillist" description="…" />`.

---

## 3. Primitive contract table

Every primitive lives in `components/ui.tsx` unless noted. NEW primitives are
marked **NEW** with an exact signature and the duplicated pattern they absorb.
Class strings are the canonical ones; ad-hoc copies listed as "losers" must be
replaced.

### 3.1 `Button` — existing (`ui.tsx:42-91`) — canonical, keep

- **Purpose:** the only button surface.
- **Props:** `ComponentPropsWithRef<"button"> & { variant?: ButtonVariant; size?: ButtonSize }`.
- **Base className:** `ui.tsx:42-43` (unchanged).
- **Variants:** `default | destructive | outline | secondary | ghost`
  (`ui.tsx:45-51`). **Sizes:** `default h-9 px-4 | sm h-8 px-3 | lg h-10 px-6 | icon h-9 w-9` (`ui.tsx:53-58`).
- **States:** hover per variant, `active:scale-[0.98]`, `focus-visible:ring-2`,
  `disabled:opacity-50`.
- **Adoption:** replaces every `<button className="…">` that is a text/icon
  action. `IconButton` (below) replaces icon-only ones.

### 3.2 `Badge` — existing (`ui.tsx:228-259`) — keep

- **Purpose:** static categorical tag rendered inside a cell or list.
- **Props:** `{ children; variant?: BadgeVariant; className? }`,
  `BadgeVariant = default|secondary|destructive|outline|success|warning`
  (`ui.tsx:228`).
- **className:** `inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-medium` + variant (`ui.tsx:230-237,251`).
- **Adoption:** severity (`AttckFleetPage.tsx:85`, `AttckPanel.tsx:139`),
  action (`HostInspectorPage.tsx:822`, `EventInspectorSidebar.tsx:180,309`),
  source badges (`AttckPanel.tsx:109`). **Not** for status-with-dot — that is `StatusBadge`.

### 3.3 `StatusBadge` — **NEW**

- **Absorbs:** every hand-written "coloured pill with a state meaning":
  `EventInspectorSidebar.tsx:182` (`border-danger/20 bg-danger/10 … text-danger`),
  `:187` (`border-success/20 bg-success/10 … text-success`),
  `TopDestinations.tsx:89` (`border-warning/20 bg-warning/10 … text-warning`),
  `LogsPage.tsx:904-906` and `:965-967` (webhook success/danger tinting),
  `FindingsPage.tsx:662` (warning callout), plus the local variant mappers
  `actionVariant` (`lib/logRow.ts:62`), `severityVariant`
  (`AttckFleetPage.tsx:35`, `AttckPanel.tsx:31`),
  `riskBadgeVariant` (`HostEntityCard.tsx:13`).
- **Signature:**

```tsx
export type StatusTone = "success" | "warning" | "danger" | "info" | "neutral"

/** A status pill that is ONE component for every state meaning in the app.
 *  `label` is the human text; `tone` maps to the semantic tokens. `dot` adds
 *  the leading state dot used by live-status surfaces (online/offline). */
export function StatusBadge({
  label, tone = "neutral", dot = false, title, icon: Icon, className,
}: {
  label: ReactNode
  tone?: StatusTone
  dot?: boolean
  title?: string
  icon?: LucideIcon
  className?: string
}) { … }
```

- **Canonical className:** `inline-flex shrink-0 items-center gap-1.5 rounded-md border px-2 py-0.5 text-xs font-medium` + tone map:
  `success → bg-success/10 text-success border-success/20`,
  `warning → bg-warning/10 text-warning border-warning/20`,
  `danger → bg-danger/10 text-danger border-danger/20`,
  `info → bg-info/10 text-info border-info/20`,
  `neutral → bg-muted text-foreground border-border`.
- **Relationship to `ListBadge`** (`ui.tsx:261-288`): `ListBadge` is the
  `StatusBadge` shape **plus a required icon** and only three tones. `ListBadge`
  is reimplemented as a thin wrapper over `StatusBadge` so the two cannot drift
  (`ListBadge` keeps its icon-first API for the existing call sites).
- **Callers migrate:** every `Badge` used for a *verdict*→ `StatusBadge`; every
  raw coloured `<span>` above → `StatusBadge`.

### 3.4 Card family — existing (`ui.tsx:292-306`) — keep

`Card` (`overflow-hidden rounded-md border border-border bg-card shadow-sm`),
`CardHeader` (`flex flex-col gap-1.5 p-5 border-b border-border`),
`CardTitle` (`text-sm font-semibold tracking-tight`),
`CardContent` (`p-5`). **Adoption:** Blacklist/Jaillist `FeedCard`
(`BlacklistPage.tsx:125`) already uses it. Everything that hand-rolls
`rounded-md border border-border bg-card shadow-sm` becomes a `Card`
(`DashboardPage.tsx:173`, `BlacklistPage.tsx:554`, `JaillistPage.tsx:258`,
`AnalyticsPage.tsx:652`).

### 3.5 `Panel` — existing (`ui.tsx:628-646`) — keep, restyle header to `Toolbar`

`Panel` is the section container. Its header row (`ui.tsx:636`) is the *same
shape* as the `Toolbar` row; keep `Panel` but have its header render the shared
`Toolbar` so header paddings converge. **Adoption:** `QueryPage.tsx:1004,1019`,
`AttckFleetPage.tsx:344`, `ReportPage.tsx:424`, `AnalyticsPage.tsx:727`.

### 3.6 `StatCard` — existing (`ui.tsx:706-733`) — keep

`overflow-hidden rounded-md border border-border bg-card p-5 shadow-sm`
(`ui.tsx:714`). **Adoption:** every metric tile. Loser: bespoke KPI markup in
`ReportPage`/`HostInspectorPage` — those become `StatCard` or a documented
read-only variant (they show a value + hint, which `StatCard` already supports).

### 3.7 `EmptyState` — existing (`ui.tsx:577-588`) — keep, radius fixed

Change `rounded-lg` (`ui.tsx:579`) → `rounded-md` (Rule R1). Everything that
renders "no rows" must use it — today `RankedTable` uses a bare
`<p>` (`ui.tsx:652`), `TopDestinations` uses `EmptyCell`
(`TopDestinations.tsx:33-39`), `AttckPanel` uses a `<p>`
(`AttckPanel.tsx:113-115`). All → `EmptyState` (or `SimpleTable`'s empty slot).

### 3.8 `Dialog` — existing (`ui.tsx:337-378`) — keep

Radix-backed, `rounded-lg` content (`ui.tsx:358`), animated overlay
(`ui.tsx:355`). No changes.

### 3.9 `ConfirmDialog` — existing (`ui.tsx:560-573`) — keep

Wraps `Dialog` with a footer. No changes.

### 3.10 `Select` — existing (`ui.tsx:384-460`) — keep

Trigger `h-9 … rounded-md border border-border bg-card px-3 text-sm shadow-sm`
(default) / `h-7 … text-xs` (sm) (`ui.tsx:410-412`). Popover content
`rounded-md border border-border bg-card shadow-md` (`ui.tsx:430`). No changes.

### 3.11 `Input` — existing (`ui.tsx:145-191`) — keep

`flex h-9 w-full rounded-md border border-input bg-card px-3 py-2 text-sm` +
focus (`ui.tsx:178-184`). No changes.

### 3.12 `Textarea` — existing (`ui.tsx:193-224`) — keep

Same frame as `Input`. **Adoption:** `BlacklistPage.tsx:700-701` hand-rolls a
`<textarea>` with `border border-border bg-background` and **no rounded corners**
— replace with `Textarea`. `AddPatternDialog`/`AddBlacklistDialog`/
`AddJaillistDialog` bulk textareas likewise.

### 3.13 `SearchInput` — existing (`ui.tsx:592-608`) — keep

`relative` wrapper + `Input className="pl-9 pr-8"` + clear button. **Adoption:**
page search rows (`PatternTable.tsx:345`, `FindingsPage.tsx:610`,
`BlacklistPage.tsx:578`). Inside a table, prefer `DataTable`'s built-in quick
filter (`DataTable.tsx:980-992`).

### 3.14 `IconButton` — **NEW**

- **Absorbs** every raw icon-only button. Current copies (all identical modulo
  size):
  `AnalyticsPage.tsx:352,407,430,451`; `FindingsPage.tsx:109,151,183`;
  `HostInspectorPage.tsx:721,742,765,794,934`; `QueryPage.tsx:142`;
  `EventInspectorSidebar.tsx:195`; `BlacklistPage.tsx:258`; `LoginPage.tsx:88`;
  `NetworkGraphDiagram.tsx:382,390,398`; `Dialog`'s close
  (`ui.tsx:370`); `CopyUrlButton`'s inner Button (`ui.tsx:135`).
- **Signature:**

```tsx
export function IconButton({
  icon: Icon, label, size = "sm", variant = "ghost", tone = "default",
  className, ...props
}: {
  icon: LucideIcon
  label: string                     // required → aria-label, so none is icon-only-unlabelled
  size?: "xs" | "sm" | "md"         // 24px / 28px / 36px
  variant?: "ghost" | "outline"
  tone?: "default" | "danger"
} & Omit<ComponentPropsWithRef<"button">, "children">) { … }
```

- **Canonical className:**
  `inline-flex shrink-0 items-center justify-center rounded-md border border-transparent text-muted-foreground transition-colors hover:border-border hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50`,
  sizes `xs → h-6 w-6 [&>svg]:h-3 [&>svg]:w-3`, `sm → h-7 w-7 [&>svg]:h-3.5 [&>svg]:w-3.5`,
  `md → h-9 w-9 [&>svg]:h-4 [&>svg]:w-4`; `tone="danger" → hover:bg-danger/10 hover:text-danger`.
- **This is the single biggest de-duplication win** (~20 call sites). Every raw
  icon button with an `aria-label` becomes one line.

### 3.15 `Pagination` — existing (`ui.tsx:737-777`) — keep

No visual change; the D2 last-page fix is specified in
`table-revamp-spec.md §5.8` and must land here (`ui.tsx:773`).

### 3.16 `Skeleton` — existing (`ui.tsx:320-326`) — keep

`relative overflow-hidden rounded-md border border-border bg-muted` + shimmer.
No changes.

### 3.17 `Label` — existing (`ui.tsx:310-316`) — keep

`mono-label mb-2 block`. Adoption over hand-written `.mono-label` blocks where a
form label is meant.

### 3.18 `PageHeader` — existing (`ui.tsx:612-624`) — keep as the page title

`border-b border-border pb-4` wrapper, `h2 text-2xl font-bold tracking-tight sm:text-3xl`, children right cluster `gap-2`. Now always used **through `PageShell`** (§2.2). Losers listed in Rule R4.

### 3.19 `TimestampCell` — existing (`ui.tsx:101-111`) — keep

`block whitespace-nowrap`, relative line `text-foreground`, absolute line
`font-mono text-xs text-muted-foreground`. **Adoption:** every hand-rolled
two-line time cell. Single-line mono times (`TopDestinations` uses none; misc
pages) stay single-line but must be `font-mono text-xs text-muted-foreground`.

### 3.20 `Toolbar` — **NEW**

- **Absorbs** the three divergent toolbar implementations that should be one row
  grammar: `DataTable`'s toolbar (`DataTable.tsx:979-1077`),
  the `Panel` header row (`ui.tsx:636`), page-level control rows
  (`AnalyticsPage.tsx:651-664`, `BlacklistPage.tsx:555-591`,
  `HostInspectorPage.tsx:1238`), and the bulk bar's row shape
  (`DataTable.tsx:1090`).
- **Signature:**

```tsx
export function Toolbar({
  left, right, className, "aria-label": ariaLabel,
}: {
  left?: ReactNode     // filters / search / chips / page controls
  right?: ReactNode    // refresh / density / columns / export / view switch
  "aria-label"?: string
  className?: string
}) {
  return (
    <div
      role="toolbar"
      aria-label={ariaLabel ?? "Table controls"}
      className={cn("flex flex-wrap items-center gap-2", className)}
    >
      {left}
      <div className="ml-auto flex items-center gap-2">{right}</div>
    </div>
  )
}
```

- **Canonical className is exactly `flex flex-wrap items-center gap-2`** (the
  `DataTable.tsx:979` string, promoted). Only difference from today: the inner
  right cluster gap is `gap-2` (was `gap-1.5`, `DataTable.tsx:1015`) per Rule R3,
  and it lives in the primitive so it can never diverge again.
- **`DataTable` is refactored to render `Toolbar` internally** (`left` =
  quick-filter input + `toolbar` slot + `FilterChips` + progress hint; `right` =
  `toolbarRight` + refresh + density + columns + reset + export). The JSX and
  behavior are unchanged; only the wrapper element is the shared component.
- **`Panel`'s header** (`ui.tsx:636`) becomes
  `<Toolbar className="border-b border-border px-4 py-3" left={…} right={action} />`
  so section headers and table toolbars align.

### 3.21 `Section` — **NEW**

- **Absorbs** the ad-hoc "section heading + content stack" pattern
  (`AnalyticsPage.tsx:727`, `ReportPage.tsx:424`, and the many `space-y-3`
  groups).
- **Signature:** `Section({ title?, description?, action?, children, className })`
  rendering `Panel` when a title is present, otherwise a bare `space-y-3` stack
  — a semantic alias that keeps section spacing canonical:

```tsx
export function Section({ title, description, icon, action, children, className }: {
  title?: string; description?: string; icon?: LucideIcon; action?: ReactNode
  children: ReactNode; className?: string
}) {
  if (!title) return <div className={cn("space-y-3", className)}>{children}</div>
  return <Panel title={title} description={description} icon={icon} action={action} className={className}>{children}</Panel>
}
```

- **className:** delegates to `Panel`; bare form is `space-y-3`.

### 3.22 `ListBadge` — existing (`ui.tsx:261-288`) — keep, re-based on `StatusBadge`

Same visual; implementation becomes
`<StatusBadge tone={tone} icon={icon} title={title} label={children} />` so the
two share one className.

### 3.23 `Toast` / `ToastProvider` / `useToast` — existing (`ui.tsx:475-556`) — keep

No changes. `toastVariantStyles` (`ui.tsx:497-502`) already use tokens.

### 3.24 `TableFrame` — **NEW** (see §4)

- **Purpose:** the ONE table chrome — border, radius, background, header row,
  padding scale, empty state — shared by `DataTable`, `SimpleTable`, and every
  hand-rolled table. Exact contract in §4.
- **Signature:** `TableFrame({ children, className, ariaLabel, busy? })` wrapping
  a `<table>`, plus `TableFrameHead` helpers. Full spec §4.2.

---

## 4. Table unification contract

The owner's complaint is literal: `DataTable` draws
`overflow-x-auto rounded-md border border-border bg-card shadow-none`
(`DataTable.tsx:1129-1136`) and `TopDestinations` draws
`rounded-md border border-border bg-card shadow-sm overflow-hidden`
(`TopDestinations.tsx:46`) with **no header tint**, while `RankedTable` draws
`overflow-hidden rounded-md border border-border bg-card`
(`ui.tsx:655`) with `bg-muted/50` headers (`ui.tsx:658`) and a *different*
density (`px-3 py-2`), and `ReportPage`/`LogsPage`/`AttckPanel`/Whitelist/
BlockDomain draw *yet another* header (`text-left text-xs font-medium`) with no
background at all.

### 4.1 The convergence rule

There are **two** chrome variants and only two:

| Variant | Who uses it | Container className |
|---|---|---|
| **Grid** (full-featured) | `<DataTable>` — sortable/filterable/selectable surfaces | `overflow-x-auto rounded-md border border-border bg-card shadow-none transition-opacity duration-200` |
| **Frame** (static) | `<SimpleTable>` — small ranked/indicator/backup tables | `overflow-hidden rounded-md border border-border bg-card shadow-sm` |

Both share the **same header row** and the **same empty state**; they differ only
in `shadow` (grid defers to its panel) and `overflow-x`. That is a one-property
difference, not a different look.

**Canonical header row (BOTH):**

```
border-b border-border bg-muted/50
```
and every header cell:  `mono-label px-… py-… text-left` (compact) or
`mono-label px-… py-…` with alignment. `RankedTable` already does exactly this
(`ui.tsx:658`) — **it is the winner** that `DataTable.tsx:1139`
(`border-b border-border text-muted-foreground`, no `bg-muted/50`) and every
hand-rolled header must adopt.

**Canonical body row (BOTH):** `border-b border-border transition-colors hover:bg-muted/50` (`DataTable.tsx:1267-1268`). `divide-y divide-border` (`ui.tsx:664`, `TopDestinations.tsx:79`) is the **loser** — replaced by per-row `border-b`.

This single change — one header background, one body border model — is what
makes "table1 has a card and table2 doesn't" impossible.

### 4.2 `TableFrame` — the shared chrome primitive (NEW)

```tsx
/** The ONE table chrome. Every tabular surface renders inside this so border,
 *  radius, background, header styling and empty state are byte-identical. */
export function TableFrame({
  children, className, ariaLabel, dense = false,
}: {
  children: ReactNode
  className?: string
  ariaLabel?: string
  dense?: boolean          // compact density (px-3 py-2) for small tables
}) {
  return (
    <div className={cn("overflow-hidden rounded-md border border-border bg-card shadow-sm", className)}>
      <table className={cn("w-full", dense ? "text-xs" : "text-sm")} aria-label={ariaLabel}>
        {children}
      </table>
    </div>
  )
}

/** Header cell + row helpers so no page writes a <th> by hand. */
export const TableHeadRow = ({ children }: { children: ReactNode }) => (
  <thead><tr className="border-b border-border bg-muted/50">{children}</tr></thead>
)

export function TableHeadCell({ children, align = "left", width, dense, className }: {
  children: ReactNode; align?: "left" | "right" | "center"
  width?: string; dense?: boolean; className?: string
}) {
  return (
    <th
      scope="col"
      className={cn(
        "mono-label", dense ? "px-3 py-2" : "px-4 py-3",
        align === "right" && "text-right",
        align === "center" && "text-center",
        width, className,
      )}
    >
      {children}
    </th>
  )
}
```

`DataTable`'s own frame (`DataTable.tsx:1129-1136`) is **not replaced** (it needs
the `overflow-x-auto` + `transition-opacity` + `aria-busy`, and its header is
interactive sort/filter). Instead, §4.1 aligns its header background to
`bg-muted/50` and its empty state to the shared `EmptyState`, so it visually
matches `TableFrame`.

### 4.3 Which surface becomes what

| Surface | Today | Becomes |
|---|---|---|
| `DataTable.tsx:1129-1136` frame | grid, no header tint | Keep `DataTable`; add `bg-muted/50` to header row `:1139`. |
| `ui.RankedTable` (`ui.tsx:650-692`) | hand-rolled, `rounded-md border` + `bg-muted/50` header | Reimplement **inside** `SimpleTable` (below); keep its progress-bar cell. |
| `TopDestinations.tsx:71` and `:135` | two hand-rolled `<table>` with `bg-muted/50` headers | **`SimpleTable`** (two instances). |
| `ReportPage` indicator grids (`:492,505,518,542`) | already `<DataTable>` | Keep `<DataTable>`. |
| `LogsPage` backup preview (`LogsPage.tsx:489-511`) | hand-rolled, no card, `bg-muted/50` header | **`SimpleTable`**. |
| `AttckPanel.tsx:118-155` | hand-rolled, no card, `text-left text-xs` header | **`SimpleTable`**. |
| `DashboardPage.tsx:319-338` recent findings | hand-rolled, `bg-muted/50` | **`SimpleTable`** (or `<DataTable>` if it should sort — decision: `SimpleTable`; it is 3 columns, click-navigates). |
| `AttckFleetPage` two grids | already `<DataTable>` (`:373,407`) | Keep `<DataTable>`. |
| Whitelist/BlockDomain inline-edit review list (`WhitelistDomainPage.tsx:179-264`, `BlockDomainPage.tsx:203-287`) | hand-rolled `<table>` inside `Card` | **`SimpleTable`** with an editable cell renderer (§4.6). |

### 4.4 `SimpleTable` — the lightweight wrapper (NEW)

For surfaces too small for the full grid (ranked/indicator/backup): still typed,
still framed, **no toolbar, no selection, no pagination**.

```tsx
export interface SimpleTableColumn<T> {
  id: string
  header: ReactNode
  cell: (row: T, index: number) => ReactNode
  align?: "left" | "center" | "right"
  width?: string
  /** Optional bar cell (rank tables) — a 0..1 value rendered as a progress bar. */
  bar?: (row: T) => number
  className?: string
}

export function SimpleTable<T>({
  columns, data, rowKey, empty, dense = true, onRowClick,
  ariaLabel, className,
}: {
  columns: SimpleTableColumn<T>[]
  data: T[]
  rowKey: (row: T, index: number) => string | number
  empty?: ReactNode
  dense?: boolean
  onRowClick?: (row: T) => void
  ariaLabel?: string
  className?: string
}) { … }
```

Renders `TableFrame` → `TableHeadRow`/`TableHeadCell` →
`<tbody>` with `Stagger as="tbody"` / `StaggerItem as="tr"` (reusing
`ui.RankedTable`'s animation, `ui.tsx:664-669`) → `EmptyState` (not a bare
`<p>`) when empty. `dense` defaults `true` (this is the small-table density);
`bar` reproduces `RankedTable`'s primary/60 progress bar
(`ui.tsx:680-682`).

**`RankedTable` becomes** a thin wrapper:

```tsx
export function RankedTable({ rows, className, onRowClick }) {
  return (
    <SimpleTable
      ariaLabel="Ranked list"
      className={className}
      data={rows}
      rowKey={(r, i) => `${i}-${r.label}`}
      onRowClick={onRowClick ? (r) => onRowClick(r.label) : undefined}
      empty={<EmptyState icon={ArrowUpDown} title="No data in window" className="border-0" />}
      columns={[
        { id: "rank", header: "#", width: "w-9", dense: true, cell: (_r, i) => <span className="tabular-nums text-muted-foreground">{String(i + 1).padStart(2, "0")}</span> },
        { id: "label", header: "Label", cell: (r) => <LabelWithBar label={r.label} value={r.count} max={max} /> },
        { id: "count", header: "Count", align: "right", width: "w-20", cell: (r) => <span className="font-medium tabular-nums">{r.count.toLocaleString()}</span> },
      ]}
    />
  )
}
```

so `ui.tsx:650-692` and every hand-rolled small table collapse into `SimpleTable`.
`QueryPage.tsx:1020,1023` (the only `RankedTable` callers) need no change.

### 4.5 How `Toolbar` unifies the three toolbars

- **`DataTable` toolbar** (`:979`): becomes `<Toolbar left={…} right={…} />`,
  identical controls, canonical gaps.
- **Page-level toolbars** (`AnalyticsPage.tsx:651-664`, `BlacklistPage.tsx:555-591`,
  `HostInspectorPage.tsx:1238`): each becomes a single `<Toolbar>` — or, where it
  is the page's controls, the `PageHeader` children slot (which already IS a
  `flex flex-wrap items-center gap-2` row, `ui.tsx:620`). Decision:
  **page controls that are search/range/refresh go in `PageHeader`; controls
  that filter a specific table go in that table's `Toolbar`.**
- **`Panel` headers** (`ui.tsx:636`): become `<Toolbar className="border-b border-border px-4 py-3" left={title+icon+description} right={action} />`.
- **Bulk bar** (`DataTable.tsx:1090`): its row shape is `flex flex-wrap items-center gap-2 rounded-md border border-border bg-card px-3 py-2 text-xs font-medium shadow-sm` — kept as a distinct *bar* (it is a transient selection bar, not a toolbar) but its inner spacing must equal `gap-2` (already true) and its separator `bg-border/20` (`:1095`) → `bg-border` (Rule R5).

### 4.6 Whitelist/BlockDomain inline-edit review lists

These are standalone pages (`App.tsx:227-234`, outside `AppShell`) and are
full-page forms, not data surfaces. They must **at least share the frame**:

- Replace the hand-rolled `<table>` (`WhitelistDomainPage.tsx:180-264`,
  `BlockDomainPage.tsx:203-287`) with `<SimpleTable>` (dense), columns:
  `#` (rank, `w-12`), `Pattern`/`Value` (mono, editable cell), `Actions`
  (right, `IconButton`-based edit/remove; `IconButton` with
  `label={\`Edit ${item}\`}`).
- Their outer `<Card><CardContent className="p-0">` nesting
  (`WhitelistDomainPage.tsx:177-178`) is redundant with `TableFrame`'s own
  border — render `SimpleTable` directly and drop the wrapping `Card`, since
  `TableFrame` supplies `rounded-md border border-border bg-card shadow-sm`.
- Their `h1 text-xl font-bold` (`:170` / `:193`) is a standalone flow title, not
  a shell page title; it is **exempt** from Rule R4 because these routes are
  outside `AppShell`, but it must be normalized to the same
  `text-2xl font-bold tracking-tight` scale for cross-page consistency.

### 4.7 The empty-state convergence

`DataTable` empty (`DataTable.tsx:1237-1250`) already uses `EmptyState` with
`className="border-0"` (because the frame supplies the border). `SimpleTable`
does the same. `RankedTable`'s bare `<p>` (`ui.tsx:652`), `TopDestinations`'
`EmptyCell` (`:33-39`), and `AttckPanel`'s `<p>` (`:113`) are all deleted. **The
empty state inside any table is `EmptyState` with `border-0`.**

---

## 5. Migration plan

Ordered, grouped into independently-shippable batches. Priority = (a) highest
visual impact, (b) lowest regression risk. Each batch compiles and ships alone.

### Batch 0 — Primitives (no page changes yet)

1. `ui.tsx`: add `IconButton`, `StatusBadge`, `Toolbar`, `Section`, `PageShell`,
   `SimpleTable`, `TableFrame`/`TableHeadRow`/`TableHeadCell`; re-base
   `ListBadge` on `StatusBadge`; fix `EmptyState` radius `lg→md`
   (`ui.tsx:579`); reimplement `RankedTable` on `SimpleTable` (public API
   unchanged). **Adopts:** nothing yet. **Risk:** low (additive; `RankedTable`
   behavior must stay identical — verify progress bar + row click +
   `QueryPage.tsx:1020,1023`).
2. `DataTable.tsx`: header row `:1139` gains `bg-muted/50`; toolbar wrapper
   `:979` becomes `<Toolbar>`; separator `:1095` `bg-border/20 → bg-border`.
   **Risk:** low (visual only).

### Batch 1 — AppShell + page titles (highest visual impact)

3. `AppShell.tsx`: remove `title`/`description` props; add `VIEW_LABELS`;
   header becomes chrome (logo + view label). (`AppShell.tsx:10-11,20-21,30-32,69-78`).
4. `App.tsx:242-243`: delete `title`/`description` props.
5. `DashboardPage.tsx:171-203`: delete hero, adopt `PageShell`, `StatusBadge`.
6. `BlacklistPage.tsx:545-552` and `JaillistPage.tsx:249-256`: replace
   hand-rolled eyebrow + `text-[26px]` `h2` with `PageHeader`/`PageShell`.
   **Adopts:** `PageShell`, `PageHeader`, `StatusBadge`. **Risk:** medium
   (AppShell prop removal touches `App.tsx`; run `tsc --noEmit`).

### Batch 2 — Table chrome convergence

7. `TopDestinations.tsx:71,135`: two hand-rolled tables → `SimpleTable`; drop
   `EmptyCell`.
8. `AttckPanel.tsx:118-155`: → `SimpleTable`.
9. `LogsPage.tsx:489-511`: backup preview → `SimpleTable`.
10. `DashboardPage.tsx:319-338`: recent findings → `SimpleTable`.
    **Adopts:** `SimpleTable`, `TableFrame`, `EmptyState`. **Risk:** low
    (read-only renders; verify truncation widths and row-click navigation).

### Batch 3 — Icon buttons + status pills (broad, mechanical)

11. Replace all raw icon-only buttons with `IconButton`:
    `AnalyticsPage.tsx:352,407,430,451`; `FindingsPage.tsx:109,151,183`;
    `HostInspectorPage.tsx:721,742,765,794,934`; `QueryPage.tsx:142`;
    `EventInspectorSidebar.tsx:195`; `BlacklistPage.tsx:258`; `LoginPage.tsx:88`;
    `NetworkGraphDiagram.tsx:382,390,398`; `ui.tsx:370`.
12. Replace status pills with `StatusBadge`:
    `EventInspectorSidebar.tsx:182,187`; `TopDestinations.tsx:89`;
    `LogsPage.tsx:904-906,965-967`; `FindingsPage.tsx:662`; plus the variant
    mappers `AttckFleetPage.tsx:35`, `AttckPanel.tsx:31`, `HostEntityCard.tsx:13`.
    **Adopts:** `IconButton`, `StatusBadge`. **Risk:** medium (many files, but
    each edit is local and behavior-preserving; verify `aria-label` is preserved).

### Batch 4 — Toolbar + Panel header unification

13. `AnalyticsPage.tsx:651-664`, `BlacklistPage.tsx:555-591`,
    `HostInspectorPage.tsx:1238`: page control rows → `Toolbar` or `PageHeader`
    children.
14. `ui.tsx:636` `Panel` header → `Toolbar`.
    **Adopts:** `Toolbar`. **Risk:** low-medium (spacing shifts; verify the
    Analytics date-range cluster and Blacklist add+search rows still wrap).

### Batch 5 — Standalone review pages

15. `WhitelistDomainPage.tsx:177-264` and `BlockDomainPage.tsx:203-287`:
    hand-rolled table → `SimpleTable`; drop redundant `Card` wrapper; normalize
    title scale.
    **Adopts:** `SimpleTable`, `IconButton`. **Risk:** medium (editable cell +
    save/cancel state machine must be preserved exactly).

### Files that must NOT be touched

- `SankeyDiagram.tsx` / `NetworkGraphDiagram.tsx` canvas & SVG fill math
  (`:39-62`) — colors are computed per node, outside Tailwind; only the zoom
  `IconButton`s (`NetworkGraphDiagram.tsx:382,390,398`) are in scope.
- `motion.tsx` — the motion contract is already canonical.
- `index.css` — tokens are the source of truth; do not add tokens here without a
  token-level decision.
- `DataTable.tsx` internals beyond Batch 0's three lines (the grid engine,
  sorting, filtering, export, persistence) — governed by
  `table-revamp-spec.md`.
- `loading/*` — already canonical (elapsed-time feedback).
- `LoginPage.tsx` beyond the `IconButton` swap at `:88`.

---

## 6. Acceptance criteria

Each rule is checkable. Commands run from `admin-ui/`.

| # | Rule | Proof command |
|---|---|---|
| AC1 | Every in-shell page root wrapper is exactly `space-y-5` (no `space-y-4`/`space-y-6` at page root). | `grep -rn 'className="space-y-6"' src/components/*Page.tsx src/components/PatternTable.tsx` → expect **no matches**; `grep -rn 'return (\n.*<div className="space-y-5"' ` is the positive form (spot-check each page). |
| AC2 | No page renders its own `h1`/`h2` larger than the `PageHeader` scale. | `grep -rn 'text-\[30px\]\|text-\[36px\]\|text-\[26px\]\|text-\[28px\]' src/components/*.tsx` → expect **no matches**. `grep -rn '<h1\|<h2' src/components/*.tsx` → all `text-2xl`-or-smaller (AppShell `<h1>` is chrome). |
| AC3 | No raw `<table>` remains outside `TableFrame`/`SimpleTable`/`DataTable`. | `grep -rn "<table" src/components/*.tsx` → matches **only** in `ui.tsx` (`TableFrame`/`SimpleTable`), `DataTable.tsx:1137`. |
| AC4 | Every table header row uses `bg-muted/50`. | `grep -rn "border-b border-border" src/components/*.tsx \| grep -v "bg-muted"` → expect **no header rows**; spot-check each `<thead>`. |
| AC5 | No hard-coded hex or `text-red-*`/`bg-green-*` etc. outside the grandfathered SVG file. | `grep -rn '#[0-9a-fA-F]\{3,6\}\|text-red-\|bg-red-\|text-green-\|bg-green-\|text-blue-\|text-gray-' src/components/*.tsx \| grep -v 'SankeyDiagram'` → expect **no matches**. |
| AC6 | Every icon-only button is `IconButton` (no raw `inline-flex h-6 w-6 …`/`h-7 w-7 …` buttons). | `grep -rn 'inline-flex h-6 w-6\|inline-flex h-7 w-7\|inline-flex h-8 w-8' src/components/*.tsx` → expect **no matches** in components (NetworkGraphDiagram zoom controls use `IconButton size="md"`). |
| AC7 | Every status pill is `StatusBadge`/`Badge`/`ListBadge` (no raw `bg-danger/10 text-danger` pill spans outside the callout pattern). | `grep -rn 'rounded-full border.*bg-\(danger\|success\|warning\|info\)/10' src/components/*.tsx` → expect **no matches**. |
| AC8 | Exactly one `PageHeader`/`PageShell` title per in-shell page. | `grep -c "<PageHeader\|<PageShell" src/components/*Page.tsx` → each page has exactly 1 (except pages with zero-page-title paths, which must still be 1 on the primary return). |
| AC9 | `DataTable` toolbar and page toolbars share one wrapper. | `grep -rn 'mb-2 flex flex-wrap items-center gap-2' src/components/*.tsx` → expect **no matches** (moved into `Toolbar`). |
| AC10 | No empty `<p>No data</p>` inside a table — tables use `EmptyState`. | `grep -rn 'No data in window' src/components/*.tsx` → only inside `EmptyState`-bearing code (`ui.tsx`), not bare `<p>` in `TopDestinations`/`RankedTable`/`AttckPanel`. |
| AC11 | `AppShell` no longer accepts `title`/`description`. | `grep -n 'title' src/components/AppShell.tsx` → no `title:` prop in `AppShellProps`; `grep -n 'title=' src/App.tsx` → no `title=`/`description=` on `<AppShell>`. |
| AC12 | Focus rings survived: every interactive primitive has `focus-visible:ring-2 focus-visible:ring-ring`. | `grep -c 'focus-visible:ring-2 focus-visible:ring-ring' src/components/ui.tsx` → ≥ number of interactive primitives; `grep -rn 'focus-visible:outline-none' src/components/ui.tsx` → every occurrence paired with `ring`. |
| AC13 | Reduced motion intact. | `grep -n 'reducedMotion' src/components/motion.tsx` and `grep -n 'prefers-reduced-motion' src/index.css` → both present; no new animation outside `MotionGate`. |
| AC14 | Radius discipline. | `grep -rn 'rounded-xl\|rounded-2xl' src/components/*.tsx` → **no matches**; `grep -rn 'rounded-lg' src/components/*.tsx` → only `ui.tsx` dialog + standalone hero plates. |
| AC15 | No double shadows on grid frames. | `grep -rn 'rounded-md border border-border bg-card shadow-sm' src/components/ui.tsx` restricts card/panel/frame; `DataTable.tsx` frame is `shadow-none`. |

---

## Appendix A — Decision ledger (what wins, what loses)

| Conflict | Winner | Loser(s) |
|---|---|---|
| Page title ownership | `PageHeader` (page-owned) | AppShell static title (`AppShell.tsx:72`) |
| Dashboard hero | `PageHeader` | `text-[30px]` hero card (`DashboardPage.tsx:172-203`) |
| Blacklist/Jaillist title | `PageHeader` `text-2xl` | `text-[26px] sm:text-[30px]` (`BlacklistPage.tsx:547`, `JaillistPage.tsx:251`) |
| Table header tint | `bg-muted/50` (`ui.tsx:658`) | no-tint headers (`DataTable.tsx:1139`, `TopDestinations.tsx:73`, `LogsPage.tsx:492`) |
| Table body borders | per-row `border-b border-border` | `divide-y divide-border` (`ui.tsx:664`, `TopDestinations.tsx:79`) |
| Page root spacing | `space-y-5` | `space-y-4`, `space-y-6` |
| Card padding | `p-5` | `p-4`, `p-6` at surface level |
| Toolbar wrapper | `Toolbar` (`gap-2`) | inline `mb-2 flex flex-wrap items-center gap-2` (`DataTable.tsx:979`), `gap-1.5` right cluster |
| Icon buttons | `IconButton` | ~20 raw `inline-flex h-6 w-6 …` copies |
| Status pills | `StatusBadge` | raw colored spans (`EventInspectorSidebar.tsx:182`, `TopDestinations.tsx:89`, `LogsPage.tsx:904`) |
| Empty state | `EmptyState border-0` | bare `<p>` (`ui.tsx:652`), `EmptyCell` (`TopDestinations.tsx:33`) |
| Radius | `rounded-md` (lg only for dialogs/hero plates) | `rounded-lg` on `EmptyState` (`ui.tsx:579`) |
| Separator color | `bg-border` | `bg-border/20` (`DataTable.tsx:1095`) |

## Appendix B — NEW primitives and the duplication they absorb

| Primitive | Absorbs | Sites |
|---|---|---|
| `IconButton` | raw icon-only buttons | `AnalyticsPage.tsx:352,407,430,451`; `FindingsPage.tsx:109,151,183`; `HostInspectorPage.tsx:721,742,765,794,934`; `QueryPage.tsx:142`; `EventInspectorSidebar.tsx:195`; `BlacklistPage.tsx:258`; `LoginPage.tsx:88`; `NetworkGraphDiagram.tsx:382,390,398`; `ui.tsx:370` |
| `StatusBadge` | raw status pills + variant mappers | `EventInspectorSidebar.tsx:182,187`; `TopDestinations.tsx:89`; `LogsPage.tsx:904,965`; `FindingsPage.tsx:662`; `AttckFleetPage.tsx:35`; `AttckPanel.tsx:31`; `HostEntityCard.tsx:13` |
| `Toolbar` | table toolbar + panel header + page control rows | `DataTable.tsx:979`; `ui.tsx:636`; `AnalyticsPage.tsx:651`; `BlacklistPage.tsx:555`; `HostInspectorPage.tsx:1238` |
| `Section` | ad-hoc section header + stack | `AnalyticsPage.tsx:727`; `ReportPage.tsx:424` |
| `PageShell` | page root wrapper + `PageHeader` | every page return |
| `TableFrame` / `SimpleTable` | hand-rolled small tables | `ui.tsx:650-692`; `TopDestinations.tsx:71,135`; `AttckPanel.tsx:118`; `LogsPage.tsx:490`; `DashboardPage.tsx:320`; `WhitelistDomainPage.tsx:180`; `BlockDomainPage.tsx:203` |
