# Chrome Consistency Audit — admin-ui page shells

Scope: every page component in `admin-ui/src/components/` plus the two shell
components. Read-only audit; no file was modified.

- **Shell**: `AppShell.tsx:69` renders a static header — `h1` = `"uNetWatch"`
  (`AppShell.tsx:72`, `text-[15px] font-semibold tracking-tight sm:text-[16px]`),
  `description` = `"Pattern console"` (`App.tsx:242-243`), and global actions
  (`AddJaillistButton`, `AddBlacklistButton`, `AddPatternButton`, `App.tsx:246-260`).
  Main content is wrapped at `AppShell.tsx:83`
  (`relative flex-1 px-4 py-6 sm:px-6 lg:px-8`) and `AppShell.tsx:85-86`
  (`mx-auto w-full max-w-[1440px]` / `w-full fade-in cv-auto`).
- **Vocabulary available** in `ui.tsx`: `PageHeader` (`ui.tsx:612`, `text-2xl
  font-bold ... sm:text-3xl`), `Panel` (`ui.tsx:628`), `Card`/`CardHeader`/
  `CardContent` (`ui.tsx:292-306`), `EmptyState` (`ui.tsx:577`),
  `Skeleton` (`ui.tsx:320`), `LoadingIndicator` (`ui.tsx:332`),
  `SearchInput` (`ui.tsx:592`), `Button`, `Badge`, `StatCard` (`ui.tsx:706`).

Two page families exist and are drawn with **entirely different chrome**:

| Family | Renders inside `AppShell` | File(s) |
|---|---|---|
| **Shell pages** | yes | Dashboard, Query, Patterns, Findings, Blacklist, Jaillist, Redirects, Logs, Host, URL, Analytics, ATT&CK, Report |
| **Standalone pages** | no — their own full-viewport shell | `LoginPage`, `WhitelistDomainPage`, `BlockDomainPage` (`App.tsx:226-234` mounts the latter two outside `AppShell`) |

---

## 1. Root wrapper

Every shell page opens with a **`space-y-*` stack**, but the step differs
(`space-y-4` vs `space-y-5` vs `space-y-6`) with no visible rule.

| Page | Anchor | Root wrapper className |
|---|---|---|
| DashboardPage | `DashboardPage.tsx:171` | `"space-y-5"` |
| QueryPage | `QueryPage.tsx:816` | `"space-y-6"` |
| PatternTable | `PatternTable.tsx:339` | `"space-y-4"` |
| FindingsPage | `FindingsPage.tsx:604` | `"space-y-4"` |
| BlacklistPage | `BlacklistPage.tsx:544` | `"space-y-6"` |
| JaillistPage | `JaillistPage.tsx:248` | `"space-y-6"` |
| RedirectsPage | `RedirectsPage.tsx:657` | `"space-y-6"` |
| LogsPage | `LogsPage.tsx:661` | `"space-y-4"` |
| HostInspectorPage | `HostInspectorPage.tsx:1002` | `"space-y-5"` |
| UrlInvestigationPage | `UrlInvestigationPage.tsx:235` | `"space-y-5"` |
| AnalyticsPage | `AnalyticsPage.tsx:625` | `"space-y-5"` |
| AttckFleetPage | `AttckFleetPage.tsx:266` | `"space-y-6"` |
| ReportPage | `ReportPage.tsx:379` and `:409` | `"space-y-5"` (both early-return and main) |
| LoginPage | `LoginPage.tsx:29` | `"relative flex min-h-dvh items-center justify-center bg-background px-4 py-10 sm:py-16"` — **no `space-y`** |
| WhitelistDomainPage | `WhitelistDomainPage.tsx:102`, `:128`, `:163` | `flex min-h-dvh ...` / `flex min-h-dvh items-start justify-center bg-background px-4 py-10 sm:py-16` — **no `space-y` at root** |
| BlockDomainPage | `BlockDomainPage.tsx:111`, `:137`, `:186` | same as Whitelist |
| AppShell | `AppShell.tsx:40` | `"flex min-h-dvh bg-background text-foreground"` (app frame, N/A) |
| Sidebar | `Sidebar.tsx:187` | `"flex h-full flex-col bg-sidebar text-sidebar-foreground"` (N/A) |

**Finding:** three distinct vertical rhythms (`4`/`5`/`6`) for the same "page
body" concept. There is no `PageBody`/`PageShell` primitive — each page
hand-writes its stack.

---

## 2. In-page page-title / hero header

This is the sharpest divergence. **Five different title treatments** appear:

**(a) Canonical `PageHeader`** (`ui.tsx:612-623`) — title `text-2xl font-bold
tracking-tight sm:text-3xl`, with `border-b border-border pb-4`:

| Page | Anchor |
|---|---|
| QueryPage | `QueryPage.tsx:818` (`title="Query"`) |
| PatternTable | `PatternTable.tsx:341` (`title="Patterns"`) |
| FindingsPage | `FindingsPage.tsx:605` (`title="Findings"`) |
| RedirectsPage | `RedirectsPage.tsx:659` (`title="Redirect Tracker"`) |
| LogsPage | `LogsPage.tsx:663` (`title="Logs"`) |
| HostInspectorPage | `HostInspectorPage.tsx:1003` (`title="Host Investigation"`) |
| UrlInvestigationPage | `UrlInvestigationPage.tsx:236` (`title="URL Investigation"`) |
| AnalyticsPage | `AnalyticsPage.tsx:626` (`title="Analytics & Reports"`) |
| AttckFleetPage | `AttckFleetPage.tsx:267` (`title="ATT&CK Coverage"`) |
| ReportPage | `ReportPage.tsx:380` and `:410` (`title="Investigation report"` / `Investigation report — ${value}`) |

**(b) Hand-rolled hero card** — DashboardPage does **not** use `PageHeader`.
It renders a full `Card`-shaped slab with its own eyebrow, an oversized
`text-[30px] ... sm:text-[36px]` title, and its own status+refresh toolbar
inline:

```
DashboardPage.tsx:173   <div className="rounded-md border border-border bg-card shadow-sm overflow-hidden">
DashboardPage.tsx:174     <div className="flex flex-wrap items-start justify-between gap-4 p-5 sm:p-6">
DashboardPage.tsx:178       <span className="mono-label">Dashboard · uNetWatch</span>
DashboardPage.tsx:180       <h2 className="mt-1 text-[30px] font-semibold tracking-tight sm:text-[36px]">Dashboard</h2>
DashboardPage.tsx:181       <p className="mt-1 max-w-[52ch] text-xs font-medium text-muted-foreground">
```
This is the **only** page at `36px`; `PageHeader` is `text-3xl` = 30px.

**(c) Hand-rolled `mono-label` + `[26px]/[30px]` header** — the blacklist/jaillist
family renders a *third* title size with an eyebrow line:

```
BlacklistPage.tsx:545   <div className="border-b border-border pb-4">
BlacklistPage.tsx:546     <p className="mono-label">Blacklist</p>
BlacklistPage.tsx:547     <h2 className="font-semibold tracking-tight mt-1 text-[26px] sm:text-[30px]">Blacklist</h2>
BlacklistPage.tsx:548     <p className="mt-1.5 max-w-[60ch] text-xs font-medium leading-relaxed text-muted-foreground">
```
```
JaillistPage.tsx:249   <div className="border-b border-border pb-4">
JaillistPage.tsx:250     <p className="mono-label">Jaillist</p>
JaillistPage.tsx:251     <h2 className="font-semibold tracking-tight mt-1 text-[26px] sm:text-[30px]">Jaillist</h2>
```
Note the duplicate-ish subtitle: `Blacklist`/`Jaillist` appear as **both** the
eyebrow (`mono-label`) *and* the `h2`, plus a third prose line below.

**(d) Standalone centered hero** — Whitelist/Block render their own
full-height centered brand header (`text-xl font-bold`), Login renders
`text-[22px]`:

```
WhitelistDomainPage.tsx:170  <h1 className="text-xl font-bold tracking-tight">Confirm whitelist add</h1>
BlockDomainPage.tsx:193      <h1 className="text-xl font-bold tracking-tight">Confirm blacklist add</h1>
LoginPage.tsx:39             <h1 className="mt-4 text-[22px] font-semibold tracking-tight">uNetWatch</h1>
```

**(e) No title at all** — none; every page has some title.

**Does it duplicate the AppShell header?** Yes, **every shell page** duplicates
the static `"uNetWatch"` header. The shell header says "uNetWatch / Pattern
console"; every page then prints its own page title right beneath it, so users
see two stacked title bands. `DashboardPage.tsx:178` even re-prints the product
name in the eyebrow (`"Dashboard · uNetWatch"`), which is the shell title again.
The brand also appears a **third** time in the sidebar (`Sidebar.tsx:196-197`,
`uNetWatch` / `Pattern console`) — identical strings to `App.tsx:242-243`.

Title-size inventory in one list: `text-[36px]` (DashboardPage:180 sm),
`text-[30px]` (DashboardPage:180 base), `text-3xl`/`text-2xl` (PageHeader
`ui.tsx:617`), `text-[30px]`/`text-[26px]` (Blacklist/Jaillist :547/:251),
`text-xl` (Whitelist:170, Block:193), `text-[22px]` (Login:39),
`text-lg` (standalone empty/result screens :109/:135/:118/:144).

---

## 3. Toolbar row

Three toolbar idioms, plus pages with none:

**(a) Toolbar folded into `PageHeader` children** (controls in the header's
right cluster, `ui.tsx:620` `flex flex-wrap items-center gap-2`) — the
**dominant** pattern: QueryPage (`:822-904`), PatternTable (`:345-368`),
FindingsPage (`:609-650`), RedirectsPage (`:663-698`), LogsPage (`:667-711`),
HostInspector (`:1007-1021`), UrlInvestigation (`:240-243`),
AnalyticsPage (`:627-648`), AttckFleetPage (`:272-282`).

**(b) Toolbar in its own bordered card** — HostInspector and UrlInvestigation
both do this *in addition to* (a), and both carry a comment claiming they match
each other:

```
HostInspectorPage.tsx:1024  {/* Standardized search toolbar - matches URL Investigation's card form. */}
HostInspectorPage.tsx:1025  <div className="rounded-md border border-border bg-card p-4 shadow-sm">
```
```
UrlInvestigationPage.tsx:246  {/* Standardized search toolbar - matches Host Investigation's card form. */}
UrlInvestigationPage.tsx:248  className="rounded-md border border-border bg-card p-4 shadow-sm"
```
AnalyticsPage uses the same inline card, **without** the comment:
`AnalyticsPage.tsx:652` `<div className="rounded-md border border-border bg-card p-4 shadow-sm">`.

DashboardPage puts its toolbar inside the hero card (`DashboardPage.tsx:185-201`).

Blacklist/Jaillist put controls inside a `p-4` card:
`BlacklistPage.tsx:554` / `JaillistPage.tsx:258`
`"rounded-md border border-border bg-card shadow-sm space-y-4 p-4"`.

RedirectsPage splits its toolbar: add/search in the `PageHeader`
(`:663-698`), but a **second** search+count row in a bare `div` below the flow
card (`RedirectsPage.tsx:803-816`, `mb-3 flex flex-wrap items-center justify-between gap-2`).

**(c) `DataTable` internal toolbar** — filters/sort/bulk live inside the table
component (`DataTable.tsx:1091` `role="toolbar"`, sticky header
`DataTable.tsx:1146`, bulk bar `DataTable.tsx:1146`-region
`mb-3 flex flex-wrap items-center gap-2 rounded-md border border-border bg-card px-3 py-2 text-xs font-medium text-foreground shadow-sm`).

**Sticky?** Only `DataTable`'s header is sticky (`DataTable.tsx:1146`
`sticky top-0 z-20 bg-card`). No toolbar row on any page is sticky.

**Bordered?** Inconsistent: (a) is unbordered and floats in the header; (b)
is bordered (`border border-border`); (c) is bordered. Dashboard's toolbar is
bordered only because it sits inside the hero card.

---

## 4. Spacing scale used

Distinct tokens observed, grouped by owner:

- **Root stack**: `space-y-4` (PatternTable:339, FindingsPage:604, LogsPage:661);
  `space-y-5` (DashboardPage:171, HostInspector:1002, UrlInvestigation:235,
  Analytics:625, Report:379/409); `space-y-6` (QueryPage:816, Blacklist:544,
  Jaillist:248, Redirects:657, AttckFleet:266); `space-y-6` again inside
  QueryPage result (`:993`).
- **Card padding**: `p-5 sm:p-6` (DashboardPage:174 hero);
  `p-5` (`CardHeader` ui.tsx:297, `CardContent` ui.tsx:305, `StatCard`
  ui.tsx:714); `p-4 sm:p-5` (`Panel` body ui.tsx:643);
  `p-4` (HostInspector:1025, UrlInvestigation:248, Analytics:652,
  Blacklist:554, Jaillist:258); `px-4 py-3` (`Panel` header ui.tsx:636,
  RedirectsPage:712); `px-4 py-3` (error banners); `p-6 sm:p-8` (LoginPage:33
  `p-8 sm:p-8` — which is itself a redundancy: both branches are `p-8`).
- **Grid gaps**: `gap-3` (DashboardPage:222/295/356, UrlInvestigation:285/296,
  Analytics:690/698), `gap-4` (QueryPage:908/1018, Redirects:702,
  Analytics:726/760, AttckFleet:313), `gap-4` (PageHeader children ui.tsx:615).
- **Panel-header border**: `px-4 py-3` everywhere via `Panel`, *except*
  RedirectsPage's hand-rolled flow card which replicates it manually
  (`RedirectsPage.tsx:712`).

Summary of the three sets: `space-y-4`-pages, `space-y-5`-pages, and
`space-y-6`-pages all coexist, and within a single page the toolbar card can be
`p-4` while its siblings come from `Panel`'s `p-4 sm:p-5`.

---

## 5. Section chrome

Four section vocabularies are in use simultaneously:

**(a) `Panel`** (`ui.tsx:628`, slab `rounded-md border border-border bg-card
shadow-sm`, header `px-4 py-3`, body `p-4 sm:p-5`): DashboardPage:303,
QueryPage:1004/1019/1022/1029/1136, FindingsPage:683, UrlInvestigation:340,
AnalyticsPage:727/742/761, AttckFleetPage (`Panel title="Fleet summary"`),
ReportPage:381/424/444/457/474.

**(b) `Card`/`CardHeader`/`CardContent`** (`ui.tsx:292-306`): BlacklistPage
`FeedCard` (`BlacklistPage.tsx:125` `<Card>`, `:126` `<CardHeader>`, `:187`
`<CardContent className="space-y-3">`), JaillistPage reuses the same `FeedCard`,
LoginPage:31 (`rounded-md border border-border bg-card shadow-sm overflow-hidden`),
Whitelist:103/129/177, Block:112/138/200.

**(c) Hand-rolled slabs that duplicate `Panel`/`Card`** — DashboardPage hero
(`:173`), RedirectsPage flow card (`:711` `cv-auto overflow-hidden rounded-md
border border-border bg-card shadow-sm`), and the two toolbar cards
(HostInspector:1025, UrlInvestigation:248, Analytics:652), and the
blacklist/jaillist control card (`:554` / `:258`). Note the Dashboard hero and
the Redirects flow card are literally the same className string
(`rounded-md border border-border bg-card shadow-sm`) as `Panel`'s own slab
(`ui.tsx:634`) — a hand-copy of the primitive.

**(d) Raw `div`s / bare tables** — DashboardPage's "Recent findings" table is a
hand-rolled `<table>` (`DashboardPage.tsx:319-338`) rather than a `DataTable`;
RedirectsPage's history dialog hand-rolls edge rows (`:941-964`); PatternTable's
bulk-edit `Dialog` bodies are raw `div.space-y-4` (`:462`, `:496`).

---

## 6. Loading / empty / error

### Loading

Three primitives, inconsistently applied:

- `LoadingIndicator` (the "honest elapsed" primitive): DashboardPage:305,
  QueryPage:959/997, PatternTable:384, FindingsPage:674, RedirectsPage:821,
  LogsPage:717, HostInspector:1058/1102, AnalyticsPage:681.
- **Not used at all** by BlacklistPage, JaillistPage, UrlInvestigationPage,
  AttckFleetPage, ReportPage (0 hits — see grep counts). Blacklist/Jaillist show
  a hand-rolled "Refreshing feed…" spinner instead:
  `BlacklistPage.tsx:213-221` `inline-flex items-center gap-1.5 text-xs
  font-medium text-muted-foreground` + `LoadingIcon`.
- `Skeleton` grids: used by Dashboard:316, QueryPage:967-972, Blacklist:225,
  Redirects:731/931, Logs:733, HostInspector:1065-1067, UrlInvestigation:286-291,
  Analytics:691-696, AttckFleet:287, Report:448/461/479. PatternTable and
  FindingsPage have **zero** `Skeleton` — they rely on `DataTable`'s built-in
  skeleton (`DataTable.tsx:1213-1227`).
- AttckFleet uses a bare `Skeleton` with a screen-reader span:
  `AttckFleetPage.tsx:284-288`; ReportPage:446-449 uses the same
  `aria-busy/aria-live + sr-only + Skeleton` idiom.

### Empty

- **`EmptyState` primitive** (`ui.tsx:577`): Dashboard:345, QueryPage
  (5 uses, e.g. `:981`, `:1008`, `:1091`, `:1126`), Blacklist:269/282,
  Redirects:743/836, Logs:736, HostInspector:1083/1087 (inline, single line),
  UrlInvestigation:368, AttckFleet (`EmptyState` in fleet panels).
- **`DataTable.empty={{...}}` config** (delegated `EmptyState`): QueryPage:1206,
  PatternTable:410, FindingsPage:706, Logs:776, UrlInvestigation:354.
- **Bare centered `<p>`** as empty text — a fourth convention:
  `RedirectsPage.tsx:760` `<p className="py-8 text-center text-sm
  text-muted-foreground">`, `RedirectsPage.tsx:966`,
  `ReportPage.tsx:483`, and `RankedTable`'s own fallback
  (`ui.tsx:652`). ReportPage has **zero** `EmptyState` uses — its "no data"
  states are either `<p className="py-8 text-center text-sm text-muted-foreground">`
  or `Panel`-level prose (`ReportPage.tsx:453`, `:469`).
- Whitelist/Block/Login have **no empty state** — irrelevant (standalone).

### Error — this is the worst offender: **five** hand-rolled banner shapes

Every page writes its own banner; there is no `ErrorBanner`/`InlineAlert`
primitive in `ui.tsx` (only `Toast`, `ui.tsx:504`). The five shapes:

1. **`border-danger/40 bg-danger/10 ... text-destructive`, `items-center`** —
   PatternTable:373, FindingsPage:654, Blacklist:595/606, Jaillist:299/310,
   Redirects:735/829/934, Logs:725, Whitelist:270, Block:293.
   ```
   className="flex items-center gap-3 rounded-md border border-danger/40 bg-danger/10 px-4 py-3 text-xs font-medium text-destructive"
   ```
2. **`border-danger/30 ... text-danger`, `items-center`** — Dashboard only:
   DashboardPage:280 / :286 / :340.
   ```
   className="flex items-center gap-3 rounded-md border border-danger/30 bg-danger/10 px-4 py-3 text-xs font-medium text-danger"
   ```
   (differs from #1 by `/30` vs `/40` **and** `text-danger` vs `text-destructive`.)
3. **`rounded-lg border-danger/30 ... text-danger flex items-center
   justify-between`** — HostInspector:1072/:1094/:1305, Analytics:672/:823,
   UrlInvestigation:277.
   ```
   className="rounded-lg border border-danger/30 bg-danger/10 px-4 py-3 text-xs text-danger flex items-center justify-between gap-3"
   ```
   (differs again: `rounded-lg` vs `rounded-md`; `justify-between` vs `gap-3`
   flex layout; no `font-medium`.)
4. **`rounded-md ... flex flex-col gap-2 p-3 text-danger`** — AttckFleet:294
   (a *fourth* geometry: `flex-col`, `p-3` not `px-4 py-3`).
   ```
   className="flex flex-col gap-2 rounded-md border border-danger/30 bg-danger/10 p-3 text-xs text-danger"
   ```
5. **warning variant for partial failure** — FindingsPage:662 only:
   ```
   className="flex items-center gap-3 rounded-md border border-warning/20 bg-warning/10 px-4 py-3 text-xs font-medium text-warning"
   ```
Plus LogsPage has a *sixth* inline error inside the backup panel
(`LogsPage.tsx:1019` `inline-flex items-start gap-2 border border-danger/40 ...`).

Retry-button labelling also drifts: `"Retry"` (most), `"Try again"`
(Dashboard:282? no — Dashboard uses `Retry`; `Try again` appears at
HostInspector:1074, UrlInvestigation:279, Whitelist:272, Block:295), and
QueryPage's failure uses **`EmptyState`** rather than a banner
(`QueryPage.tsx:981` `title="Query failed"`).

Toasts (`useToast`) are additionally fired on the same failures in
DashboardPage (`:109`, `:126`, `:151`) — so Dashboard surfaces a *toast* + a
*banner* + a *LoadingIndicator* for one failure path, while PatternTable shows
only a banner.

---

## 7. Header actions vs page actions (collisions)

The shell header already offers global mutators: `AddJaillistButton`,
`AddBlacklistButton`, `AddPatternButton` (`App.tsx:246-260`). Several pages
render **competing** primary actions for the same resources:

- **PatternTable** renders its own add button in the header cluster
  (`PatternTable.tsx:353` `<AddPatternButton onOpen={...} />`) plus a
  "Bulk import" button (`:354`). → *Two "Add Pattern" buttons* on screen at once
  (shell header + page header), literally the same component.
- **BlacklistPage** renders its own "Add" + "Bulk add" controls
  (`BlacklistPage.tsx:565-573`) while the shell shows `AddBlacklistButton`.
- **JaillistPage** renders its own "Add" + "Bulk add" (`JaillistPage.tsx:269-277`)
  while the shell shows `AddJaillistButton`.
- **FindingsPage** renders a destructive "Clear all" (`FindingsPage.tsx:624-633`)
  — a page-level primary action with no shell equivalent (fine, but it sits in
  the same slot as the shell's add buttons, so the top-right of the screen has
  mixed global+page actions with no separator).
- **UrlInvestigationPage** renders "Whitelist URL" / "Blacklist URL"
  (`UrlInvestigationPage.tsx:328-337`) as bare `Button`s in the body.
- **RedirectsPage** renders a primary "Track URL" (`RedirectsPage.tsx:688`) in
  the header cluster.

Net: the top-right region is a mix of shell-level add buttons (always present)
and page-level primary buttons (sometimes present), with no visual separation —
e.g. on Patterns the user sees **[Add Jaillist] [Add Blacklist] [Add Pattern]**
(shell) immediately followed by **[Search] [type] [Add Pattern] [Bulk import]**
(page).

---

## DRIFT SUMMARY TABLE

| Page | Root wrapper | Own title? | Toolbar wrapper | Section chrome | Loading prim | Empty prim | Error prim |
|---|---|---|---|---|---|---|---|
| **DashboardPage** | `space-y-5` (:171) | **Yes — hand-rolled hero card**, `text-[30px] sm:text-[36px]` (:173-184) | inside hero card, `p-5 sm:p-6` (:185-201) | `Panel` + `StatCard` + hand-rolled `<table>` (:303, :319) | `LoadingIndicator` + `Skeleton` (:305, :316) | `EmptyState` (:345) | hand-rolled `border-danger/30 ... text-danger` (:280,:286,:340) |
| **QueryPage** | `space-y-6` (:816) | `PageHeader` (:818) | inside `PageHeader` children (:822-904) | `Panel` + `StatCard` (:1004,:1019,:1136) | `LoadingIndicator` + `Skeleton` (:959,:997,:967) | `EmptyState` **and** `DataTable.empty` (:981,:1206) | `EmptyState title="Query failed"` (:981) — no banner |
| **PatternTable** | `space-y-4` (:339) | `PageHeader` (:341) | inside `PageHeader` children (:345-368) | `DataTable` only | `LoadingIndicator` (:384); **no `Skeleton`** | `DataTable.empty` (:410) | hand-rolled `border-danger/40 ... text-destructive` (:373) |
| **FindingsPage** | `space-y-4` (:604) | `PageHeader` (:605) | inside `PageHeader` children (:609-650) | `Panel` wrapping `DataTable` (:683) | `LoadingIndicator` (:674); **no `Skeleton`** | `DataTable.empty` (:706) | hand-rolled `/40 ... text-destructive` (:654) + warning variant (:662) |
| **BlacklistPage** | `space-y-6` (:544) | **Yes — hand-rolled** `mono-label` + `text-[26px] sm:text-[30px]` (:545-551) | own `p-4` card (:554), controls `:555-591` | `Card`/`CardHeader`/`CardContent` via `FeedCard` (:125-187) | `Skeleton` + hand-rolled "Refreshing feed…" (:225,:213); **no `LoadingIndicator`** | `EmptyState` (:269,:282) | hand-rolled `/40 ... text-destructive` (:595,:606) |
| **JaillistPage** | `space-y-6` (:248) | **Yes — hand-rolled** `mono-label` + `text-[26px] sm:text-[30px]` (:249-255) | own `p-4` card (:258), controls `:259-295` | `Card` via shared `FeedCard` | `Skeleton` via FeedCard; **no `LoadingIndicator`** | `EmptyState` via FeedCard | hand-rolled `/40 ... text-destructive` (:299,:310) |
| **RedirectsPage** | `space-y-6` (:657) | `PageHeader` (:659) | inside `PageHeader` children (:663-698) **plus** bare `div` search row (:804) | hand-rolled flow card (:711) + `Panel`-less `div` table (:803) + `DataTable` | `LoadingIndicator` + `Skeleton` (:821,:731) | `EmptyState` (:743,:836) + bare `<p>` (:760,:966) | hand-rolled `/40 ... text-destructive` (:735,:829,:934) |
| **LogsPage** | `space-y-4` (:661) | `PageHeader` (:663) | inside `PageHeader` children (:667-711) | `DataTable` + `Panel` (BackupPanel :458) | `LoadingIndicator` + `Skeleton` (:717,:733) | `EmptyState` (:736) + `DataTable.empty` (:776) | hand-rolled `/40 ... text-destructive` (:725) + inline (:1019) |
| **HostInspectorPage** | `space-y-5` (:1002) | `PageHeader` (:1003) | **separate bordered card** `p-4` (:1025) | `Panel` + `StatCard` + `HostEntityCard` | `LoadingIndicator` + `Skeleton` (:1058,:1065) | `EmptyState` inline (:1083,:1087) | hand-rolled `rounded-lg /30 ... text-danger` (:1072,:1094,:1305) |
| **UrlInvestigationPage** | `space-y-5` (:235) | `PageHeader` (:236) | **separate bordered card** `p-4` (:248) | `Panel` + `StatCard` (:340) | `Skeleton` (:286-291); **no `LoadingIndicator`** | `EmptyState` (:368) + `DataTable.empty` (:354) | hand-rolled `rounded-lg /30 ... text-danger` (:277) |
| **AnalyticsPage** | `space-y-5` (:625) | `PageHeader` (:626) | **separate bordered card** `p-4` (:652) | `Panel` + `StatCard` (:727,:742,:761) | `LoadingIndicator` + `Skeleton` (:681,:691) | **none** (bare `<p>` inside panels) | hand-rolled `rounded-lg /30 ... text-danger` (:672,:823) |
| **AttckFleetPage** | `space-y-6` (:266) | `PageHeader` (:267) | inside `PageHeader` children (:272-282) | `Panel` + `StatCard` | bare `Skeleton` + sr-only (:284-288); **no `LoadingIndicator`** | `EmptyState` | hand-rolled `flex-col p-3 /30 ... text-danger` (:294) |
| **ReportPage** | `space-y-5` (:379,:409) | `PageHeader` (:380,:410) | inside `PageHeader` children (:414-421) | `Panel` + `StatCard` (:424,:444,:457,:474) | `Skeleton` + sr-only (:446,:461,:479); **no `LoadingIndicator`** | **none** — bare `<p>` (:483,:453,:469) | none (per-section prose) |
| **LoginPage** | `flex min-h-dvh … px-4 py-10 sm:py-16` (:29) | **own brand hero** `text-[22px]` (:39) | n/a | `Card`-like slab (:31) | `LoadingIcon` in button (:36 area) | n/a | inline `setError` → banner (see `:44-111`) |
| **WhitelistDomainPage** | `flex min-h-dvh …` (:102,:128,:163) | **own centered hero** (`text-lg`/`text-xl`) (:109,:135,:170) | n/a | `Card`+`CardContent` (:103,:177) | `Loader2` in button (:288) | hand-rolled `<tr>` text (:190) | hand-rolled `/40 ... text-destructive` (:270) |
| **BlockDomainPage** | `flex min-h-dvh …` (:111,:137,:186) | **own centered hero** (`text-lg`/`text-xl`) (:118,:144,:193) | n/a | `Card`+`CardContent` (:112,:200) | `Loader2` in button (:310) | hand-rolled `<tr>` text (:213) | hand-rolled `/40 ... text-destructive` (:293) |
| **AppShell** | `flex min-h-dvh` (:40) | static shell header `text-[15px] sm:text-[16px]` (:69-78) | actions slot `flex shrink-0 items-center gap-2` (:77) | n/a | n/a | n/a | n/a |
| **Sidebar** | `flex h-full flex-col` (:187) | brand block `text-sm font-semibold` (:194-198) | n/a | n/a | n/a | n/a | n/a |

---

## TOP 12 CONCRETE INCONSISTENCIES (ranked by visual impact)

1. **Two stacked title bands on every page (shell title + page title).**
   `AppShell.tsx:72` prints `"uNetWatch"` + `"Pattern console"` above every
   page; then the page prints its own title (`QueryPage.tsx:818`,
   `PageHeader` `ui.tsx:617`). `DashboardPage.tsx:178` repeats the product name
   again (`"Dashboard · uNetWatch"`), and `Sidebar.tsx:196-197` a third time.
   **Canonical:** keep the shell header as the *only* product banner and drop
   product-name repetition from page eyebrows; page titles should be the shell's
   `title`/`description` props, or PageHeader only, not both. Remove
   `"· uNetWatch"` from `DashboardPage.tsx:178`.

2. **Four different page-title sizes.**
   `text-[36px]`/`text-[30px]` (`DashboardPage.tsx:180`), `text-3xl`/`text-2xl`
   (`PageHeader`, `ui.tsx:617`), `text-[30px]`/`text-[26px]`
   (`BlacklistPage.tsx:547`, `JaillistPage.tsx:251`), `text-xl`
   (`WhitelistDomainPage.tsx:170`, `BlockDomainPage.tsx:193`), plus
   `text-[22px]` (`LoginPage.tsx:39`). **Canonical:** `PageHeader` only —
   `text-2xl font-bold tracking-tight sm:text-3xl`. Convert Dashboard,
   Blacklist and Jaillist to `<PageHeader>`.

3. **Dashboard's hero card duplicates Card/PageHeader chrome by hand.**
   `DashboardPage.tsx:173` `"rounded-md border border-border bg-card shadow-sm
   overflow-hidden"` is a byte-for-byte copy of `Panel`'s slab (`ui.tsx:634`),
   plus a hand-rolled eyebrow/big-title block. **Canonical:** delete the hero
   card; render `<PageHeader title="Dashboard" description="Live poll health —
   findings — redirect watch">` and move the status/refresh cluster into
   `PageHeader` children.

4. **Five hand-rolled error-banner shapes for the same "load failed + Retry" UI.**
   (1) `flex items-center gap-3 rounded-md border border-danger/40 bg-danger/10
   px-4 py-3 text-xs font-medium text-destructive` (`PatternTable.tsx:373`,
   `FindingsPage.tsx:654`, `BlacklistPage.tsx:595/606`, `JaillistPage.tsx:299/310`,
   `RedirectsPage.tsx:735/829/934`, `LogsPage.tsx:725`, `WhitelistDomainPage.tsx:270`,
   `BlockDomainPage.tsx:293`); (2) `.../30 ... text-danger` (`DashboardPage.tsx:280/286/340`);
   (3) `rounded-lg ... /30 ... text-danger flex items-center justify-between`
   (`HostInspectorPage.tsx:1072/1094/1305`, `AnalyticsPage.tsx:672/823`,
   `UrlInvestigationPage.tsx:277`); (4) `flex flex-col gap-2 ... p-3 ... text-danger`
   (`AttckFleetPage.tsx:294`); (5) warning variant (`FindingsPage.tsx:662`).
   **Canonical:** add one `ErrorBanner` primitive to `ui.tsx` and use shape (1):
   `flex items-center gap-3 rounded-md border border-danger/40 bg-danger/10
   px-4 py-3 text-xs font-medium text-destructive`.

5. **Retry label drifts: "Retry" vs "Try again" vs "Search again".**
   `"Retry"` (`PatternTable.tsx:376`, `BlacklistPage.tsx:597`, `LogsPage.tsx:728`…),
   `"Try again"` (`HostInspectorPage.tsx:1074`, `UrlInvestigationPage.tsx:279`,
   `WhitelistDomainPage.tsx:272`, `BlockDomainPage.tsx:295`), `"Search again"`
   (`HostInspectorPage.tsx:1083`, `UrlInvestigationPage.tsx:358`).
   **Canonical:** `"Retry"` for fetch failures.

6. **Three toolbars idioms for the same function.**
   Controls live (a) inside `PageHeader` children (Query:822, Patterns:345,
   Findings:609, Redirects:663, Logs:667, ATT&CK:272), (b) in a dedicated
   bordered `p-4` card (HostInspector:1025, UrlInvestigation:248, Analytics:652),
   or (c) in a `space-y-4 p-4` card (Blacklist:554, Jaillist:258). Dashboard's
   toolbar is yet a 4th (inside the hero card). **Canonical:** toolbar controls
   go in `PageHeader` children; a page needing a second control row uses one
   shared bordered card className `rounded-md border border-border bg-card p-4
   shadow-sm` (already the string at HostInspector:1025/UrlInvestigation:248/
   Analytics:652).

7. **Root spacing rhythm has three values with no rule.**
   `space-y-4` (`PatternTable.tsx:339`, `FindingsPage.tsx:604`, `LogsPage.tsx:661`),
   `space-y-5` (`DashboardPage.tsx:171`, `HostInspectorPage.tsx:1002`,
   `UrlInvestigationPage.tsx:235`, `AnalyticsPage.tsx:625`, `ReportPage.tsx:379/409`),
   `space-y-6` (`QueryPage.tsx:816`, `BlacklistPage.tsx:544`, `JaillistPage.tsx:248`,
   `RedirectsPage.tsx:657`, `AttckFleetPage.tsx:266`).
   **Canonical:** `"space-y-5"` (+ extract a `PageBody` wrapper so it is defined
   once).

8. **`LoadingIndicator` used by 9 pages, ignored by 5.**
   Present: Dashboard:305, Query:959, Patterns:384, Findings:674, Redirects:821,
   Logs:717, Host:1058, Analytics:681. Absent: Blacklist, Jaillist,
   UrlInvestigation, AttckFleet, Report. Blacklist hand-rolls a spinner
   (`BlacklistPage.tsx:213-221`). **Canonical:** every in-flight refetch uses
   `<LoadingIndicator ... className="max-w-md" />` (the de-facto standard
   already repeated 9×).

9. **`Skeleton` grid shapes are ad-hoc; two pages have none.**
   `Skeleton` heights `h-28` (Analytics:691, UrlInvestigation:286),
   `h-40` (Dashboard:316, Query:967, Blacklist:225, Host:1065),
   `h-56` (Query:969, Logs:733), `h-64` (Redirects:731, Analytics:729),
   `h-24` (Host:1066). PatternTable and FindingsPage show **no** skeleton.
   **Canonical:** shared `TableSkeleton`/`StatSkeleton` shapes.

10. **Empty states split between `EmptyState` and bare centered `<p>`.**
    `EmptyState` (Dashboard:345, Query:1008, Blacklist:269, Redirects:743,
    Logs:736, UrlInvestigation:368, ATT&CK) vs bare
    `<p className="py-8 text-center text-sm text-muted-foreground">`
    (`RedirectsPage.tsx:760/966`, `ReportPage.tsx:483`, and `RankedTable`'s
    internal fallback `ui.tsx:652`). ReportPage and AnalyticsPage never use
    `EmptyState`. **Canonical:** `EmptyState` (`ui.tsx:577`) for every "nothing
    to show" state at section level.

11. **Duplicate "Add" actions: shell header buttons collide with page buttons.**
    On Patterns the shell renders `AddPatternButton` (`App.tsx:256`) and the
    page renders the *same* component again (`PatternTable.tsx:353`), so two
    identical "Add Pattern" buttons are on screen. Same pattern for
    Blacklist (`App.tsx:251` vs `BlacklistPage.tsx:565-573`) and Jaillist
    (`App.tsx:246` vs `JaillistPage.tsx:269-277`).
    **Canonical:** one owner per action — shell keeps the global add buttons;
    pages keep only page-scoped controls (search/filter/bulk-import).

12. **`Panel` header padding is duplicated by hand in RedirectsPage, and
    `Panel` vs `Card` vs hand-rolled slab are all in play.**
    `Panel` header = `px-4 py-3` (`ui.tsx:636`) and body = `p-4 sm:p-5`
    (`ui.tsx:643`); `Card`/`CardHeader`/`CardContent` = `p-5`
    (`ui.tsx:297/305`). RedirectsPage re-implements the Panel header
    (`RedirectsPage.tsx:712` `flex flex-wrap items-center justify-between gap-3
    border-b border-border px-4 py-3`) and Dashboard/Redirects re-implement the
    Panel slab (`DashboardPage.tsx:173` / `RedirectsPage.tsx:711`).
    **Canonical:** use `Panel` for titled content sections and `Card` only for
    the FeedCard-style list, and delete hand-rolled slab/header copies.

---

### Notes on methodology

- All line numbers are from the current working tree
  (`admin-ui/src/components/*.tsx`) and were verified by `grep -n` / `read`
  against the quoted strings.
- "Own title?" = renders a heading independent of `AppShell`'s `h1`.
- Standalone pages (`LoginPage`, `WhitelistDomainPage`, `BlockDomainPage`) are
  outside `AppShell` (`App.tsx:219-234`) so their full-viewport chrome is
  *expected*, but their `text-xl`/`text-[22px]` title sizes still drift from the
  in-app `PageHeader` scale — call it out but treat as lower priority.
- `DataTable` (`DataTable.tsx`) is a cross-cutting chrome owner: its internal
  toolbar (`:1091`), sticky header (`:1146`) and delegated empty state
  (`:1238-1246`) mean "no toolbar" on Patterns/Findings actually means "toolbar
  lives in the table".
