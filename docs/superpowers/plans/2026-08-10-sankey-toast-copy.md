# Sankey Scaling, Toast Auto-Dismiss, URL Copy Buttons — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the Redirect flow sankey layout for many nodes, make toasts reliably auto-dismiss after 4s, and add a copy button to every URL-displaying table cell.

**Architecture:** Three independent frontend-only changes in `admin-ui/`. (1) `SankeyDiagram.tsx` computes canvas height from total nodes across layers and widens node gaps for dense layers. (2) `ToastProvider` adds an explicit per-toast `setTimeout` auto-dismiss. (3) A reusable `CopyUrlButton` is added to `ui.tsx` and used in every URL cell.

**Tech Stack:** React + TypeScript, ECharts (sankey), Radix Toast, Tailwind, lucide-react. Frontend verified with `npm run build` (tsc) + `npm run lint` (oxlint). No vitest in this repo — do not add it.

## Global Constraints

- Frontend-only. No backend, no schema changes.
- `SankeyDiagram` public API (`nodes`, `links`, `layerColors`, `height`, `className`, `ariaLabel`) must remain unchanged — Query/Traffic sankeys depend on it.
- `toast()` / `dismiss()` API unchanged; default duration stays 4000ms; per-toast `duration` override still honored.
- Copy buttons appear in every URL/Base URL cell (always visible, per user choice).
- Excluded: LogsPage multi-URL cells; action columns already have per-row actions.
- Frontend verification is `npm run build` + `npm run lint` + manual browser check — no vitest.

---
## File Structure

- `admin-ui/src/components/ui.tsx` — toast auto-dismiss timer; export `CopyUrlButton`.
- `admin-ui/src/components/SankeyDiagram.tsx` — height/label/gap scaling.
- `admin-ui/src/components/QueryPage.tsx` — copy buttons on URL + Base URL.
- `admin-ui/src/components/RedirectsPage.tsx` — copy buttons on URL + Final URL.
- `admin-ui/src/components/FindingsPage.tsx` — copy button on Base URL (URL already has one).
- `admin-ui/src/components/GraphPage.tsx` — copy button on URL.
- `admin-ui/src/components/BlacklistPage.tsx` — copy button per entry row.

---

### Task 1: Reliable toast auto-dismiss

**Files:**
- Modify: `admin-ui/src/components/ui.tsx:514-584`

**Interfaces:**
- Consumes: nothing (existing `ToastProvider`).
- Produces: unchanged `toast()` / `dismiss()` API; toasts now reliably dismiss after `duration`.

- [ ] **Step 1: Add an explicit per-toast auto-dismiss timer**

Replace the `ToastProvider` body so each pushed toast schedules its own dismissal:

```tsx
export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastRecord[]>([])
  const timersRef = useRef<Map<string, number>>(new Map())

  const clearTimer = useCallback((id: string) => {
    const t = timersRef.current.get(id)
    if (t !== undefined) {
      window.clearTimeout(t)
      timersRef.current.delete(id)
    }
  }, [])

  const dismiss = useCallback(
    (id: string) => {
      clearTimer(id)
      setToasts((prev) => prev.filter((t) => t.id !== id))
    },
    [clearTimer],
  )

  const toast = useCallback((input: ToastInput | string) => {
    const rec: ToastRecord =
      typeof input === "string"
        ? {
            id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            title: input,
            variant: "default",
            duration: 4000,
          }
        : {
            id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            title: input.title ?? input.description ?? "Notification",
            description: input.description,
            variant: input.variant ?? "default",
            duration: input.duration ?? 4000,
          }
    clearTimer(rec.id) // remove any stale timer for a reused id (idempotent)
    timersRef.current.set(
      rec.id,
      window.setTimeout(() => dismiss(rec.id), rec.duration),
    )
    setToasts((prev) => [...prev, rec])
  }, [clearTimer, dismiss])

  // Clean up any pending timers on unmount.
  useEffect(() => {
    const timers = timersRef.current
    return () => {
      timers.forEach((t) => window.clearTimeout(t))
      timers.clear()
    }
  }, [])

  return (
    <ToastContext.Provider value={{ toast, dismiss }}>
      <ToastPrimitive.Provider swipeDirection="right" duration={4000}>
        {children}
        {toasts.map((t) => {
          const { icon: Icon, className } = toastVariantStyles[t.variant]
          return (
            <ToastPrimitive.Root
              key={t.id}
              duration={t.duration}
              onOpenChange={(open) => !open && dismiss(t.id)}
              className={cn(
                "group pointer-events-auto relative flex w-full items-start gap-3 overflow-hidden rounded-md border p-4 shadow-lg",
                "data-[state=open]:slide-in-from-bottom data-[state=closed]:animate-out",
                "data-[swipe=move]:translate-x-[var(--radix-toast-swipe-move-x)]",
                "data-[swipe=cancel]:translate-x-0 data-[swipe=end]:translate-x-[var(--radix-toast-swipe-end-x)]",
                "transition-transform",
                className,
              )}
            >
              <Icon className="mt-0.5 h-5 w-5 shrink-0" aria-hidden="true" />
              <div className="flex-1 space-y-0.5">
                <ToastPrimitive.Title className="text-sm font-semibold">
                  {t.title}
                </ToastPrimitive.Title>
                {t.description && (
                  <ToastPrimitive.Description className="text-xs text-muted-foreground">
                    {t.description}
                  </ToastPrimitive.Description>
                )}
              </div>
              <ToastPrimitive.Close
                aria-label="Dismiss"
                className="rounded-sm opacity-60 transition-opacity hover:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <X className="h-4 w-4" />
              </ToastPrimitive.Close>
            </ToastPrimitive.Root>
          )
        })}
        <ToastPrimitive.Viewport className="fixed bottom-0 right-0 z-[100] flex max-h-screen w-full flex-col-reverse gap-2 p-4 sm:max-w-sm" />
      </ToastPrimitive.Provider>
    </ToastContext.Provider>
  )
}
```

Ensure `useRef` and `useEffect` are imported from React at the top of `ui.tsx` (check the existing import line and add them if missing).

- [ ] **Step 2: Build**

Run: `cd admin-ui && npm run build`
Expected: tsc passes.

- [ ] **Step 3: Commit**

```bash
git add admin-ui/src/components/ui.tsx
git commit -m "fix: make toasts auto-dismiss reliably via explicit timer"
```

---

### Task 2: Sankey height scaling for many nodes

**Files:**
- Modify: `admin-ui/src/components/SankeyDiagram.tsx:118-126` (contentHeight), `:128-132` (MAX_LABEL/formatLabel), `:181-213` (series options)

**Interfaces:**
- Consumes: `SankeyNode`/`SankeyLink` (unchanged).
- Produces: unchanged component API; canvas height now scales with total node count across layers.

- [ ] **Step 1: Rewrite contentHeight to scale from the densest layer + total layers**

```tsx
function contentHeight(nodes: SankeyNode[], nodeHeight = 30, nodeGap = 16, pad = 44) {
  const byLayer: Record<number, number> = {}
  for (const n of nodes) {
    const layer = n.layer ?? 0
    byLayer[layer] = (byLayer[layer] ?? 0) + 1
  }
  const counts = Object.values(byLayer)
  const maxLayerNodes = Math.max(1, ...counts)
  const numLayers = Math.max(1, counts.length)
  // Height must fit the densest layer *and* give every layer vertical room:
  // dense layers drive per-node height, and more layers add inter-layer gap.
  const nodesSpace = maxLayerNodes * nodeHeight + (maxLayerNodes - 1) * nodeGap
  const layersSpace = (numLayers - 1) * 12
  return Math.max(240, Math.min(720, pad + nodesSpace + layersSpace))
}
```

- [ ] **Step 2: Widen nodeGap when a layer is dense**

In `buildOption`, compute a dense-layer-aware gap so adjacent nodes in a packed layer don't collide:

```tsx
const maxLayerNodes = nodes.reduce((acc, n) => {
  const layer = n.layer ?? 0
  const counts: Record<number, number> = {}
  for (const node of nodes) {
    const l = node.layer ?? 0
    counts[l] = (counts[l] ?? 0) + 1
  }
  return Math.max(acc, counts[layer] ?? 1)
}, 0)
const nodeGap = maxLayerNodes > 14 ? 20 : maxLayerNodes > 8 ? 18 : 16
```

(Or hoist the layer-count computation once above the `series` object and reuse it.)

- [ ] **Step 3: Raise MAX_LABEL and only truncate when needed**

```tsx
const MAX_LABEL = 60

function formatLabel(name: string): string {
  return name.length > MAX_LABEL ? `${name.slice(0, MAX_LABEL - 1)}…` : name
}
```

- [ ] **Step 4: Build**

Run: `cd admin-ui && npm run build`
Expected: tsc passes.

- [ ] **Step 5: Commit**

```bash
git add admin-ui/src/components/SankeyDiagram.tsx
git commit -m "fix: scale sankey height for many nodes so layers don't stack"
```

---

### Task 3: Add reusable CopyUrlButton to ui.tsx

**Files:**
- Modify: `admin-ui/src/components/ui.tsx` (new export near Button)

**Interfaces:**
- Consumes: `useToast` (same file).
- Produces: `CopyUrlButton({ value, label?: string, className?, size? })` — a ghost icon button that copies `value` to the clipboard and shows a success toast.

- [ ] **Step 1: Add the component**

After the `Button` component definition in `ui.tsx`:

```tsx
import { Copy } from "lucide-react" // add to existing lucide import

/**
 * Small ghost "copy" button for table cells showing a (possibly truncated)
 * URL. Copies the exact value and shows a "Copied" toast.
 */
export function CopyUrlButton({
  value,
  label,
  className,
  size = "sm",
}: {
  value: string
  /** Accessible label prefix, e.g. the column name. Defaults to "Copy". */
  label?: string
  className?: string
  size?: "sm" | "icon"
}) {
  const { toast } = useToast()
  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(value)
      toast({ title: "Copied", description: value, variant: "success" })
    } catch {
      toast({ title: "Copy failed", variant: "error" })
    }
  }
  return (
    <Button
      variant="ghost"
      size={size}
      onClick={handleCopy}
      className={cn("h-6 w-6 shrink-0 text-muted-foreground hover:text-foreground", className)}
      aria-label={label ? `Copy ${label}` : "Copy"}
    >
      <Copy className="h-3.5 w-3.5" />
    </Button>
  )
}
```

If `useToast` is defined later in the file than `Button`, the component can still reference it (function hoisting / call-time resolution) — but verify the import ordering so `useToast` is in scope. Add `Copy` to the lucide-react import at the top of the file.

- [ ] **Step 2: Build**

Run: `cd admin-ui && npm run build`
Expected: tsc passes.

- [ ] **Step 3: Commit**

```bash
git add admin-ui/src/components/ui.tsx
git commit -m "feat: add reusable CopyUrlButton to ui kit"
```

---

### Task 4: Copy buttons on QueryPage URL + Base URL

**Files:**
- Modify: `admin-ui/src/components/QueryPage.tsx:310-416` (columns), import line `:24-35`

**Interfaces:**
- Consumes: `CopyUrlButton` from Task 3.
- Produces: URL and Base URL cells each render a `CopyUrlButton`.

- [ ] **Step 1: Import CopyUrlButton**

Add `CopyUrlButton` to the `./ui` import in `QueryPage.tsx`.

- [ ] **Step 2: Add copy button to the URL cell**

Replace the URL cell body with a flex row that truncates the URL and shows the copy button:

```tsx
{
  id: "url",
  header: "URL",
  accessor: (d) => d.url,
  defaultSortDir: "asc",
  cell: (d) => (
    <span className="flex items-center gap-1.5">
      <span className="block max-w-[340px] truncate font-mono text-xs" title={d.url}>
        {d.url}
      </span>
      <CopyUrlButton value={d.url} label="URL" />
    </span>
  ),
},
```

- [ ] **Step 3: Add copy button to the Base URL cell**

```tsx
{
  id: "base_url",
  header: "Base URL",
  accessor: (d) => d.base_url,
  defaultSortDir: "asc",
  cell: (d) => (
    <span className="flex items-center gap-1.5">
      <span className="block max-w-[220px] truncate font-mono text-xs text-muted-foreground" title={d.base_url}>
        {d.base_url}
      </span>
      <CopyUrlButton value={d.base_url} label="Base URL" />
    </span>
  ),
},
```

- [ ] **Step 4: Build**

Run: `cd admin-ui && npm run build`
Expected: tsc passes.

- [ ] **Step 5: Commit**

```bash
git add admin-ui/src/components/QueryPage.tsx
git commit -m "feat: copy buttons on Query page URL columns"
```

---

### Task 5: Copy buttons on RedirectsPage URL + Final URL

**Files:**
- Modify: `admin-ui/src/components/RedirectsPage.tsx:442-482` (URL/Final URL cells), `:26-37` (imports)

**Interfaces:**
- Consumes: `CopyUrlButton` from Task 3.
- Produces: URL and Final URL cells each render a `CopyUrlButton` (Final URL only when a value is shown).

- [ ] **Step 1: Import CopyUrlButton**

Add `CopyUrlButton` to the `./ui` import in `RedirectsPage.tsx`.

- [ ] **Step 2: Add copy button to the URL cell**

```tsx
{
  id: "url",
  header: "URL",
  accessor: (i) => i.url,
  defaultSortDir: "asc",
  cell: (i) => (
    <span className="flex items-center gap-1.5">
      <span className="block max-w-[320px] truncate font-mono text-xs" title={i.url}>
        {i.url}
      </span>
      <CopyUrlButton value={i.url} label="URL" />
    </span>
  ),
},
```

- [ ] **Step 3: Add copy button to the Final URL cell (only when shown)**

```tsx
{
  id: "final_url",
  header: "Final URL",
  accessor: (i) => i.final_url,
  cell: (i) =>
    i.final_url && i.final_url !== i.url ? (
      <span className="flex items-center gap-1.5">
        <span className="block max-w-[280px] truncate font-mono text-xs text-muted-foreground" title={i.final_url}>
          {i.final_url}
        </span>
        <CopyUrlButton value={i.final_url} label="Final URL" />
      </span>
    ) : (
      <span className="text-xs text-muted-foreground/60">—</span>
    ),
},
```

- [ ] **Step 4: Build**

Run: `cd admin-ui && npm run build`
Expected: tsc passes.

- [ ] **Step 5: Commit**

```bash
git add admin-ui/src/components/RedirectsPage.tsx
git commit -m "feat: copy buttons on Redirects page URL columns"
```

---

### Task 6: Copy button on FindingsPage Base URL

**Files:**
- Modify: `admin-ui/src/components/FindingsPage.tsx:358-380` (Base URL cell)

**Interfaces:**
- Consumes: `CopyUrlButton` from Task 3.
- Produces: Base URL cell renders a `CopyUrlButton`. (URL cell already has an inline copy button.)

- [ ] **Step 1: Import CopyUrlButton**

Add `CopyUrlButton` to the `./ui` import in `FindingsPage.tsx`.

- [ ] **Step 2: Add copy button to the Base URL cell**

The Base URL cell currently renders a flex row with `whitelistIndex`/`blacklistIndex` badges. Add a `CopyUrlButton` after the truncated span (before or after the badge, keeping the row layout):

```tsx
cell: (f) => (
  <div className="flex items-center gap-2">
    <span className="truncate font-mono text-sm text-muted-foreground">{f.base_url}</span>
    <CopyUrlButton value={f.base_url} label="Base URL" />
    {whitelistIndex[f.base_url] ? (
      <span
        className="inline-flex shrink-0 items-center gap-1 rounded-full border border-success/30 bg-success/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-success"
        title="Already in whitelist"
        aria-label="Already in whitelist"
      >
        <CheckCircle2 className="h-3 w-3" />
        whitelist
      </span>
    ) : blacklistIndex[f.base_url] ? (
      <span
        className="inline-flex shrink-0 items-center gap-1 rounded-full border border-danger/30 bg-danger/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-danger"
        title="In blacklist"
        aria-label="In blacklist"
      >
        <CheckCircle2 className="h-3 w-3" />
        In blacklist
      </span>
    ) : null}
  </div>
),
```

- [ ] **Step 3: Build**

Run: `cd admin-ui && npm run build`
Expected: tsc passes.

- [ ] **Step 4: Commit**

```bash
git add admin-ui/src/components/FindingsPage.tsx
git commit -m "feat: copy button on Findings page Base URL column"
```

---

### Task 7: Copy button on GraphPage URL column

**Files:**
- Modify: `admin-ui/src/components/GraphPage.tsx:317-326` (URL cell), `:16-27` (imports)

**Interfaces:**
- Consumes: `CopyUrlButton` from Task 3.
- Produces: URL cell renders a `CopyUrlButton`.

- [ ] **Step 1: Import CopyUrlButton**

Add `CopyUrlButton` to the `./ui` import in `GraphPage.tsx`.

- [ ] **Step 2: Add copy button to the URL cell**

```tsx
{
  id: "url",
  header: "URL",
  accessor: (f) => f.url,
  defaultSortDir: "asc",
  cell: (f) => (
    <span className="flex items-center gap-1.5">
      <span className="block max-w-[420px] truncate font-mono text-xs" title={f.url}>
        {f.url}
      </span>
      <CopyUrlButton value={f.url} label="URL" />
    </span>
  ),
},
```

- [ ] **Step 3: Build**

Run: `cd admin-ui && npm run build`
Expected: tsc passes.

- [ ] **Step 4: Commit**

```bash
git add admin-ui/src/components/GraphPage.tsx
git commit -m "feat: copy button on Traffic page URL column"
```

---

### Task 8: Copy button on BlacklistPage entry rows

**Files:**
- Modify: `admin-ui/src/components/BlacklistPage.tsx:142-177` (entry row), `:11-33` (imports)

**Interfaces:**
- Consumes: `CopyUrlButton` from Task 3.
- Produces: each entry row renders a `CopyUrlButton` (only in non-select mode, next to the delete button).

- [ ] **Step 1: Import CopyUrlButton**

Add `CopyUrlButton` to the `./ui` import in `BlacklistPage.tsx`.

- [ ] **Step 2: Add copy button to each entry row**

The entry `<li>` renders the value span and, when not in select mode, a delete button. Add a `CopyUrlButton` before the delete button:

```tsx
<span className="min-w-0 flex-1 truncate font-mono text-xs" title={value}>
  {value}
</span>
{!selectMode && (
  <span className="flex items-center gap-1">
    <CopyUrlButton value={value} label="Entry" />
    <button
      type="button"
      onClick={() => onDelete(kind, value)}
      disabled={disabled}
      aria-label={`Remove ${value} from blacklist`}
      className="inline-flex h-7 w-7 shrink-0 cursor-pointer items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-danger/10 hover:text-destructive focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50"
    >
      <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
    </button>
  </span>
)}
```

- [ ] **Step 3: Build**

Run: `cd admin-ui && npm run build`
Expected: tsc passes.

- [ ] **Step 4: Commit**

```bash
git add admin-ui/src/components/BlacklistPage.tsx
git commit -m "feat: copy button on Blacklist page entries"
```

---

### Task 9: Final verification

**Files:**
- Run backend suite (unchanged, regression check) + frontend build/lint + manual browser check.

- [ ] **Step 1: Backend regression check**

Run: `.venv/bin/python -m pytest -q`
Expected: all tests pass (should be unchanged).

- [ ] **Step 2: Frontend build + lint**

Run: `cd admin-ui && npm run build && npm run lint`
Expected: build succeeds, lint clean.

- [ ] **Step 3: Manual browser check**

- Redirect flow with many tracked URLs renders distinct node rows (not stacked horizontally).
- Toasts (success/error/info) auto-dismiss after ~4s.
- Copy buttons appear in every URL/Base URL cell and copy the full (untruncated) value.

- [ ] **Step 4: Commit any remaining docs / confirm clean tree**

```bash
git status --short
git log --oneline -10
```

---

## Self-Review

**Spec coverage:**
- Sankey scaling → Task 2 (height from densest layer + layers, wider nodeGap, longer MAX_LABEL). ✅
- Toast auto-dismiss → Task 1 (explicit timer, 4s default, per-toast override). ✅
- Copy buttons on QueryPage URL+BaseURL, RedirectsPage URL+FinalURL, FindingsPage BaseURL (URL already had one), GraphPage URL, BlacklistPage rows. ✅
- Exclusions honored (LogsPage, action columns). ✅
- Verification (build, lint, manual, backend regression) → Task 9. ✅

**Placeholder scan:** No TBD/TODO; every code step includes full content. ✅

**Type consistency:** `CopyUrlButton({ value, label?, className?, size? })` defined in Task 3 is used identically in Tasks 4-8. `contentHeight`/`MAX_LABEL`/`nodeGap` names consistent. ✅
