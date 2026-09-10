# Audit-Fix: uNetWatch design-system adherence

- **Facts (audit)**: `/home/x0art/.superpowers/sdd/redesign-audit-fixes/facts-audit.md`
- **Baseline**: 184 pytest pass, tsc+vite build clean, oxlint clean (14 warnings, 0 errors)
- **User mandate**: "audit. automate, ask-matt, grill, subagent driven, push, i will afk" — autonomous end-to-end, push to origin/main when green

## Rulings (from self-directed grilling against recorded decisions)

- **Ruling: Do NOT create a git worktree.** The repo's established SDD convention (2026-08-13, 2026-09-03 ledgers) commits on main at clean BASE; the final gate is whole-branch review before push. Single-implementer-at-a-time prevents conflicts. Cost if wrong: interleaved commits — mitigated by reset-on-revert.
- **Ruling: Sankey layer colors and the sidebar ink slab are not defects.** LAYER_COLORS = fixed hexes by design (neobrutalist brand). `#0A0A0A` URL nodes ARE invisible on dark `#0A0A0A` background — this is a real defect. Fix: swap URL layer to `#F6F2E8` in dark mode. Also fix muted tones (`#6B6560` → dark-aware). Remaining LAYER_COLORS hexes stay as-is (design intent).
- **Ruling: Hardcoded `#0A0A0A`/`#F6F2E8`/`#FFD60A`/`#FF3B30` in arbitrary-value tailwind classes are NOT defects** — these are the brand palette tokens, used correctly in dark-mode-paired form (`dark:bg-[#F6F2E8]` etc.). Converting to CSS vars would be scope-creep. Exception: `ui.tsx:44` uses bare `#6B6560` (light muted-foreground) without dark variant — fix.
- **Ruling: std::RedirectFlowDiagram.tsx (491 lines) is dead code** — last imported in ff448f0, replaced by NetworkGraphDiagram. Delete it.
- **Ruling: Skip-link EXISTS** in AppShell.tsx:41 `href="#main-content"`. Not a finding.
- **Ruling: DashboardPage quick-link `<button>`s lack aria-labels but have visible text content** — WCAG 2.1 allows this for buttons with visible text labels. Not a finding.
- **Ruling: `h-screen` on sidebar is acceptable** — sticky sidebar, not a full-page container. Not a finding.
- **Ruling: ALL rule-out findings (font swap, radius, gradients, sidebar patterns, glassmorphism, spotlight borders) are non-findings** — neobrutalist is the recorded brand per CONTEXT.md and ADR-0002. Fix scope is ADHERENCE to that system, not replacement.

## Global Constraints

- Do NOT modify `src/index.css` @theme tokens — they define the brand.
- All color/token fixes must match the existing `dark:` prefix pattern.
- No new dependencies.
- All new components must use the Skeleton primitive from `src/components/ui.tsx` for loading states.
- Empty state must use `src/components/ui.tsx` EmptyState component or the established "NO DATA IN WINDOW" `<p>` pattern.
- Error states must use toast notifications (`useToast()`) or inline `<EmptyState>`.
- Every interactive element must have `focus-visible` ring styling (either from global CSS or explicit class).
- `tabular-nums` should be added to any `font-mono` span that shows a number likely to change (counts, durations, sizes).
- Verify each task with `pytest`, `npm run build` (tsc), `npx oxlint`.

## Task 1: Dark-mode fixes — Sankey layer colors + ui.tsx dark breakage

**Files:**
- `src/components/SankeyDiagram.tsx`
- `src/components/ui.tsx`
- `src/lib/echartsTheme.ts`

**Sankey LAYER_COLORS dark fix:**
In `SankeyDiagram.tsx`, the `LAYER_COLORS` record currently holds fixed hexes. When `theme === "dark"`, these produce invisible or low-contrast nodes on the `#0A0A0A` background:
- Layer 2 (URLs): `#0A0A0A` on `#0A0A0A` bg = invisible. Fix: `#F6F2E8` in dark.
- Layer 0 (Patterns): `#6B6560` on dark = too dark. Fix: `#9A9590` in dark.
- Layer 3 (Destinations): `#9A9590` → already visible on dark, but dim. Keep.
- Layer 1 (Sources): `#0A7AFF` → visible on both. Keep.

Change `LAYER_COLORS` to a function `function layerColor(layer: number, isDark: boolean): string` that returns the dark-aware hex. The `destColor()` function should also check dark.

In `buildOption`, the `palette.label` and `palette.muted` already resolve through `resolveAllColors` which is dark-aware — fine.

**ui.tsx dark breakage fix:**
Line 44 (inside buttonVariants.default toast success): `text-[#0A0A0A] dark:border-[#F6F2E8]` — the `#6B6560` isn't visible here. Actually checking: line 44 in buttonBase is `default: "bg-primary text-white hover:brightness-[1.06] border-[#0A0A0A] dark:border-[#F6F2E8]"` — that's fine. The real dark breakage is actually the suggestion that `#6B6560` is used somewhere without a dark variant.

Wait, let me re-check — I need to look at the exact lines more carefully:

ui.tsx:44: `default: "bg-primary text-white hover:brightness-[1.06] border-[#0A0A0A] dark:border-[#F6F2E8]"`
ui.tsx:260: `"inline-flex shrink-0 items-center gap-1 border-[2px] border-[#0A0A0A] px-2 py-0.5 font-mono text-[10px] font-extrabold uppercase tracking-widest dark:border-[#F6F2E8]"`
ui.tsx:475: `success: { icon: CheckCircle2, className: "bg-secondary text-[#0A0A0A] border-[#0A0A0A] brutal-shadow" }` — lacks dark:border variant. Should be `brutal-shadow` which uses shadow-color token (dark-aware) but border is fixed `#0A0A0A`. Fix: add `dark:border-[#F6F2E8]`.

Actual dark breakage risks to fix:
1. `ui.tsx:475` — toast success variant: `border-[#0A0A0A]` missing `dark:border-[#F6F2E8]`
2. `ui.tsx:476` — toast error variant: `border-[#0A0A0A]` missing dark variant
3. `ui.tsx:477` — toast info variant: `border-[#0A0A0A]` missing dark variant
4. `ui.tsx:214` — Select secondary variant: `border-[#0A0A0A]` missing dark variant
5. `ui.tsx:215` — Select destructive variant: `border-[#0A0A0A]` missing dark variant

**echartsTheme.ts:**
FALLBACK_DARK and FALLBACK_LIGHT already contain correct pairs. No change needed.

## Task 2: Add tabular-nums on all numeric stat values

**Files:**
- `src/components/ui.tsx` — AnimatedNumber in StatCard value div
- `src/components/motion.tsx` — AnimatedNumber render
- `src/components/DataTable.tsx` — add tabular-nums to right-aligned/numeric cell spans
- `src/components/QueryPage.tsx` — numeric cells missing tabular-nums
- `src/components/HostInspectorPage.tsx` — duration/bytes cells
- `src/components/UrlInvestigationPage.tsx` — numeric cells

StatCard values use `font-display text-[30px]` wrapping AnimatedNumber. The parent class `leading-none` should gain `tabular-nums`. AnimatedNumber renders `{display.toLocaleString()}` inside a Fragment — wrap in `<span className="tabular-nums">`.

For DataTable, right-aligned columns should get `tabular-nums` on the cell content span. Detecting which columns are numeric at the DataTable level is complex — instead, add `tabular-nums` to the `data-[state=checked]` cell styling. Actually, simplest: add `tabular-nums` to the auto-generated cell wrapper when `col.align === "right"`.

## Task 3: Reduce hardcoded hex tokens in ui.tsx (border variants lacking dark pairs)

**Files:**
- `src/components/ui.tsx`

Scan all `text-[#0A0A0A]` / `bg-[#0A0A0A]` / `border-[#0A0A0A]` classes that lack a corresponding `dark:border-[#F6F2E8]` / `dark:text-[#F6F2E8]` / `dark:bg-[#F6F2E8]` pair.

From audit:
- ui.tsx:213-218 (Select variant colors): check each for missing dark
- ui.tsx:475-477 (Toast variants): border-[#0A0A0A] missing dark:border
- ui.tsx:683-684 (StatCard statToneBar): missing dark variants

Also: `border-[#0A0A0A]` in buttonBase (line 40) is fine — it uses `border-border` which IS a CSS var that inverts in dark.

## Task 4: Add document.title updates per page view

**Files:**
- `src/components/AppShell.tsx` — add useEffect to set document.title from the `title` prop
- Every page component: titles are already passed via AppShell's title prop. The AppShell already receives `title` and `description`. Simply add:
  ```tsx
  useEffect(() => { document.title = `uNetWatch — ${title}` }, [title])
  ```

## Task 5: Remove dead code — RedirectFlowDiagram.tsx

**Files:**
- `src/components/RedirectFlowDiagram.tsx` (delete)
- `src/components/SankeyDiagram.tsx` (remove stale comment on line 20)

## Task 6: Stale comments — api.ts "standard purple" + SankeyDiagram.tsx import comment

**Files:**
- `src/api.ts` line 834: change `"standard purple"` → `"LAYER_COLORS[3] muted"`  
- `src/components/SankeyDiagram.tsx` line 20: remove `// `from "./SankeyDiagram"` imports (RedirectFlowDiagram, NetworkGraphDiagram)``

## Task 7: Fine — DashboardPage silent .catch() patterns

**Files:**
- `src/components/DashboardPage.tsx`

Three `.catch(() => {})` blocks at lines 99-100, 106-107, 119-121 silently swallow fetch errors with no user feedback. Replace with toast error notifications.

## Task 8: Verify — full baseline re-check

Run: pytest, npm run build, npx oxlint — all must pass before final review.