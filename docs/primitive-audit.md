# Shared UI Primitive Audit — `admin-ui/src/components/ui.tsx`

**Scope:** `admin-ui/src/components/ui.tsx` (791 lines, the primitive barrel) and every consumer under `admin-ui/src/**`.
**Method:** static read + `grep -rnw` across `admin-ui/src/**/*.{ts,tsx}`. No files modified.
**Theme source of truth:** `admin-ui/src/index.css` `@theme` block (lines 9–108). Relevant tokens:

| Token | Line | Value (light) |
|---|---|---|
| `--radius` | `index.css:58` | `6px` |
| `--radius-sm` | `index.css:59` | `4px` |
| `--radius-md` | `index.css:60` | `6px` |
| `--radius-lg` | `index.css:61` | `8px` |
| `--radius-xl` | `index.css:62` | `12px` |
| `--color-border` | `index.css:45` | `#E9E9E8` |
| `--color-input` | `index.css:46` | `#E0E0DE` |
| `--color-ring` | `index.css:47` | `#2383E2` |
| `--color-danger` | `index.css:37` | `#EB5757` |
| `--color-success` | `index.css:33` | `#0F7B6C` |
| `--color-warning` | `index.css:35` | `#DFAB01` |
| `--color-info` | `index.css:39` | `#2383E2` |
| `--shadow-color` | `index.css:65` | `rgba(15, 15, 15, 0.1)` |

Note: `--radius-md` (6px) and `--radius-sm` (4px) are the only meaningful distinctions; `rounded-md` and `rounded` therefore differ by 2px, and `rounded-lg` differs by 2px from `rounded-md`. There is **no** `--shadow-*` semantic token other than the raw `--shadow-color`; `shadow-sm`/`shadow-md`/`shadow-lg` resolve to Tailwind v4 defaults, not theme tokens.

---

## 1. Export inventory

All exports are from `admin-ui/src/components/ui.tsx` unless noted. "Uses" counts non-`ui.tsx` references; "Files" lists distinct consumers.

| # | Export | Lines | Props signature | Renders | Uses | Status |
|---|---|---|---|---|---|---|
| 1 | `Button` | `72–90` | `ComponentPropsWithRef<"button"> & { variant?: "default"\|"destructive"\|"outline"\|"secondary"\|"ghost"; size?: "default"\|"sm"\|"lg"\|"icon" }` | native `<button>` | 310 | **Used** (26+ files) |
| 2 | `LoadingIcon` | `94–96` | `{ className?: string }` | `Loader2` spin icon | 15 | **Used** (5 files) |
| 3 | `TimestampCell` | `101–109` | `{ value: string\|number; className?: string }` | `<span>` relative + absolute time | 11 | **Used** (5 files) |
| 4 | `CopyUrlButton` | `113–141` | `{ value: string; label?: string; className?: string; size?: "sm"\|"icon" }` | `Button` ghost + `Copy` icon, toast on copy | 11 | **Used** (4 files) |
| 5 | `Input` | `145–186` | `{ className?; value?; onChange?; onKeyDown?; placeholder?; type?; autoFocus?; id?; name?; autoComplete?; "aria-label"? }` | native `<input>` | 25 | **Used** (12 files) |
| 6 | `Textarea` | `193–221` | `{ className?; value?; onChange?; placeholder?; id?; "aria-label"? }` | native `<textarea>` | **0** | **DEAD EXPORT** |
| 7 | `Badge` | `239–256` | `{ children; variant?: "default"\|"secondary"\|"destructive"\|"outline"\|"success"\|"warning"; className? }` | `<span>` pill | 76 | **Used** (13 files) |
| 8 | `ListBadgeTone` (type) | `261` | `"warning" \| "success" \| "danger"` | — (type only) | **0** | **Dead export** (internal-only) |
| 9 | `ListBadge` | `263–280` | `{ tone: ListBadgeTone; title?; icon: LucideIcon; children }` | `<span>` w/ leading icon | 13 | **Used** (only `QueryPage.tsx`) |
| 10 | `Card` | `292–294` | `{ className?; children }` | `<div>` slab | 18 | **Used** (4 files) |
| 11 | `CardHeader` | `296–298` | `{ className?; children }` | `<div>` | 3 | **Used** (only `BlacklistPage.tsx`) |
| 12 | `CardTitle` | `300–302` | `{ children; className? }` | `<h3>` | 2 | **Used** (only `BlacklistPage.tsx`) |
| 13 | `CardContent` | `304–306` | `{ className?; children }` | `<div>` | 17 | **Used** (4 files) |
| 14 | `Label` | `310–316` | `{ children; className?; htmlFor? }` | `<label class="mono-label">` | 23 | **Used** (9 files) |
| 15 | `Skeleton` | `320–325` | `{ className? }` | shimmer `<div>` | 56 | **Used** (13 files) |
| 16 | `LoadingIndicator` (re-export) | `332` | see `components/loading/LoadingIndicator.tsx` | loading widget | 24 | **Used** (11 files) |
| 17 | `LoadingIndicatorProps` (type re-export) | `333` | — | — | 3 | **Used** (2 files) |
| 18 | `LoadingProgress` (type re-export) | `333` | — | — | 8 | **Used** (4 files) |
| 19 | `Dialog` | `337–379` | `{ open; onClose; title; description?; children; className? }` | Radix Dialog root portal | 31 | **Used** (9 files) |
| 20 | `SelectOption` (iface) | `382` | `{ value: string; label: string }` | — | 3 | **Used** (only `AnalyticsPage.tsx`) |
| 21 | `Select` | `384–459` | `{ value; onChange; options: SelectOption[]; className?; placeholder?; id?; size?: "default"\|"sm"; "aria-label"? }` | Radix Select | 26 | **Used** (9 files) |
| 22 | `RefreshIntervalSelect` | `469–471` | `{ value: number; onChange; className? }` | `Select` w/ fixed options | 4 | **Used** (2 files) |
| 23 | `ToastVariant` (type) | `475` | `"default" \| "success" \| "error" \| "info"` | — | **0** | **Dead export** (internal-only) |
| 24 | `ToastInput` (iface) | `477–482` | `{ title?; description?; variant?; duration? }` | — | **0** | **Dead export** (internal-only) |
| 25 | `ToastProvider` | `504–550` | `{ children }` | Radix Toast provider | 3 | **Used** (only `App.tsx`) |
| 26 | `useToast` | `552–556` | `(): ToastContextValue` | hook | 44 | **Used** (21 files) |
| 27 | `ConfirmDialog` | `560–573` | `{ open; title; description?; confirmLabel?; cancelLabel?; variant?: "default"\|"destructive"; onConfirm; onCancel }` | `Dialog` + buttons | 20 | **Used** (6 files) |
| 28 | `EmptyState` | `577–589` | `{ icon: LucideIcon; title; description?; action?; className? }` | dashed slab | 26 | **Used** (9 files) |
| 29 | `SearchInput` | `592–608` | `{ value; onChange: (string)=>void; placeholder?; className?; id?; "aria-label"?; autoFocus? }` | `Input` + icon + clear | 21 | **Used** (10 files) |
| 30 | `PageHeader` | `612–625` | `{ title; description?; children?; className? }` | bordered title block | 31 | **Used** (10 files) |
| 31 | `Panel` | `628–647` | `{ title?; description?; icon?: LucideIcon; className?; children; action? }` | titled slab | 84 | **Used** (10 files) |
| 32 | `RankedTable` | `650–693` | `{ rows: {label;count}[]; className?; onRowClick? }` | `<table>` ranked list | 3 | **Used** (only `QueryPage.tsx`) |
| 33 | `StatTone` (type) | `696` | `"default"\|"success"\|"warning"\|"danger"\|"info"` | — | **0** | **Dead export** (internal-only) |
| 34 | `StatCard` | `706–734` | `{ icon; label; value; tone?; hint?; className?; action?; onClick? }` | metric slab | 55 | **Used** (8 files) |
| 35 | `Pagination` | `737–777` | `{ page; pageSize; total?; onPageChange; hasNext?; className?; onPageSizeChange?; pageSizeOptions? }` | nav footer | 3 | **Used** (2 files) |

Non-exported module-internal helpers (not part of the public surface): `buttonBase` (`39–44`), `buttonVariants` (`45–52`), `buttonSizes` (`53–57`), `badgeVariants` (`230–237`), `REFRESH_INTERVAL_OPTIONS` (`462–467`), `toastVariantStyles` (`497–502`), `statIconTone` (`698–704`), `computePageList` (`779–791`).

### 1a. Dead exports

| Export | Line | Why |
|---|---|---|
| `Textarea` | `ui.tsx:193–221` | Zero imports. Only reference is the definition. All three bulk-text editors roll their own raw `<textarea>` instead (see §3). |
| `ListBadgeTone` | `ui.tsx:261` | Exported type used only by `ListBadge` inside the same file. |
| `ToastVariant` | `ui.tsx:475` | Exported type used only internally (`ToastInput`, `toastVariantStyles`). |
| `ToastInput` | `ui.tsx:477` | Exported interface used only internally (`ToastRecord`, `ToastContextValue`, `useToast`). |
| `StatTone` | `ui.tsx:696` | Exported type used only internally (`statIconTone`, `StatCard`). |

The `ListBadgeTone` / `ToastVariant` / `ToastInput` / `StatTone` cases are "type-leak" exports: the type is exported to describe an internal implementation detail but never imported. `Textarea` is a genuine **dead component** — it is the only function export in the barrel with zero consumers, and it is materially better-behaved than the raw `<textarea>`s that replace it (it uses `bg-card` + `rounded-md`; the replacements use `bg-background` and drop the radius).

### 1b. Near-duplicate primitives

| Pair | Evidence | Verdict |
|---|---|---|
| **`Card` vs `Panel`** | `Card` (`292–294`): `"overflow-hidden rounded-md border border-border bg-card shadow-sm"`. `Panel` (`628–647`): identical base `"overflow-hidden rounded-md border border-border bg-card shadow-sm"` + optional header (`px-4 py-3`) + body (`p-4 sm:p-5`). Both used heavily: `Card` 18×, `Panel` 84×. | **Near-duplicate.** Same visual shell; `Panel` = `Card` + header + body padding. `Card`/`CardHeader`/`CardContent` is the compositional form of the same design. |
| **`Badge` vs `ListBadge`** | `Badge` (`239–256`): `rounded-full border px-2.5 py-0.5 text-xs font-medium`. `ListBadge` (`263–280`): `rounded-md border px-2 py-0.5 text-xs font-medium` + icon + 3 hard-coded tones (`warning`/`success`/`danger`). | **Near-duplicate.** Same pill job, different radius (`full` vs `md`), same tone palette expressed twice, and `ListBadge` re-implements `Badge`'s `warning`/`success`/`destructive` classes literally: `"bg-warning/10 text-warning border-warning/20"` appears at both `244` and `271`. |
| **`Skeleton` vs `LoadingIndicator`** | `Skeleton` (`320–325`) and the re-exported `LoadingIndicator` (`332`) both occupy the "placeholder while loading" slot; `Skeleton` 56 uses, `LoadingIndicator` 24 uses, overlapping consumers (`LogsPage`, `QueryPage`, `AnalyticsPage`, `HostInspectorPage`, `DashboardPage`). | **Overlapping responsibility** (not byte-identical) — two loading idioms coexist in the same pages. |
| **`Input` vs `SearchInput`** | `SearchInput` (`592–608`) wraps `Input` and adds a leading `Search` icon + clear button. | **Intentional composition**, not a duplicate. |
| Hand-rolled card shells | 25+ raw `rounded-md border border-border bg-card shadow-sm` divs outside `ui.tsx` (see §3) | **Duplication of the primitive**, not a second primitive. |

---

## 2. Variant / visual consistency matrix

Exact className fragments per primitive. Blank = the property is not declared by that primitive.

| Primitive (line) | Radius | Border | Shadow | Padding | Font size | Gap | Hover | Focus |
|---|---|---|---|---|---|---|---|---|
| `Button` base (`42–44`) | `rounded-md` | `border` (+ per-variant color) | `shadow-sm` (removed by `outline`/`ghost` via `shadow-none`) | per size: `px-4 py-2` / `px-3` / `px-6` / `h-9 w-9` | `text-sm` | `gap-2` | `hover:bg-primary/90` (default), `hover:bg-danger/90`, `hover:bg-muted`, `hover:bg-secondary/70` | `focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2` |
| `Badge` (`239–256`) | `rounded-full` | `border` + `border-border` / `border-danger/20` / `border-success/20` / `border-warning/20` | none | `px-2.5 py-0.5` | `text-xs` | — (no `gap`) | none | none |
| `ListBadge` (`263–280`) | `rounded-md` | `border` + `border-warning/20` \| `border-success/20` \| `border-danger/20` | none | `px-2 py-0.5` | `text-xs` | `gap-1.5` | none | none |
| `Card` (`292–294`) | `rounded-md` | `border-border` | `shadow-sm` | none | — | — | — | — |
| `CardHeader` (`296–298`) | — | `border-b border-border` | — | `p-5` | — | `gap-1.5` | — | — |
| `CardTitle` (`300–302`) | — | — | — | — | `text-sm` | — | — | — |
| `CardContent` (`304–306`) | — | — | — | `p-5` | — | — | — | — |
| `Panel` (`628–647`) | `rounded-md` | `border-border`; header `border-b border-border` | `shadow-sm` | header `px-4 py-3`; body `p-4 sm:p-5` | header `text-sm`; description `text-xs` | header `gap-2` | — | — |
| `StatCard` (`706–734`) | `rounded-md` (root **and** icon box) | `border-border`; action `border-t border-border` | `shadow-sm` | `p-5`; action `pt-3` | label `text-sm`, value `text-3xl`, hint `text-xs` | `gap-3` | none (only `cursor-pointer` when clickable) | none declared (no ring on the clickable card) |
| `EmptyState` (`577–589`) | `rounded-lg` (root **and** icon box) | `border border-dashed border-border` | none | `px-6 py-14`; icon `h-12 w-12` | title `text-sm`, desc `text-sm` | — | — | — |
| `Dialog` (`337–379`) | content `rounded-lg`; close btn `rounded-md` | `border-border` | `shadow-lg` | content `p-6`; close `h-7 w-7` | title `text-base`, desc `text-sm` | — | close `hover:bg-muted hover:text-foreground` | close `ring-2 ring-ring` |
| `ConfirmDialog` (`560–573`) | — (delegates to `Dialog`) | — | — | `mt-6`, button row `gap-2` | — | `gap-2` | — | — |
| `Select` trigger (`397–410`) | `rounded-md` | `border-border` | `shadow-sm` | default `px-3 py-2` `h-9`; sm `h-7 px-2 py-1` | default `text-sm`; sm `text-xs` | `gap-2` / `gap-1` | — | `ring-2 ring-ring` (no offset) |
| `Select` content (`420–425`) | `rounded-md` | `border-border` | `shadow-md` | viewport `p-1`; item `py-1.5 pl-8 pr-2` | `text-sm` | — | item `hover:bg-muted focus:bg-muted` | item `outline-none` |
| `Input` (`171–185`) | `rounded-md` | `border-input` | none | `h-9 px-3 py-2` | `text-sm` | — | — | `ring-2 ring-ring focus-visible:border-ring` |
| `Textarea` (**dead**) (`209–219`) | `rounded-md` | `border-input` | none | `px-3 py-2`, `min-h-[120px]` | `text-sm` | — | — | `ring-2 ring-ring finish-visible:border-ring` |
| `SearchInput` (`592–608`) | — (wraps `Input`) | — | — | clear btn `p-1` | — | — | clear `hover:text-foreground hover:border-border` | clear `ring-2 ring-ring` |
| `Pagination` (`737–777`) | page-size `<select>` `rounded-md` | container `border-t border-border`; select `border-border` | none | container `px-3 py-3`; buttons `h-8 w-8` | `text-sm`; select `text-xs` | container `gap-3`; nav `gap-1` | via `Button` | via `Button` |
| `RankedTable` (`650–693`) | `rounded-md` | `border-border`; rows `divide-border` | none | `px-3 py-2` | `text-sm`; th `text-xs` | `gap-2` | row `hover:bg-muted/60` (clickable) / `hover:bg-muted/40` | row `ring-2 ring-ring ring-inset` |
| `Skeleton` (`320–325`) | `rounded-md` | `border-border` | none | — | — | — | — | — |
| `Label` (`310–316`) | — | — | — | `mb-2` | `mono-label` = 11px (`index.css:130–137`) | — | — | — |
| `PageHeader` (`612–625`) | — | `border-b border-border` | none | `pb-4` | title `text-2xl sm:text-3xl`, desc `text-sm` | `gap-4`, actions `gap-2` | — | — |
| `TimestampCell` (`101–109`) | — | — | — | — | outer inherited, `text-xs` for absolute | — | — | — |

### 2a. Radius disagreements

| Value | Primitives |
|---|---|
| `rounded-full` | `Badge` |
| `rounded-lg` | `Dialog` (content), `EmptyState` (root + icon box) |
| `rounded-md` | `Button`, `ListBadge`, `Card`(+H/T/C), `Panel`, `StatCard` (root + icon), `Select` (trigger + content), `Input`, `Textarea`, `Skeleton`, `Dialog` close button, `Pagination` select, `RankedTable` |
| `rounded-sm` | `Select` item (`427`) |
| `rounded` (bare) | raw icon buttons in consumers (`AnalyticsPage`, `FindingsPage`, `HostInspectorPage`, `QueryPage`, `FilterBuilder`) — see §5 |

**Verdict:** three "chip/slab" radii coexist: `rounded-full` (Badge), `rounded-lg` (EmptyState), `rounded-md` (everything else). The icon buttons and `RankedTable` "rank pill" use `rounded-full` for the inner bar (`669`, `670`) while the surrounding card is `rounded-md`, so a single `RankedTable` renders both.

### 2b. Shadow disagreements

| Value | Primitives |
|---|---|
| `shadow-sm` | `Button`, `Card`, `Panel`, `StatCard`, `Select` trigger, hand-rolled cards |
| `shadow-md` | `Select` content, DataTable popovers |
| `shadow-lg` | `Dialog` content, Toast root |
| none | `Badge`, `ListBadge`, `EmptyState`, `Input`, `Textarea`, `Pagination`, `RankedTable`, `Skeleton`, `PageHeader` |

`Button` sets `shadow-sm` in the base string and then **cancels it with `shadow-none`** for `outline` (`50`) and `ghost` (`52`). `Card`/`Panel`/`StatCard` all use `shadow-sm`; `EmptyState` — same "slab" role — has **no shadow** but a dashed border. `Pagination` (a card-like footer) and `RankedTable` (a card-like table) both have **no shadow**, so the three "containers" disagree.

### 2c. Border-color disagreements

| Value | Primitives / consumers |
|---|---|
| `border-border` | `Card`, `Panel`, `Select`, `Pagination`, `RankedTable`, `Skeleton`, `EmptyState` (dashed), `Button` (outline/secondary), most consumers |
| `border-input` | `Input`, `Textarea` |
| `border-danger/20`, `border-success/20`, `border-warning/20` | `Badge`, `ListBadge`, Toast (`error`/`success`/`info`) |
| `border-danger/30` | none in `ui.tsx`; appears in consumers |
| `border-transparent` | `Button` default/destructive/ghost, all raw icon buttons |
| `border-info/20` | Toast `info` (`501`) — **only place `--color-info` border is used as a tint** |

**Verdict:** form controls use `border-input` (`#E0E0DE`, darker) while every surface uses `border-border` (`#E9E9E8`). This is the single most consistent axis, but it is undocumented. Tinted borders use `/20` in `ui.tsx` while consumers use `/30` (see §3).

### 2d. Padding disagreements

| Value | Primitives |
|---|---|
| `p-5` | `CardHeader`, `CardContent`, `StatCard` |
| `p-4 sm:p-5` | `Panel` body |
| `px-4 py-3` | `Panel` header |
| `p-4` | Toast root (via `p-4` in `ToastProvider`, `508`) |
| `p-6` | `Dialog` content |
| `px-6 py-14` | `EmptyState` |
| `px-3 py-2` | `Input`, `Select` trigger (`default`), `RankedTable` cells |
| `px-2 py-1` | `Select` trigger (`sm`) |
| `px-3 py-3` | `Pagination` container |

**Verdict:** `CardHeader`/`CardContent`/`StatCard` agree on `p-5`; `Panel` disagrees with all three (`px-4 py-3` header, `p-4 sm:p-5` body). `Pagination` uses `px-3 py-3` (asymmetric) while `Panel` uses `px-4 py-3`. Three "slab body" paddings: `p-5`, `p-4 sm:p-5`, `p-4`.

### 2e. Font-size disagreements (chip role)

| Value | Primitives |
|---|---|
| `text-xs` | `Badge`, `ListBadge`, `Panel` description, `StatCard` hint, `TimestampCell` absolute, `Pagination` select, `RankedTable` th |
| `text-sm` | `Button`, `CardTitle`, `Panel` title, `EmptyState` title+desc, `Input`, `Textarea`, `Select`, `Pagination` footer, `RankedTable` cells |
| `text-base` | `Dialog` title |
| `text-2xl sm:text-3xl` | `PageHeader` title |
| `text-3xl` | `StatCard` value |
| 11px (`mono-label`) | `Label`, `RankedTable` th (`mono-label`) |

**Verdict:** acceptable spread — but note `RankedTable` th applies **both** `mono-label` and `text-xs` (`667–670`), so it inherits the 11px `mono-label` rule and then overrides to `text-xs` (12px); the `mono-label` utility's font-size is dead in that spot.

### 2f. Gap disagreements

`gap-1` (`Select` sm trigger, `Pagination` nav), `gap-1.5` (`CardHeader`, `ListBadge`), `gap-2` (`Button`, `Panel` header, `EmptyState` actions, `Select` default, `RankedTable` cell, `ConfirmDialog`), `gap-3` (`StatCard`, `Pagination` container), `gap-4` (`PageHeader`). Five gap steps across the primitive set.

### 2g. Hover-state disagreements

| Primitive | Hover |
|---|---|
| `Button` default | `hover:bg-primary/90` |
| `Button` destructive | `hover:bg-danger/90` |
| `Button` outline | `hover:bg-muted` |
| `Button` secondary | `hover:bg-secondary/70` |
| `Button` ghost | `hover:bg-muted` |
| `Badge` / `ListBadge` | **none** |
| `Card` / `Panel` / `StatCard` / `EmptyState` | **none** (unless the consumer adds one, e.g. `DashboardPage.tsx:360` `hover:bg-muted/50`) |
| `Select` item | `hover:bg-muted` |
| `RankedTable` row | `hover:bg-muted/60` (clickable) / `hover:bg-muted/40` (static) |
| `SearchInput` clear | `hover:text-foreground hover:border-border` |
| raw icon buttons (§5) | `hover:border-border hover:bg-muted hover:text-foreground` |

**Verdict:** two different "muted hover" opacities inside `RankedTable` alone (`/60` vs `/40`), and `hover:bg-muted` vs `hover:bg-muted/50` (Dashboard) vs `hover:bg-muted/60` (RankedTable).

### 2h. Focus-state disagreements

| Primitive | Focus |
|---|---|
| `Button` | `focus-visible:ring-2 ring-ring ring-offset-2` |
| `Input` / `Textarea` | `focus-visible:ring-2 ring-ring` + `focus-visible:border-ring` (**no offset**) |
| `Select` trigger | `focus-visible:ring-2 ring-ring` (**no offset, no border-ring**) |
| `Select` item | `outline-none` only |
| `SearchInput` clear | `focus-visible:ring-2 ring-ring` |
| `Pagination` select | `focus-visible:ring-2 ring-ring` |
| `RankedTable` row | `focus-visible:ring-2 ring-ring ring-inset` |
| `Card` / `Panel` / `StatCard` / `EmptyState` / `Badge` / `ListBadge` / `Skeleton` / `PageHeader` / `TimestampCell` | **none declared** |
| Global fallback | `index.css:139–142` `:focus-visible { outline: 2px solid var(--color-ring); outline-offset: 2px; }` |

**Verdict:** `Button` is the only primitive that sets `ring-offset-2`. `Input`/`Textarea` additionally shift the border to `ring`. `StatCard` becomes `role="button"` + `tabIndex=0` when `onClick` is passed (`712–716`) yet declares **no focus ring** — it relies on the global `:focus-visible` outline. Same for the clickable `RankedTable` rows, which *do* declare a ring — so the two clickable-row idioms disagree.

---

## 3. Hard-coded values

### 3a. Hard-coded colors in `ui.tsx`

| Location | Literal | Note |
|---|---|---|
| `ui.tsx:48` | `text-white` | `Button` default — hard-codes white instead of `--color-primary-foreground` (`index.css:23`). Breaks if primary foreground is retheme'd. |
| `ui.tsx:49` | `text-white` | `Button` destructive — instead of `--color-danger-foreground` (`index.css:38`). |
| `ui.tsx:357` | `bg-black/40` | `Dialog` overlay — raw black, not a theme token. |
| `ui.tsx:334` (Toast root, `508`) | no color | ok |
| `ui.tsx:498` | `bg-card text-foreground border-border shadow-lg` | default toast — tokens ok |
| `ui.tsx:499` | `border-success/20` | tint token ok |
| `ui.tsx:500` | `border-danger/20` | tint token ok |
| `ui.tsx:501` | `border-info/20` | tint token ok |

`ui.tsx` itself contains **no** `text-red-*`/`bg-gray-*`/`#hex`/`rgba()` literals. Its hard-coded values are limited to `text-white` (×2) and `bg-black/40`.

### 3b. Hard-coded colors in consumers

| file:line | Literal | Context |
|---|---|---|
| `components/GlobalSearchPalette.tsx:94` | `bg-black/40` | Dialog overlay (duplicates `ui.tsx:357`) |
| `components/table/RowDetailPanel.tsx:75` | `bg-black/40` | Dialog overlay |
| `components/EventInspectorSidebar.tsx:159` | `bg-foreground/30 backdrop-blur-[1px]` | Overlay — **third** overlay color (`foreground/30`), not `black/40` |
| `components/SankeyDiagram.tsx:39` | `"#787774"` | Pattern node color (should be `--color-muted-foreground`) |
| `components/SankeyDiagram.tsx:40` | `"#2383E2"` | Source node (should be `--color-info`) |
| `components/SankeyDiagram.tsx:41` | `"#37352F"` | Domain node (should be `--color-foreground`) |
| `components/SankeyDiagram.tsx:42` | `"#787774"` | Destination node |
| `components/SankeyDiagram.tsx:51` | `"#9B9A97"` | Dark-mode pattern (should be dark `--color-muted-foreground`, `index.css:94`) |
| `components/SankeyDiagram.tsx:52` | `"#529CCA"` | Dark-mode source (should be dark `--color-info`) |
| `components/SankeyDiagram.tsx:53` | `"#E3E2E0"` | Dark-mode domain |
| `components/SankeyDiagram.tsx:54` | `"#9B9A97"` | Dark-mode destination |
| `components/SankeyDiagram.tsx:62` | `"#EB5757"` / `"#9B9A97"` / `"#787774"` | High-risk danger + dark/light muted — duplicates `--color-danger` (`index.css:37`) |
| `components/TrendCharts.tsx:57` | `` `rgba(${parts[0]}, ${parts[1]}, ${parts[2]}, ${alpha})` `` | Chart alpha compositing (reads CSS var, acceptable) |
| `components/TrendCharts.tsx:71` | `` `rgba(${r}, ${g}, ${b}, ${alpha})` `` | same |
| `components/TrafficTimeline.tsx:88` | `` `rgba(${parts[0]}, ${parts[1]}, ${parts[2]}, ${alpha})` `` | same |
| `components/TrafficTimeline.tsx:95` | `` `rgba(${r}, ${g}, ${b}, ${alpha})` `` | same |
| `lib/echartsTheme.ts:7–27` | `#529CCA`, `#DFAB01`, `#EB5757`, `#0F7B6C`, `#2383E2`, `#E3E2E0`, `#202020`, `#37352F`, `#FFFFFF`, `#E9E9E8`, `#787774` | ECharts fallback palette — **duplicates the entire `@theme` palette** as literals |
| `lib/echartsTheme.ts:72,77` | `"#888"` | Last-resort fallback |

`SankeyDiagram.tsx` and `echartsTheme.ts` are the biggest offenders: the charting layer re-declares the theme palette by hand. (`echartsTheme.ts` has a `live` mode that reads the CSS var at line 72–77, but ships the literals as fallback.)

**No `text-red-500`-style Tailwind palette literals exist anywhere** in `admin-ui/src` (grep for `(text|bg|border|…)-(red|blue|gray|…)-<n>` returns zero). The codebase consistently uses semantic tokens in classNames; the leakage is confined to inline styles / chart props.

### 3c. Hard-coded radius / shadow (non-token)

All `rounded-*`/`shadow-*` in the codebase are Tailwind utilities, which *are* theme-backed (`--radius-md`, `index.css:60`). The inconsistency is not "untokenized" but "token-selection drift":

- `rounded` (bare = `--radius-sm`, 4px) used by 6 icon buttons (§5) where `rounded-md` (6px, used elsewhere) would match.
- `rounded-md` used for the `InstitutionalRow`-style slabs everywhere, but `rounded-lg` used by `EmptyState` (`578`, `580`) and `TrafficTimeline.tsx:77` for the same visual role.
- `shadow-none` on `Button.outline`/`ghost` (`50`, `52`) vs `shadow-sm` on the base — a shadow chosen then cancelled.

---

## 4. `PageHeader` usage

**`PageHeader` is defined once** at `ui.tsx:612–625`:

```tsx
export function PageHeader({ title, description, children, className }: { title: string; description?: string; children?: ReactNode; className?: string }) {
  return (
    <div className={cn("border-b border-border pb-4", className)}>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <h2 className="text-2xl font-bold tracking-tight sm:text-3xl">{title}</h2>
          {description && <p className="mt-1.5 max-w-[52ch] text-sm leading-relaxed text-muted-foreground">{description}</p>}
        </div>
        {children && <div className="flex flex-wrap items-center gap-2">{children}</div>}
      </div>
    </div>
  )
}
```

**Files that import it (10):** `AnalyticsPage.tsx:19`, `AttckFleetPage.tsx:21`, `FindingsPage.tsx:34`, `HostInspectorPage.tsx:18`, `LogsPage.tsx:34`, `PatternTable.tsx:17`, `QueryPage.tsx:38`, `RedirectsPage.tsx:34`, `ReportPage.tsx:27`, `UrlInvestigationPage.tsx:28`.

**Call sites (11 invocations):** `AnalyticsPage.tsx:626`, `AttckFleetPage.tsx:267`, `FindingsPage.tsx:605`, `HostInspectorPage.tsx:1003`, `LogsPage.tsx:663`, `PatternTable.tsx:341`, `QueryPage.tsx:818`, `RedirectsPage.tsx:659`, `ReportPage.tsx:380`, `ReportPage.tsx:410`, `UrlInvestigationPage.tsx:236`.

**Files that deviate from a page header (no `PageHeader`):**

| file:line | Quote | Assessment |
|---|---|---|
| `BlockDomainPage.tsx:125` | `<h1 className="text-lg font-semibold tracking-tight">No entries provided</h1>` | Utility page; `h1` + `text-lg` — smaller scale than `PageHeader`'s `h2` `text-2xl sm:text-3xl`. Acceptable (standalone result screen). |
| `WhitelistDomainPage.tsx` (mirrors BlockDomain) | `<h1 …>` at `115`, `141`, `184` region | same |
| `LoginPage.tsx:37` region | `<ShieldCheck className="h-7 w-7" aria-hidden="true" />` + custom `<h1>`/card | Auth page; own header. Fine. |
| `DashboardPage.tsx` | no `PageHeader` import; uses `Panel` titles and a big stat grid | **Deviates** — the dashboard has no page title block at all. |
| `Sidebar.tsx` / `AppShell.tsx` | n/a (chrome) | n/a |

**Verdict:** `PageHeader` is the de-facto standard and has no true competing *component* — but `BlockDomainPage`/`WhitelistDomainPage` hand-roll an `h1`-based header with a different type scale (`text-lg` vs `text-2xl sm:text-3xl`), and `DashboardPage` omits one entirely. No second `PageHeader`-equivalent component exists; the duplication is inline markup, not a primitive.

---

## 5. Icon-button pattern (candidate for `IconButton`)

The canonical raw icon button is:

```
inline-flex h-6 w-6 shrink-0 items-center justify-center rounded border border-transparent text-muted-foreground hover:border-border hover:bg-muted hover:text-foreground
```

**Occurrences of the exact string (14):**

| file:line | className |
|---|---|
| `components/AnalyticsPage.tsx:352` | `inline-flex h-6 w-6 shrink-0 items-center justify-center rounded border border-transparent text-muted-foreground hover:border-border hover:bg-muted hover:text-foreground` |
| `components/AnalyticsPage.tsx:407` | *(identical)* |
| `components/AnalyticsPage.tsx:430` | *(identical)* |
| `components/AnalyticsPage.tsx:451` | *(identical)* |
| `components/FindingsPage.tsx:109` | *(identical)* |
| `components/FindingsPage.tsx:151` | *(identical)* |
| `components/FindingsPage.tsx:183` | *(identical)* |
| `components/HostInspectorPage.tsx:721` | *(identical)* |
| `components/HostInspectorPage.tsx:742` | *(identical)* |
| `components/HostInspectorPage.tsx:765` | *(identical)* |
| `components/HostInspectorPage.tsx:794` | *(identical)* |
| `components/HostInspectorPage.tsx:934` | `inline-flex h-6 w-6 shrink-0 items-center justify-center rounded border border-transparent text-muted-foreground hover:border-border hover:bg-muted hover:text-foreground` (inline `<button …>` on one line) |
| `components/QueryPage.tsx:142` | `inline-flex h-6 w-6 items-center justify-center rounded border border-transparent text-muted-foreground hover:border-border hover:bg-muted hover:text-foreground` (**no `shrink-0`**) |
| `components/table/FilterBuilder.tsx:275` | `relative inline-flex h-6 w-6 items-center justify-center rounded border border-transparent transition-colors hover:border-border hover:bg-muted` (+ `focus-visible:ring-2`, active tint) |

**Near-miss / divergent icon buttons (the same pattern at other sizes):**

| file:line | className | Divergence |
|---|---|---|
| `components/FindingsPage.tsx:160` | `h-6 w-6 shrink-0 text-muted-foreground hover:text-foreground` | `Button variant="ghost" size="icon"` — no border, no `rounded` |
| `components/BlacklistPage.tsx:258` | `inline-flex h-7 w-7 shrink-0 cursor-pointer items-center justify-center text-muted-foreground transition-colors hover:bg-danger/10 hover:text-destructive focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50` | `h-7 w-7`, **destructive** hover, **no `rounded` at all**, has focus ring |
| `components/EventInspectorSidebar.tsx:195` | `inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-transparent hover:border-border hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring` | `h-7 w-7`, `rounded-md` (not `rounded`), focus ring |
| `components/LoginPage.tsx:88` | `absolute right-1 top-1/2 inline-flex h-8 w-8 -translate-y-1/2 items-center justify-center rounded-md border border-transparent text-muted-foreground hover:border-border hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring` | `h-8 w-8`, `rounded-md` |
| `components/NetworkGraphDiagram.tsx:382` | `inline-flex h-8 w-8 items-center justify-center border border-border bg-card text-muted-foreground shadow-sm transition-colors hover:bg-secondary hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring` | `h-8 w-8`, **no radius**, `bg-card`/`shadow-sm`/`border-border`, `hover:bg-secondary` |
| `components/NetworkGraphDiagram.tsx:390` | *(identical to 382)* | |
| `components/NetworkGraphDiagram.tsx:398` | *(identical to 382)* | |
| `components/LogsPage.tsx:260` | `h-8 w-8 text-muted-foreground hover:text-foreground` | `Button variant="ghost" size="icon"` |
| `components/BlockDomainPage.tsx:267` / `276` | `h-7 w-7` / `h-7 w-7 hover:text-destructive` | `Button` sizes |

**Count:** 14 exact/regex-matching raw icon buttons (`h-6 w-6`), plus ≥10 divergent raw icon buttons at `h-7`/`h-8`. Total hand-rolled icon buttons ≈ **24**, in **10 files**. Radius is inconsistently `rounded` (bare, 4px), `rounded-md` (6px), or absent; focus ring present in some, absent in others; hover is `bg-muted`, `bg-secondary`, or `bg-danger/10`.

**Also note** `CopyUrlButton` (`ui.tsx:113–141`) is already an icon-button-ish primitive — it renders `<Button variant="ghost" size="icon" className="h-6 w-6 px-0 text-muted-foreground hover:text-foreground">` (`133`) — but its hover is *ghost* (`hover:text-foreground` only), **not** the `hover:border-border hover:bg-muted` treatment of the 14 raw buttons. So the one existing "icon button primitive" is itself inconsistent with the dominant raw pattern.

---

## 6. Status / severity → className maps

Hand-rolled maps and ternaries that map a domain value to a `Badge` variant or className. **There are 6 distinct definitions of essentially one mapping.**

### 6a. `severityVariant` — defined **twice, byte-identical**

`components/AttckFleetPage.tsx:35–44` and `components/AttckPanel.tsx:31–40`:

```ts
function severityVariant(c: string): "destructive" | "warning" | "secondary" {
  switch (c) {
    case "HIGH":   return "destructive"
    case "MEDIUM": return "warning"
    default:       return "secondary"
  }
}
```

Consumers: `AttckFleetPage.tsx:85` (`<Badge variant={severityVariant(t.severity)}>{t.severity}</Badge>`), `AttckPanel.tsx:139` (`<Badge variant={severityVariant(tech.severity)}>`).

### 6b. `actionVariant` — defined once, imported twice

`lib/logRow.ts:62–67`:

```ts
export function actionVariant(action: string): "success" | "destructive" | "warning" | "secondary" {
  if (action === "ALLOW") return "success"
  if (action === "DENY")  return "destructive"
  if (action === "FLAG")  return "warning"
  return "secondary"
}
```

Consumers: `HostInspectorPage.tsx:822` (`<Badge variant={actionVariant(r.action ?? "")}>{r.action || "—"}</Badge>`), `EventInspectorSidebar.tsx:180` and `:309` (same).

### 6c. Inline ternary in `AnalyticsPage` — **re-implements `actionVariant`**

`components/AnalyticsPage.tsx:466`:

```tsx
cell: (r) => <Badge variant={r.action === "DENY" ? "destructive" : r.action === "FLAG" ? "warning" : "success"}>{r.action || "ALLOW"}</Badge>,
```

This is `actionVariant` (`lib/logRow.ts:62`) inlined, with slightly different fallback (`"success"` vs `"secondary"`).

`components/QueryPage.tsx:265`:

```tsx
<Badge variant={d.action === "ALLOW" ? "success" : "warning"}>{d.action}</Badge>
```

A third encoding of the same ALLOW/DENY/FLAG logic (2-way, `warning` fallback).

### 6d. `STATUS_META` / `SOURCE_META`

`components/RedirectsPage.tsx:48–56`:

```ts
const STATUS_META: Record<TrackedUrl["status"], { label: string; variant: "secondary"|"success"|"warning"|"destructive" }> = {
  unknown:  { label: "Unknown",     variant: "secondary" },
  ok:       { label: "OK",          variant: "success" },
  redirect: { label: "Redirecting", variant: "warning" },
  error:    { label: "Error",       variant: "destructive" },
}
```

`components/RedirectsPage.tsx:58–65`:

```ts
const SOURCE_META: Record<TrackedUrl["source"], { label: string; variant: "default"|"secondary"|"outline" }> = {
  manual:  { label: "Manual",       variant: "secondary" },
  finding: { label: "From finding", variant: "outline" },
  auto:    { label: "Auto",         variant: "default" },
}
```

Consumers: `RedirectsPage.tsx:139`, `:164`, and 3 further matches in the same file.

### 6e. `pattern_type` ternary

`components/PatternTable.tsx:75`:

```tsx
<Badge variant={p.pattern_type === "block" ? "destructive" : "secondary"}>
```

### 6f. "ok / not-ok" enrichment ternaries — repeated **7×**

| file:line | Mapping |
|---|---|
| `components/ReportPage.tsx:567` | `hostEnrich.data.reverse_dns.status === "ok" ? "success" : "secondary"` |
| `components/ReportPage.tsx:569` | `…forward_dns.status === "ok" ? "success" : "secondary"` |
| `components/ReportPage.tsx:571` | `…rdap.status === "ok" ? "success" : "secondary"` |
| `components/ReportPage.tsx:597` | `…reverse_dns.status === "ok" ? "success" : "secondary"` |
| `components/ReportPage.tsx:599` | `…tls.status === "ok" ? "success" : "secondary"` |
| `components/ReportPage.tsx:601` | `…http.status === "ok" ? "success" : "secondary"` |
| `components/ReportPage.tsx:603` | `…rdap.status === "ok" ? "success" : "secondary"` |

Plus `ReportPage.tsx:656` (`riskLevel === "HIGH" ? "destructive" : … "MEDIUM" ? "warning" : "success"` — a fourth severity map), `RedirectsPage.tsx:951` (`edge.active ? "success" : "secondary"`), `AnalyticsPage.tsx:525` and `HostInspectorPage.tsx:962` (`hasBytes ? "success" : "secondary"` → `"Real"`/`"Estimated"`).

### 6g. `ListBadge` tone ternaries (2-way)

`components/QueryPage.tsx:948` — `<StatCard tone={result ? (result.es_online ? "success" : "danger") : "default"} …>` (StatCard tone map, not Badge, but same shape). `QueryPage.tsx:319–347`, `:1168–1182` — `ListBadge tone="danger"|"success"` hard-coded per row.

**Verdict:** a single shared `StatusBadge` (or `StatusBadge` + `tone` prop) would absorb: `severityVariant` ×2, `actionVariant` + its 2 inline re-implementations, `STATUS_META`, `SOURCE_META`, the 7 `"ok"` ternaries, the `riskLevel` ternary, the `pattern_type` ternary, and the 4 `hasBytes`/`active` ternaries — **≈ 20 call sites across 8 files**.

---

## Top 10 inconsistencies

1. **`Card` vs `Panel` are the same shell** — `ui.tsx:293` and `ui.tsx:629` share the byte-identical base `"overflow-hidden rounded-md border border-border bg-card shadow-sm"`. 84 `Panel` + 18 `Card` uses of one visual. Only difference: `Panel` has a header and `p-4 sm:p-5` body vs `Card`'s `p-5` parts.
2. **`Textarea` is dead** (`ui.tsx:193–221`) while three pages roll their own raw `<textarea>` (`BlacklistPage.tsx:700`, `JaillistPage.tsx:375`, `PatternTable.tsx:499`) with **lower fidelity**: `border-border bg-background`, no `rounded-md`, `min-h-[140px]` vs the primitive's `min-h-[120px]`, and (Blacklist/Jaillist) `font-mono`.
3. **`Badge` (`rounded-full`) vs `ListBadge` (`rounded-md`)** express the same pill with different radii and duplicate the tone classes verbatim (`ui.tsx:244` ↔ `ui.tsx:271`).
4. **Radius drift on the chip/slab role:** `rounded-full` (`Badge`), `rounded-lg` (`EmptyState` `578`/`580`; `TrafficTimeline.tsx:77`), `rounded-md` (everything else), `rounded` bare (14 icon buttons), `rounded-sm` (`Select` item `427`).
5. **Shadow drift:** `EmptyState` and `RankedTable` and `Pagination` have no shadow while `Card`/`Panel`/`StatCard` use `shadow-sm` for the same "container" role; `Button` sets `shadow-sm` then cancels it with `shadow-none` on outline/ghost (`ui.tsx:50`, `:52`).
6. **Padding drift:** `p-5` (Card parts, StatCard) vs `p-4 sm:p-5` (Panel body) vs `p-4` (Toast) vs `px-6 py-14` (EmptyState) vs `px-3 py-3` (Pagination) — five body paddings, no rule.
7. **~24 hand-rolled icon buttons across 10 files** (14 with the exact `h-6 w-6 … rounded border border-transparent … hover:border-border hover:bg-muted` string; see §5) at three sizes (`h-6`/`h-7`/`h-8`), three radii (`rounded`/`rounded-md`/none), and with/without focus rings. The one existing candidate, `CopyUrlButton` (`ui.tsx:133`), uses ghost hover instead — so it doesn't match the dominant pattern either.
8. **≈20 status/severity→variant sites, 6 distinct definitions** of one mapping: `severityVariant` duplicated verbatim in `AttckFleetPage.tsx:35` and `AttckPanel.tsx:31`; `actionVariant` (`lib/logRow.ts:62`) re-inlined at `AnalyticsPage.tsx:466` and `QueryPage.tsx:265`; 7 identical `"ok" ? "success" : "secondary"` ternaries in `ReportPage.tsx:567–603`.
9. **Focus-ring policy is undefined:** `Button` uses `ring-offset-2`, `Input`/`Textarea` add `border-ring`, `Select` trigger has neither offset nor border, and every clickable surface (`StatCard` with `onClick`, `RankedTable` rows) half-implements it — `StatCard` declares **no ring** despite `role="button"` + `tabIndex=0` (`ui.tsx:712–716`), while `RankedTable` rows do (`ui.tsx:683`).
10. **Hard-coded theme values:** `text-white` instead of `--color-primary-foreground`/`--color-danger-foreground` (`ui.tsx:48`, `:49`); `bg-black/40` overlay (`ui.tsx:357`) duplicated at `GlobalSearchPalette.tsx:94`, `RowDetailPanel.tsx:75`, with a third variant `bg-foreground/30 backdrop-blur-[1px]` at `EventInspectorSidebar.tsx:159`; the entire palette re-declared as hex in `SankeyDiagram.tsx:39–62` and `lib/echartsTheme.ts:7–27`.
