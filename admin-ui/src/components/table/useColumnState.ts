import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import type { Density, PersistedTableState, ColumnState } from "./types"
import { readPersisted, writePersisted, clearPersisted } from "./types"

/* ════════════════════════════════════════════════════════════════
 * useColumnState — visibility / width / order + density, with the
 * §4.4 precedence rule:
 *
 *     controlled prop  →  persisted (viewKey)  →  default<X> prop  →  built-in
 *
 * `viewKey` is the ONLY switch that turns on persistence; without it the
 * hook is purely in-memory so existing call sites are unaffected. A
 * controlling prop always beats stored state (never the reverse).
 * ================================================================ */

export interface ColumnStateDefaults {
  /** Column ids in declared order — drives visibility/order fallbacks. */
  ids: string[]
  /** ids that must never be hidden (`hideable: false` / structural). */
  pinned: string[]
  /** Declared default visibility (a column hidden by authoring). */
  defaultVisibility: Record<string, boolean>
  /** Declared default widths in px (already parsed from `col.width`). */
  defaultWidths: Record<string, number>
  /** ids the chooser/reorder may touch (excludes pinned + structural). */
  reorderable: string[]
}

export interface UseColumnStateArgs {
  viewKey: string | undefined
  defaults: ColumnStateDefaults
  /** Controlled order — when given it wins outright. */
  order?: string[]
  onOrderChange?: (order: string[]) => void
  /** Controlled visibility map. */
  visibility?: Record<string, boolean>
  onVisibilityChange?: (visibility: Record<string, boolean>) => void
  /** Controlled width map (px). */
  widths?: Record<string, number>
  onWidthsChange?: (widths: Record<string, number>) => void
  /** Controlled density (`onDensityChange` presence => controlled, §4.4). */
  density?: Density
  defaultDensity?: Density
  onDensityChange?: (density: Density) => void
  /** Feature flags. */
  enableVisibility?: boolean
  enableReorder?: boolean
  enableResize?: boolean
}

export interface UseColumnStateResult {
  state: ColumnState
  setVisibility: (id: string, visible: boolean) => void
  setWidth: (id: string, width: number) => void
  /** Drop an operator-set width so the column returns to its declared width. */
  clearWidth: (id: string) => void
  setOrder: (order: string[]) => void
  reset: () => void
  /** True when anything deviates from the declared defaults (Reset gate). */
  isDirty: boolean
  density: Density
  setDensity: (density: Density) => void
}

/** Stable identity for the "feature disabled" empty maps, so memos that
 * depend on visibility/widths do not re-run on every render. */
const EMPTY_MAP: Record<string, never> = {}

/** Depth-1 comparison for string[] — stable under re-created arrays. */
function sameIds(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

function sameMap(a: Record<string, number | boolean>, b: Record<string, number | boolean>): boolean {
  const ka = Object.keys(a)
  const kb = Object.keys(b)
  if (ka.length !== kb.length) return false
  for (const k of ka) if (a[k] !== b[k]) return false
  return true
}

/** Merge `order` with the declared ids: unknown ids dropped, missing ids
 * appended in declared order, pinned columns kept at their structural ends. */
export function reconcileOrder(order: string[] | undefined, defaults: ColumnStateDefaults): string[] {
  const known = new Set(defaults.ids)
  const seen = new Set<string>()
  const out: string[] = []
  for (const id of order ?? []) {
    if (known.has(id) && !seen.has(id)) {
      out.push(id)
      seen.add(id)
    }
  }
  for (const id of defaults.ids) {
    if (!seen.has(id)) out.push(id)
  }
  return out
}

export function useColumnState({
  viewKey,
  defaults,
  order: controlledOrder,
  onOrderChange,
  visibility: controlledVisibility,
  onVisibilityChange,
  widths: controlledWidths,
  onWidthsChange,
  density: controlledDensity,
  defaultDensity = "comfortable",
  onDensityChange,
  enableVisibility = true,
  enableReorder = true,
  enableResize = true,
}: UseColumnStateArgs): UseColumnStateResult {
  // Read the persisted blob exactly once per viewKey (mount / key swap).
  const persisted = useMemo<PersistedTableState>(() => readPersisted(viewKey), [viewKey])

  const orderControlled = controlledOrder !== undefined
  const visibilityControlled = controlledVisibility !== undefined
  const widthsControlled = controlledWidths !== undefined
  const densityControlled = !!onDensityChange

  const [internalOrder, setInternalOrder] = useState<string[]>(
    () => persisted.order ?? defaults.ids,
  )
  const [internalVisibility, setInternalVisibility] = useState<Record<string, boolean>>(
    () => persisted.visibility ?? {},
  )
  const [internalWidths, setInternalWidths] = useState<Record<string, number>>(
    () => persisted.widths ?? {},
  )
  const [internalDensity, setInternalDensity] = useState<Density>(
    () => persisted.density ?? defaultDensity,
  )

  // ── Precedence resolution ─────────────────────────────────────
  const rawOrder = orderControlled
    ? controlledOrder
    : enableReorder
      ? internalOrder
      : defaults.ids
  const order = useMemo(() => reconcileOrder(rawOrder, defaults), [rawOrder, defaults])
  const visibility = visibilityControlled
    ? controlledVisibility
    : enableVisibility
      ? internalVisibility
      : EMPTY_MAP

  const widths = widthsControlled ? controlledWidths : enableResize ? internalWidths : EMPTY_MAP

  const density = densityControlled ? controlledDensity ?? defaultDensity : internalDensity

  // ── Persist on change (never for controlled props) ────────────
  const firstRender = useRef(true)
  useEffect(() => {
    if (firstRender.current) {
      firstRender.current = false
      return
    }
    if (!viewKey) return
    const patch: PersistedTableState = {}
    if (!orderControlled && enableReorder) patch.order = internalOrder
    if (!visibilityControlled && enableVisibility) patch.visibility = internalVisibility
    if (!widthsControlled && enableResize) patch.widths = internalWidths
    if (!densityControlled) patch.density = internalDensity
    writePersisted(viewKey, patch)
  }, [
    viewKey,
    orderControlled,
    visibilityControlled,
    widthsControlled,
    densityControlled,
    enableReorder,
    enableVisibility,
    enableResize,
    internalOrder,
    internalVisibility,
    internalWidths,
    internalDensity,
  ])

  const setVisibility = useCallback(
    (id: string, visible: boolean) => {
      if (visibilityControlled) {
        onVisibilityChange?.({ ...controlledVisibility, [id]: visible })
        return
      }
      setInternalVisibility((prev) => {
        const next = { ...prev }
        if (visible === (defaults.defaultVisibility[id] ?? true)) delete next[id]
        else next[id] = visible
        return next
      })
    },
    [visibilityControlled, onVisibilityChange, controlledVisibility, defaults.defaultVisibility],
  )

  const setWidth = useCallback(
    (id: string, width: number) => {
      if (widthsControlled) {
        onWidthsChange?.({ ...controlledWidths, [id]: width })
        return
      }
      setInternalWidths((prev) => {
        const next = { ...prev }
        if ((defaults.defaultWidths[id] ?? -1) === width) delete next[id]
        else next[id] = width
        return next
      })
    },
    [widthsControlled, onWidthsChange, controlledWidths, defaults.defaultWidths],
  )

  const clearWidth = useCallback(
    (id: string) => {
      if (widthsControlled) {
        const next = { ...controlledWidths }
        delete next[id]
        onWidthsChange?.(next)
        return
      }
      setInternalWidths((prev) => {
        if (!(id in prev)) return prev
        const next = { ...prev }
        delete next[id]
        return next
      })
    },
    [widthsControlled, onWidthsChange, controlledWidths],
  )

  const setOrder = useCallback(
    (next: string[]) => {
      if (orderControlled) onOrderChange?.(next)
      else setInternalOrder(next)
    },
    [orderControlled, onOrderChange],
  )

  const setDensity = useCallback(
    (next: Density) => {
      if (densityControlled) onDensityChange?.(next)
      else setInternalDensity(next)
    },
    [densityControlled, onDensityChange],
  )

  const reset = useCallback(() => {
    if (!orderControlled) setInternalOrder(defaults.ids)
    if (!visibilityControlled) setInternalVisibility({})
    if (!widthsControlled) setInternalWidths({})
    if (!densityControlled) setInternalDensity(defaultDensity)
    clearPersisted(viewKey)
  }, [orderControlled, visibilityControlled, widthsControlled, densityControlled, defaults.ids, defaultDensity, viewKey])

  const isDirty = useMemo(() => {
    if (enableReorder && !sameIds(order, defaults.ids)) return true
    if (enableVisibility) {
      const effective: Record<string, boolean> = { ...defaults.defaultVisibility, ...visibility }
      if (!sameMap(effective, defaults.defaultVisibility)) return true
    }
    if (enableResize && Object.keys(widths).length > 0) return true
    if (density !== defaultDensity) return true
    return false
  }, [order, defaults.ids, defaults.defaultVisibility, visibility, widths, density, defaultDensity, enableReorder, enableVisibility, enableResize])

  return {
    state: { order, visibility, widths },
    setVisibility,
    setWidth,
    clearWidth,
    setOrder,
    reset,
    isDirty,
    density,
    setDensity,
  }
}
