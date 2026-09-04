# ELK Monitoring Admin UI — Full Redesign + Findings Readiness

**Date:** 2026-08-04
**Approach:** 3 — Full Redesign + Findings Readiness
**Visual direction:** Dark sidebar + SaaS polish (Level B micro-interactions)
**Team:** 3 workers (foundation → dashboard/findings + patterns, parallel)

## Goal

Transform the admin console from a prototype-feeling pattern editor with a countdown
widget into a production-grade monitoring console: a persistent dark sidebar, dark-mode-first
theming, real interaction polish, and the information architecture of a findings-capable tool —
even before the backend ships a findings endpoint.

## Non-goals

- No backend changes (findings are UI-readiness only; `getFindings()` is a graceful stub).
- No react-router / state library — view state stays in `App.tsx`.
- No Level C interactions (drag-reorder, inline edit, SSE live updates, keyboard nav).

## Current state problems (what this fixes)

1. Emoji-as-icons (`🚫 ✅ ⏱️ ▶️ 🔍`) → unthemed, OS-inconsistent, unprofessional.
2. No dark mode; monochrome palette, no semantic color.
3. Raw native `<select>` and native `confirm()` break the design system.
4. Search is not debounced — fires a request per keystroke.
5. "Live" indicator is fake — always green regardless of `status.status`.
6. Countdown is meaningless on load (`lastRunRef` starts at mount, drifts).
7. Naive pagination — no total count, no page numbers, no jump.
8. Two duplicated, inconsistent toast implementations.
9. Dialog has no a11y (no Escape, no focus trap, no focus restore).
10. Block/Whitelist counts shown twice (stat cards + Config dl).
11. No freshness / "last updated" indicator.
12. The monitor's core value (what it caught) is invisible — no findings view.

## Architecture

### Layout
- **AppShell**: persistent left sidebar (fixed, dark) + `<main>` content area.
- **Sidebar**: app logo/title at top, nav items (Dashboard, Patterns, Findings) as
  icon+label buttons, theme toggle + user menu at bottom.
- **Header (inside main)**: breadcrumb / page title + context actions (refresh, etc.).
- **Mobile** (`< md`): sidebar collapses to an overlay drawer toggled by a hamburger;
  backdrop dismisses.

### Routing / view state
- `type View = "dashboard" | "patterns" | "findings"` in `App.tsx`.
- No react-router. Sidebar sets `view`; `App.tsx` renders the matching page.
- Preserves zero-extra-dependency spirit of the project.

### Theming
- Tailwind v4 `@theme` already defines `oklch` variables. Extend with:
  - Dark-mode-first values as the **default** (move current light values into a `.light`
    override or invert the structure so `.dark` is implicit and `.light` opts in).
  - Semantic colors: `--color-success`, `--color-warning`, `--color-danger` with
    `-foreground` pairs.
- Toggle via `.dark` / `.light` class on `<html>`, persisted in `localStorage("elk-theme")`.
- Theme toggle button in the sidebar footer.

### Icons
- Add `lucide-react` dependency.
- Replace every emoji with a named Lucide icon sized consistently (16/20/24px).
- Sidebar nav icons: `LayoutDashboard`, `ShieldCheck`/`ListFilter`, `Search`/`Radar`.
- Stat card icons: `Timer`, `Ban`, `CheckCircle2`, `Play`.

## Components (new / rewritten)

All in `admin-ui/src/components/`. `ui.tsx` remains the primitive layer; new compound
components live alongside it.

### `ui.tsx` rewrites / additions
- **`Select`** — rewrite as a custom dropdown (button + popover list), not native `<select>`.
  Keyboard: Arrow Up/Down, Enter, Escape. Closes on outside click.
- **`Dialog`** — enhance: Escape-to-close, focus trap (focus first focusable on open,
  restore focus to trigger on close), `role="dialog"` `aria-modal`, overlay click closes.
- **`Toaster`** — unify the two duplicated toasts. Variants: `success` (green check),
  `error` (red x), `info`. Slide-in-from-bottom animation. Auto-dismiss 3s.
- **`ConfirmDialog`** — new. Built on `Dialog`. Props: `open`, `title`, `description`,
  `confirmLabel`, `variant` (`destructive` | `default`), `onConfirm`, `onCancel`.
  Replaces `confirm()`.
- **`EmptyState`** — new. Props: `icon`, `title`, `description`, optional `action`.
- **`StatCard`** — new. Props: `icon`, `label`, `value`, `tone` (`default` | `success` |
  `warning` | `danger`), `hint`. Semantic color via `tone`.
- **`Pagination`** — new. Props: `page`, `pageSize`, `total`, `onPageChange`. Shows
  "Showing X–Y of Z", prev/next, page-number buttons with truncation, jump disabled at ends.

### `lib/utils.ts` additions
- **`cn(...classes)`** — filter falsy, join. (Currently `lib/utils.ts` exists; confirm/extend.)
- **`useDebounce<T>(value, delayMs)`** — returns debounced value. Used by Patterns search.

### New layout components
- **`AppShell`** — wraps Sidebar + main; manages mobile drawer open state.
- **`Sidebar`** — nav items, active state, theme toggle, user menu (Logout).

### Page components
- **`DashboardPage`** (extracted from current App dashboard branch) — stat cards row,
  last-updated + refresh, status indicator reflecting `status.status`, no redundant Config
  section (it duplicated the stat cards).
- **`CountdownRing`** — SVG circular progress. Props: `remaining`, `total`. Animated stroke
  offset. Center text shows `m:ss`.
- **`PatternsPage`** — the refactored `PatternTable`.
- **`FindingsPage`** (new) — `<EmptyState icon="search-x" title="No findings yet"
  description="Findings appear here when the ES poll detects matching log entries." />`.
  Reads from `getFindings()`; on the not-available response, shows the empty state.

## API layer (`api.ts`)

Add graceful findings stub:
```ts
export interface Finding { id: number; pattern: string; client_ip: string; timestamp: string }
export async function getFindings(): Promise<Finding[]> {
  // Endpoint not yet implemented on the backend. Surface a typed empty result so the
  // UI can render the empty state without throwing.
  return []
}
```
Rationale: the page exists and is wired; when the backend adds `/api/findings/`, only this
function's body changes. No UI rework needed.

## Interaction polish (Level B)

- Debounced search (300ms) in Patterns.
- Animated SVG `CountdownRing` (stroke-dashoffset transition).
- Toast slide-in + auto-dismiss.
- Skeleton shimmer on table loading (keep existing, tune timing).
- Hover/focus states on all interactive elements (focus-visible rings).
- Page fade transition on view change (light CSS opacity/transform).
- Status indicator: green `Live` only when `status.status === "running"`/healthy;
  amber `Idle`/`Unknown` otherwise.

## Fixes to existing bugs

- **Countdown meaning**: derive `lastRunRef` initial from a real signal. Since the status
  endpoint doesn't return last-run time, show the countdown as time-since-load with an
  explicit label ("approx.") OR reset only on manual run + poll-confirmed run. Document the
  limitation in a tooltip. (No backend change; honest UX.)
- **Duplicate counts**: remove the Config `<dl>` section; keep stat cards as the single source.
- **Search requests**: `useDebounce` removes the per-keystroke fetch.

## Worker split & sequencing

Foundation must land before the pages that consume it (they all import `ui.tsx` primitives).
Then the two page tracks run in parallel.

### worker-1 — Foundation (no blockers)
- `index.css`: dark-mode-first theme variables + semantic colors + `.light` override.
- `package.json`: add `lucide-react`.
- `lib/utils.ts`: `cn`, `useDebounce`.
- `ui.tsx`: rewrite `Select`, enhance `Dialog` (a11y), unify `Toaster`, add `ConfirmDialog`,
  `EmptyState`, `StatCard`, `Pagination`.
- `AppShell.tsx` + `Sidebar.tsx`.
- Wire theme toggle (localStorage `elk-theme`).

### worker-2 — Dashboard + Findings (blockedBy worker-1)
- `DashboardPage.tsx` (extract + rework dashboard branch from `App.tsx`).
- `CountdownRing.tsx`.
- `FindingsPage.tsx` + `EmptyState` usage.
- `api.ts`: add `getFindings()` stub + `Finding` type.
- `App.tsx`: switch to `AppShell` + view routing, theme-toggle wiring, status fix,
  last-updated, refresh button, remove redundant Config section.

### worker-3 — Patterns overhaul (blockedBy worker-1)
- `PatternTable.tsx` rewrite:
  - Debounced search (`useDebounce`).
  - Custom `Select` for type filter.
  - `ConfirmDialog` for delete.
  - `Pagination` (requires total count — note: current API returns only a page; if total
    is unavailable, show "Showing X–Y" without total and disable the limitation by
    next/prev only — do not fabricate a total).
  - Dialog a11y (Escape, focus trap) via enhanced `Dialog`.
  - Bulk import UX: live line-count preview, confirm count.

## Verification gates

1. `cd admin-ui && npx tsc --noEmit` — zero type errors.
2. `npm run build` — production build succeeds.
3. Manual (lead): each view renders, dark/light toggle persists, sidebar nav switches views,
   Findings shows empty state, search is debounced (network tab), delete uses ConfirmDialog.
4. No emoji-as-icons remain (`grep -RnP '[\x{1F300}-\x{1FAFF}\x{2600}-\x{27BF}]' src`).
5. No native `confirm(` or `alert(` calls remain in `src`.
6. No raw `<select>` elements remain in `src` (custom `Select` used instead).

## Risks

- **Pagination total**: the patterns list endpoint returns a page, not a total count. If the
  backend has no count endpoint, `Pagination` must degrade to prev/next without a total
  rather than fabricate one. (worker-3 to confirm against `routes/patterns.py`.)
- **Tailwind v4 dark-mode mechanism**: Tailwind v4 uses a different dark-variant config than
  v3. worker-1 must verify the `.dark` class strategy works with v4's `@theme` + `@custom-variant`.
- **`lucide-react` bundle size**: tree-shake by importing named icons only.
- **Worker coupling**: worker-2 and worker-3 both edit files that import from worker-1's
  output. Sequencing (1 → then 2∥3) prevents import-not-found breakage. No two workers edit
  the same file: worker-2 owns `App.tsx`/dashboard/findings/api.ts; worker-3 owns
  `PatternTable.tsx`. worker-1 owns `ui.tsx`/`index.css`/`lib`/shell. Zero file-overlap.
