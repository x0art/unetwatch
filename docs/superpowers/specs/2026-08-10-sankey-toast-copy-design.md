# Sankey Scaling, Toast Auto-Dismiss, URL Copy Buttons — Design

**Date:** 2026-08-10
**Status:** Approved for implementation

## Overview

Three independent frontend improvements to the admin UI:

1. **Fix the Redirect flow sankey** when many tracked URLs produce many nodes — it currently stacks nodes into horizontal layers and the chart looks broken.
2. **Make toasts reliably auto-dismiss** after their duration (default 4s). The Radix-driven auto-close sometimes never fires, leaving toasts stuck on screen.
3. **Add a copy button to every URL-displaying table cell**, so a truncated URL can always be copied in full.

All three are frontend-only changes in `admin-ui/`. No backend changes, no schema changes.

---

## 1. Redirect flow sankey — many-node scaling

### Problem

The Redirect flow (`RedirectsPage.tsx` → `SankeyDiagram`) layers each URL by its longest-path depth (`toSankey`, `RedirectsPage.tsx:120-135`). `contentHeight` (`SankeyDiagram.tsx:118-126`) sizes the canvas from the **largest single layer** (max nodes in one layer), capped at 700px. With many tracked URLs, several nodes share the same layer; the height is too small for all of them, so ECharts compresses an entire layer into the fixed canvas — nodes stack horizontally and the diagram is unreadable.

### Fix (in `SankeyDiagram.tsx`)

- **Scale height from total node count across layers**, not just the largest layer:
  `height = base + maxNodesInAnyLayer * perNodeHeight + (layerCount - 1) * gap`, with a floor and an upper cap. Larger node sets get more vertical room automatically.
- **Widen `nodeGap` when a layer holds many nodes**, so adjacent nodes don't collide.
- **Increase `MAX_LABEL`** so longer URLs stay readable, and only truncate when really necessary.
- Keep the `SankeyDiagram` component API unchanged — Query and Traffic sankeys (non-layered, limit-capped) are untouched.

### Scope

Redirect flow only. No changes to Query page or Traffic/Graph page sankey.

---

## 2. Toasts reliably auto-dismiss (default 4s)

### Problem

`ToastProvider` (`ui.tsx:514-584`) relies on Radix's open-state timer via `duration` on the `<ToastPrimitive.Provider>` and each `<ToastPrimitive.Root>`. In practice this sometimes never fires, leaving toasts visible indefinitely.

### Fix (in `ui.tsx`)

- Add an **explicit in-state auto-dismiss timer** inside `ToastProvider`: when a toast is added, `setTimeout(() => dismiss(id), t.duration)`. Clear the timer on manual dismiss and on unmount.
- Keep the existing 4s default (`duration ?? 4000`) and the per-toast `duration` override.
- Keep `toast()` / `dismiss()` API identical so all 60+ call sites are unaffected.

---

## 3. URL copy button in every URL column cell

### Approach

Add a small reusable `CopyUrlButton` (ghost icon button, `aria-label="Copy"`, clipboard write + "Copied" toast). Add it to **every** cell that displays a URL/Base URL:

| Page | Columns |
|---|---|
| QueryPage | URL, Base URL |
| RedirectsPage | URL, Final URL |
| FindingsPage | URL, Base URL |
| GraphPage | URL |
| BlacklistPage | each entry row |

Each click copies the **exact, untruncated** value and shows a brief success toast.

### Notes / exclusions

- **LogsPage** multi-URL cells are not simple single values — left unchanged.
- No copy button on action columns (they already have per-row actions).
- Button is always visible in URL cells (per user choice), not only when truncated.

---

## Verification

- `npm run build` (tsc) passes.
- `npm run lint` (oxlint) passes.
- Manual browser check:
  - Redirect flow with many tracked URLs renders distinct node rows (not stacked).
  - Toasts auto-dismiss after ~4s (including error/info variants).
  - Copy buttons appear in every URL cell and copy the full value.
- Backend unchanged: no backend tests needed; run the full pytest suite to confirm nothing regressed.

## Files touched

- `admin-ui/src/components/SankeyDiagram.tsx` — height/label/gap scaling.
- `admin-ui/src/components/ui.tsx` — toast auto-dismiss timer; `CopyUrlButton` export.
- `admin-ui/src/components/QueryPage.tsx` — copy buttons on URL/Base URL.
- `admin-ui/src/components/RedirectsPage.tsx` — copy buttons on URL/Final URL.
- `admin-ui/src/components/FindingsPage.tsx` — copy buttons on URL/Base URL.
- `admin-ui/src/components/GraphPage.tsx` — copy button on URL.
- `admin-ui/src/components/BlacklistPage.tsx` — copy button per entry row.
