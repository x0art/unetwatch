import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react"
import * as PopoverPrimitive from "@radix-ui/react-popover"
import * as DropdownMenuPrimitive from "@radix-ui/react-dropdown-menu"
import { AnimatePresence, motion } from "framer-motion"
import {
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  Download,
  GripVertical,
  RotateCcw,
  Rows3,
  X,
  type LucideIcon,
} from "lucide-react"
import { cn } from "../lib/utils"
import { Button, EmptyState, Pagination, Skeleton, Toolbar, useToast } from "./ui"
import { EASE, Stagger, StaggerItem } from "./motion"
import { ProgressHint } from "./loading/ProgressHint"
import { useDelayedVisible, LOADER_DELAY_MS, LOADER_MIN_VISIBLE_MS } from "./loading/useDelayedVisible"
import { useElapsed } from "./loading/useElapsed"
import {
  clearPersisted,
  isEnumFilter,
  isEnumFilterActive,
  orderBySlot,
  readPersisted,
  writePersisted,
  type ColumnSlot,
  type ContextMenuItem,
  type Density,
  type ExportPayload,
  type ExportScope,
  type PersistedTableState,
  type SavedView,
} from "./table/types"
import { useColumnState, type ColumnStateDefaults } from "./table/useColumnState"
import {
  cellExportValue,
  defaultExportFilename,
  downloadCsv,
  exportHeaderOf,
  payloadToCsv,
  toCsv,
} from "./table/exportCsv"
import { ColumnChooser } from "./table/ColumnChooser"
import { FilterBuilder, FilterChips, FilterEditor, summarizeFilter, type FilterChipModel } from "./table/FilterBuilder"
import { RowDetailPanel } from "./table/RowDetailPanel"

/* ════════════════════════════════════════════════════════════════
 * DataTable — reusable, sortable table with bulk actions
 *
 * One component for every table in the app. Supports:
 *  - sortable columns (client-side by default, or fully controlled
 *    for server-side sorting via onSortChange)
 *  - row selection + a bulk action bar (select-all, indeterminate,
 *    per-action buttons, clear)
 *  - loading skeleton rows, empty states, pagination slot
 *  - column visibility / resize / reorder with `viewKey` persistence
 *  - density (Comfortable | Compact), CSV export, toolbar
 *  - tri-state per-column filters + persistent filter chips
 *  - slot-based canonical column order (§3.1) — **inert unless a
 *    column sets `slot`**, so un-adopted call sites render unchanged
 *  - sticky header, row context menu, and a details side panel
 *
 *   <DataTable
 *     columns={columns}               // DataTableColumn<T>[]
 *     data={items}                    // T[]
 *     rowId={(row) => row.id}
 *     loading={loading}
 *     bulkActions={[{ label: "Delete", icon: Trash2, variant: "destructive",
 *                      onClick: (ids) => handleBulkDelete(ids) }]}
 *     onSortChange={(key, dir) => setSort(key, dir)}   // server-side mode
 *     page={page} pageSize={25} total={total} onPageChange={setPage}
 *   />
 *
 * Column cells: pass `cell={(row) => ...}` for custom rendering; the
 * checkbox + actions columns are handled by the component. When a column
 * is sortable and no `accessor` is given, sorting uses the rendered value.
 * ════════════════════════════════════════════════════════════════ */

export type SortDir = "asc" | "desc"
export type SortKey = string

/** Per-column filter control type. Defaults to `'enum'` (exact-match dropdown). */
export type FilterType = "enum" | "text" | "datetime" | "number"

/** Range filter for `datetime` columns: ISO-ish from/to bounds (open-ended when empty). */
export interface DatetimeFilter {
  from: string
  to: string
}

/** Range filter for `number` columns: min/max bounds (open-ended when empty). */
export interface NumberFilter {
  min: string
  max: string
}

/** Tri-state enum filter: Include / Exclude option lists. */
export interface EnumFilter {
  include: string[]
  exclude: string[]
}

/** A column filter value: scalar for `enum`/`text`, object for the rest. */
export type ColumnFilterValue = string | DatetimeFilter | NumberFilter | EnumFilter

export function isActiveFilter(value: ColumnFilterValue | undefined): boolean {
  if (value === undefined) return false
  if (typeof value === "string") return value.trim() !== ""
  if (isEnumFilter(value)) return isEnumFilterActive(value)
  return Object.values(value).some((v) => v.trim() !== "")
}

function isDatetimeFilter(value: ColumnFilterValue): value is DatetimeFilter {
  return typeof value === "object" && value !== null && "from" in value
}

function isNumberFilter(value: ColumnFilterValue): value is NumberFilter {
  return typeof value === "object" && value !== null && "min" in value
}

function emptyFilterFor(type: FilterType): ColumnFilterValue {
  if (type === "datetime") return { from: "", to: "" }
  if (type === "number") return { min: "", max: "" }
  return ""
}

/** Column slot in the canonical grammar (§3.1). */
export type { ColumnSlot } from "./table/types"

export interface DataTableColumn<T> {
  /** Unique key; used for sorting. */
  id: string
  header: ReactNode
  /** Value used for client-side sorting; falls back to the cell output. */
  accessor?: (row: T) => unknown
  /** Custom cell renderer. When omitted, the accessor value is rendered. */
  cell?: (row: T) => ReactNode
  /** Hide the sort affordance on this column. */
  enableSorting?: boolean
  /** Hide the per-column filter affordance on this column (default: on). */
  enableColumnFilter?: boolean
  /** Type-matched header filter control (default `'enum'`: exact-match dropdown). */
  filterType?: FilterType
  /** Default direction when this column becomes the active sort. */
  defaultSortDir?: SortDir
  align?: "left" | "center" | "right"
  className?: string
  headerClassName?: string
  /** Tailwind width class, e.g. "w-28" or "w-[320px]". */
  width?: string
  /** Hide this column's contents visually but keep it for screen readers? */
  srOnly?: boolean

  /* ── new: order + visibility (§4.1) ──────────────────────────── */
  /** Canonical slot (§3). When no column sets a slot the renderer falls
   * back to declaration order, so un-adopted call sites are unchanged. */
  slot?: ColumnSlot
  /** Default true; false pins the column (chooser renders it locked). */
  hideable?: boolean
  /** Hidden until the operator reveals it via the column chooser. */
  defaultHidden?: boolean

  /* ── new: sizing (§4.1) ──────────────────────────────────────── */
  /** px floor for drag-resize; default 64. */
  minWidth?: number
  /** px ceiling; default 640. */
  maxWidth?: number
  /** Default true. */
  resizable?: boolean

  /* ── new: pinning / sortability ──────────────────────────────── */
  /** Default: slot "select"/"identity" ⇒ left, slot "actions" ⇒ right. */
  sticky?: "left" | "right"
  /** Alias of `enableSorting`; the stricter value wins. */
  sortable?: boolean

  /* ── new: filtering + search ─────────────────────────────────── */
  /** Participates in the toolbar search box. */
  quickFilter?: boolean
  /** Alias of `quickFilter`. */
  searchable?: boolean
  /** Static enum options, superseding `ENUM_FALLBACKS[id]`. */
  filterOptions?: string[]

  /* ── new: presentation + export ──────────────────────────────── */
  /** Merged onto the `<td>`, not the `<th>`. */
  cellClass?: string
  /** Tooltip on the header label. */
  headerTitle?: string
  /** CSV cell value; defaults to the stringified accessor. */
  exportValue?: (row: T) => string | number | null
  /** CSV header; defaults to `String(header)`. */
  exportHeader?: string
}

export interface DataTableBulkAction {
  label: string
  icon?: LucideIcon
  variant?: "default" | "destructive" | "outline" | "secondary" | "ghost"
  onClick: (selected: Set<string | number>) => void
  disabled?: boolean
  className?: string
}

interface DataTableProps<T> {
  columns: DataTableColumn<T>[]
  data: T[]
  rowId: (row: T) => string | number
  loading?: boolean
  /** Epoch-ms anchor for the in-flight read, so the toolbar hint can show a
   * truthful elapsed figure. Optional; see `useElapsed`. */
  loadingStartedAt?: number
  /** Real download fraction, when the parent can supply one. A determinate
   * bar renders only when `total` is present; otherwise the hint shows an
   * indeterminate track and a plain count — never a fabricated percentage. */
  loadingProgress?: { loaded: number; total?: number }
  /** Noun for the progress line, e.g. "events" / "findings". Default "rows". */
  loadingNoun?: string
  /** What the toolbar hint announces it is waiting on. Default "Loading". */
  loadingLabel?: string
  /** Optional override for the first-load skeleton row count. Absent ⇒ the
   *  real `pageSize`, so a 50-row page does not advertise 8 rows. */
  skeletonRows?: number
  /** When true, a checkbox column + bulk action bar are rendered. */
  selectable?: boolean
  bulkActions?: DataTableBulkAction[]
  /** Disables selection toggles + bulk buttons (e.g. while a request runs). */
  busy?: boolean
  onSelectionChange?: (ids: Set<string | number>) => void
  /** Empty-state configuration (icon/title/description/action). */
  empty?: {
    icon: LucideIcon
    title: string
    description?: string
    action?: ReactNode
  } | null
  /* Controlled sorting (server-side mode). */
  sortBy?: SortKey | null
  sortDir?: SortDir
  onSortChange?: (key: SortKey, dir: SortDir) => void
  /* Uncontrolled (client-side) sorting defaults. */
  defaultSortBy?: SortKey | null
  defaultSortDir?: SortDir
  /** Per-column filter state (controlled from the parent); when absent the
   * component owns its own column filters internally. */
  columnFilters?: Record<string, ColumnFilterValue>
  onColumnFiltersChange?: (filters: Record<string, ColumnFilterValue>) => void
  /** Hide every per-column header filter across the table. */
  enableFiltering?: boolean
  /**
   * Full loaded dataset the enum filter options are derived from. Defaults
   * to the page `data` — pass the unpaginated rows for server-paginated
   * tables so the dropdown lists every loaded value, not just the page.
   */
  filterSourceData?: T[]
  onRowClick?: (row: T) => void
  /* Optional pagination slot rendered below the table. */
  page?: number
  pageSize?: number
  total?: number
  hasNext?: boolean
  onPageChange?: (page: number) => void
  /** When provided, a page-size selector is rendered next to the summary. */
  onPageSizeChange?: (size: number) => void
  /**
   * Client-side pagination: when true, `data` is the full dataset and the
   * component sorts + slices internally. Defaults to false (server mode,
   * where `data` is already the current page).
   */
  internalPagination?: boolean
  className?: string
  ariaLabel?: string

  /* ── new: capability flags (all opt-out, defaults preserve today) ─ */
  enableColumnVisibility?: boolean
  enableReorder?: boolean
  enableResize?: boolean
  enableExport?: boolean
  stickyHeader?: boolean
  enableContextMenu?: boolean
  enableQuickFilter?: boolean
  enableSavedViews?: boolean

  /* ── new: toolbar + surfaces ─────────────────────────────────── */
  density?: Density
  defaultDensity?: Density
  onDensityChange?: (density: Density) => void
  /** Left cluster, after the search box. */
  toolbar?: ReactNode
  /** Right cluster, before the built-in controls. */
  toolbarRight?: ReactNode
  /** Persistent filter row (page-provided). */
  filterBuilder?: ReactNode
  /** Persistence key — the ONLY switch that turns on persistence. */
  viewKey?: string
  /** Right-click menu items for a row. */
  rowMenu?: (row: T) => ContextMenuItem[]
  /** Side-panel body for the selected row. */
  rowDetail?: (row: T) => ReactNode
  /** Controlled panel open state. */
  rowDetailOpen?: boolean
  onRowDetailOpenChange?: (open: boolean) => void
  /** Double-click / Enter activation (defaults to opening the detail panel). */
  onRowActivate?: (row: T) => void
  /** Server-side full export. */
  onExport?: (scope: ExportScope) => Promise<ExportPayload | void>
  exportFilename?: string
  onRefresh?: () => void
  /** Controlled column state (opt-in; beats everything below it). */
  columnOrder?: string[]
  onColumnOrderChange?: (order: string[]) => void
  columnVisibility?: Record<string, boolean>
  onColumnVisibilityChange?: (visibility: Record<string, boolean>) => void
  columnWidths?: Record<string, number>
  onColumnWidthsChange?: (widths: Record<string, number>) => void
  /** Saved views (opt-in, `enableSavedViews`). */
  savedViews?: SavedView[]
  onSavedViewsChange?: (views: SavedView[]) => void
  activeViewId?: string | null
  onActiveViewChange?: (id: string | null) => void
}

function compareValues(a: unknown, b: unknown): number {
  if (a === b) return 0
  if (a === undefined || a === null || a === "") return 1
  if (b === undefined || b === null || b === "") return -1
  if (typeof a === "number" && typeof b === "number") return a - b
  return String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: "base" })
}
/**
 * Normalize an accessor result into comparable string values: nullish and
 * blank scalars yield no values; arrays flat-map to trimmed non-empty
 * strings; any other scalar stringifies to a single trimmed value.
 */
function accessorValues(v: unknown): string[] {
  if (v === null || v === undefined) return []
  if (Array.isArray(v)) {
    return v.flatMap((item) => {
      if (item === null || item === undefined) return []
      const s = String(item).trim()
      return s ? [s] : []
    })
  }
  const s = String(v).trim()
  return s ? [s] : []
}

/**
 * Static enum fallbacks keyed by column id, unioned after the dynamic values
 * so server-paginated tables still offer every known value. Retained as a
 * fallback for one release — `column.filterOptions` supersedes it (§4.1).
 */
const ENUM_FALLBACKS: Record<string, string[]> = {
  action: ["ALLOW", "DENY", "FLAG"],
  pattern_type: ["block", "whitelist"],
  coverage: ["Blacklist risk", "Whitelist", "Blacklist", "None"],
}

/** Grid cell padding, keyed by density (Canon §1.3). `TableSkeleton` in
 *  `ui.tsx` mirrors these exact values; changing one here MUST change the
 *  other, because the skeleton's whole job is to occupy the real grid's cells.
 *  Kept module-private (a plain `export` adds a `react(only-export-components)`
 *  warning to this file). */
const DENSITY_PAD: Record<Density, { th: string; td: string }> = {
  comfortable: { th: "px-4 py-3", td: "px-4 py-3" },
  compact: { th: "px-3 py-2", td: "px-3 py-1.5" },
}

/** Parse a Tailwind px width (`w-[320px]`) into a number, else undefined. */
function parsePxWidth(width: string | undefined): number | undefined {
  if (!width) return undefined
  const m = /(\d+)px/.exec(width)
  return m ? Number(m[1]) : undefined
}

function Checkbox({
  checked,
  indeterminate,
  disabled,
  onChange,
  label,
}: {
  checked: boolean
  indeterminate?: boolean
  disabled?: boolean
  onChange: () => void
  label: string
}) {
  return (
    <input
      type="checkbox"
      checked={checked}
      ref={(el) => {
        if (el) el.indeterminate = !!indeterminate
      }}
      onChange={onChange}
      disabled={disabled}
      aria-label={label}
      className="h-4 w-4 cursor-pointer border border-border bg-card text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
    />
  )
}

export function DataTable<T>({
  columns,
  data,
  rowId,
  loading = false,
  skeletonRows,
  loadingStartedAt,
  loadingProgress,
  loadingNoun = "rows",
  loadingLabel = "Loading",
  selectable = false,
  bulkActions = [],
  busy = false,
  onSelectionChange,
  empty,
  sortBy,
  sortDir,
  onSortChange,
  defaultSortBy = null,
  defaultSortDir = "asc",
  columnFilters: controlledFilters,
  onColumnFiltersChange,
  enableFiltering = true,
  filterSourceData,
  onRowClick,
  page,
  pageSize,
  total,
  hasNext,
  onPageChange,
  onPageSizeChange,
  internalPagination = false,
  className,
  ariaLabel = "Data table",
  enableColumnVisibility = true,
  enableReorder = true,
  enableResize = true,
  enableExport = true,
  stickyHeader = true,
  enableContextMenu = true,
  enableQuickFilter = false,
  // `enableSavedViews` is accepted for API compatibility; saved views ship in Step 12.
  density: controlledDensity,
  defaultDensity = "comfortable",
  onDensityChange,
  toolbar,
  toolbarRight,
  filterBuilder,
  viewKey,
  rowMenu,
  rowDetail,
  rowDetailOpen,
  onRowDetailOpenChange,
  onRowActivate,
  onExport,
  exportFilename,
  onRefresh,
  columnOrder: controlledOrder,
  onColumnOrderChange,
  columnVisibility: controlledVisibility,
  onColumnVisibilityChange,
  columnWidths: controlledWidths,
  onColumnWidthsChange,
  savedViews: _savedViews,
  onSavedViewsChange: _onSavedViewsChange,
  activeViewId: _activeViewId,
  onActiveViewChange: _onActiveViewChange,
}: DataTableProps<T>) {
  const { toast } = useToast()
  const controlled = !!onSortChange
  const [internalSort, setInternalSort] = useState<{ key: SortKey | null; dir: SortDir }>({
    key: defaultSortBy,
    dir: defaultSortDir,
  })
  const sortState = controlled
    ? { key: sortBy ?? null, dir: sortDir ?? "asc" }
    : internalSort
  const filtersControlled = controlledFilters !== undefined
  const [internalFilters, setInternalFilters] = useState<Record<string, ColumnFilterValue>>(() => persistedOf(viewKey, "filters") ?? {})
  const filters = filtersControlled ? controlledFilters : internalFilters
  const setFilter = (id: string, value: ColumnFilterValue) => {
    const next = { ...filters, [id]: value }
    if (!isActiveFilter(value)) delete next[id]
    if (filtersControlled) onColumnFiltersChange?.(next)
    else {
      setInternalFilters(next)
      writePersisted(viewKey, { filters: next })
    }
  }
  const setAllFilters = (next: Record<string, ColumnFilterValue>) => {
    if (filtersControlled) onColumnFiltersChange?.(next)
    else {
      setInternalFilters(next)
      writePersisted(viewKey, { filters: next })
    }
  }

  // ── D1 hazard guard (§4.5): internalPagination + total + onPageChange ──
  useEffect(() => {
    if (import.meta.env.DEV && internalPagination && total !== undefined && onPageChange) {
      console.warn(
        "[DataTable] `internalPagination` is set together with `total` and `onPageChange`. " +
          "The component will slice an already-server-paged array, so pages ≥ 2 render empty (defect D1). " +
          "Drop `internalPagination` when the parent owns pagination.",
      )
    }
  }, [internalPagination, total, onPageChange])

  // A changed column filter can shrink the result set below the current page —
  // jump back to page 0 so the table never lands on a now-empty page. Compare
  // by serialized key so parents re-creating the filters object every render
  // (uncontrolled or not) can't fire the reset spuriously.
  const hasPagination = onPageChange !== undefined && page !== undefined
  const filterKey = Object.keys(filters)
    .filter((k) => isActiveFilter(filters[k]))
    .sort()
    .map((k) => `${k}=${JSON.stringify(filters[k]).toLowerCase()}`)
    .join("|")
  useEffect(() => {
    if (!hasPagination || !page || !filterKey) return
    onPageChange(0)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filterKey])

  const [selected, setSelected] = useState<Set<string | number>>(new Set())
  const rowIdRef = useRef(rowId)
  rowIdRef.current = rowId

  // Drop selections for rows that are no longer in the current data set
  // (page change, refetch, filter…), so the bulk bar never counts ghosts.
  const ids = useMemo(() => data.map((r) => rowId(r)), [data, rowId])
  useEffect(() => {
    setSelected((prev) => {
      if (prev.size === 0) return prev
      const visible = new Set(ids)
      const next = new Set([...prev].filter((id) => visible.has(id)))
      return next.size === prev.size ? prev : next
    })
  }, [ids])

  useEffect(() => {
    onSelectionChange?.(selected)
  }, [selected, onSelectionChange])

  const allSelected = data.length > 0 && ids.every((id) => selected.has(id))
  const someSelected = selected.size > 0 && !allSelected

  const toggleSelectAll = () => {
    setSelected(allSelected ? new Set() : new Set(ids))
  }

  const toggleSelectOne = (id: string | number) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  /* ── Column engine (§3 slot grammar + §5.7 visibility/resize/order) ── */

  const slotOrdered = useMemo(() => orderBySlot(columns), [columns])

  const defaults: ColumnStateDefaults = useMemo(() => {
    const defaultVisibility: Record<string, boolean> = {}
    const defaultWidths: Record<string, number> = {}
    const pinned: string[] = []
    const reorderable: string[] = []
    for (const col of slotOrdered) {
      const displayable = !col.srOnly
      if (col.defaultHidden) defaultVisibility[col.id] = false
      if (displayable) {
        if (col.hideable === false) pinned.push(col.id)
        if (col.hideable !== false && col.slot !== "actions") reorderable.push(col.id)
      }
      const px = parsePxWidth(col.width)
      if (px !== undefined) defaultWidths[col.id] = px
    }
    return { ids: slotOrdered.map((c) => c.id), pinned, defaultVisibility, defaultWidths, reorderable }
  }, [slotOrdered])

  const columnState = useColumnState({
    viewKey,
    defaults,
    order: controlledOrder,
    onOrderChange: onColumnOrderChange,
    visibility: controlledVisibility,
    onVisibilityChange: onColumnVisibilityChange,
    widths: controlledWidths,
    onWidthsChange: onColumnWidthsChange,
    density: controlledDensity,
    defaultDensity,
    onDensityChange,
    enableVisibility: enableColumnVisibility,
    enableReorder,
    enableResize,
  })
  const density = columnState.density

  const orderIndex = useMemo(() => {
    const m = new Map<string, number>()
    columnState.state.order.forEach((id, i) => m.set(id, i))
    return m
  }, [columnState.state.order])

  const orderedColumns = useMemo(() => {
    return [...slotOrdered].sort(
      (a, b) => (orderIndex.get(a.id) ?? Number.MAX_SAFE_INTEGER) - (orderIndex.get(b.id) ?? Number.MAX_SAFE_INTEGER),
    )
  }, [slotOrdered, orderIndex])

  const visibleColumns = useMemo(() => {
    return orderedColumns.filter((col) => {
      if (col.srOnly) return true
      return columnState.state.visibility[col.id] ?? !col.defaultHidden
    })
  }, [orderedColumns, columnState.state.visibility])

  /* ── Quick filter (§5a) ───────────────────────────────────────── */
  const [quickQuery, setQuickQuery] = useState<string>(() => persistedOf(viewKey, "quickFilter") ?? "")
  const [debouncedQuery, setDebouncedQuery] = useState(quickQuery)
  useEffect(() => {
    const id = window.setTimeout(() => setDebouncedQuery(quickQuery), 250)
    return () => window.clearTimeout(id)
  }, [quickQuery])

  const quickColumns = useMemo(
    () => visibleColumns.filter((c) => c.quickFilter || c.searchable),
    [visibleColumns],
  )

  /* ── Sorting ───────────────────────────────────────────────────── */

  const handleSort = (col: DataTableColumn<T>) => {
    const key = col.id
    let dir: SortDir
    if (sortState.key === key) {
      dir = sortState.dir === "asc" ? "desc" : "asc"
    } else {
      dir = col.defaultSortDir ?? "desc"
    }
    if (controlled) onSortChange(key, dir)
    else {
      setInternalSort({ key, dir })
      writePersisted(viewKey, { sort: { key, dir } })
    }
  }

  const sortKey = sortState.key
  const sortDirState = sortState.dir

  // Read the active sort column through a ref so a fresh-but-equal `columns`
  // array (recreated on every parent render) can never re-trigger the sort
  // memo. The memo re-runs only when the sort key actually changes.
  const columnsRef = useRef(columns)
  columnsRef.current = columns
  const sortColumn = useMemo(
    () => columnsRef.current.find((c) => c.id === sortKey) ?? null,
    [sortKey],
  )

  // ── Per-column filtering (runs before sorting) ─────────────────────
  // The control is picked per column by `filterType` (default `enum`):
  // enum = exact match (or tri-state Include/NOT), text = case-insensitive
  // substring, datetime/number = open-ended range match. NOTE: filterability
  // is intentionally decoupled from sortability — a column opts out of
  // filtering with srOnly or enableColumnFilter={false}.
  const filterMatches = (row: T, filters: Record<string, ColumnFilterValue>): boolean => {
    const ids = Object.keys(filters)
    if (ids.length === 0) return true
    return ids.every((id) => {
      const want = filters[id]
      if (!isActiveFilter(want)) return true
      const col = columnsRef.current.find((c) => c.id === id)
      if (!col) return true
      const type = col.filterType ?? "enum"
      const raw = col.accessor ? col.accessor(row) : renderCellValue(col, row)
      if (typeof want === "string") {
        const needle = want.trim().toLowerCase()
        if (!needle) return true
        const values = accessorValues(raw)
        if (type === "text") return values.some((hay) => hay.toLowerCase().includes(needle))
        return values.some((hay) => hay.toLowerCase() === needle)
      }
      if (isEnumFilter(want)) {
        const values = accessorValues(raw).map((v) => v.toLowerCase())
        if (want.include.length > 0) {
          const inc = want.include.map((v) => v.toLowerCase())
          if (!values.some((v) => inc.includes(v))) return false
        }
        if (want.exclude.length > 0) {
          const exc = want.exclude.map((v) => v.toLowerCase())
          if (values.some((v) => exc.includes(v))) return false
        }
        return true
      }
      if (isDatetimeFilter(want)) {
        if (Array.isArray(raw)) return false
        const values = accessorValues(raw)
        if (values.length === 0) return false
        const ts = Date.parse(values[0])
        if (Number.isNaN(ts)) return false
        const fromEmpty = want.from.trim() === ""
        const toEmpty = want.to.trim() === ""
        if (!fromEmpty) {
          const fromMs = Date.parse(want.from)
          if (Number.isNaN(fromMs) || ts < fromMs) return false
        }
        if (!toEmpty) {
          const toMs = Date.parse(want.to)
          if (Number.isNaN(toMs) || ts > toMs) return false
        }
        return true
      }
      if (isNumberFilter(want)) {
        if (Array.isArray(raw)) return false
        const values = accessorValues(raw)
        if (values.length === 0) return false
        const n = Number(values[0])
        if (Number.isNaN(n)) return false
        const minEmpty = want.min.trim() === ""
        const maxEmpty = want.max.trim() === ""
        if (!minEmpty) {
          const min = Number(want.min)
          if (Number.isNaN(min) || n < min) return false
        }
        if (!maxEmpty) {
          const max = Number(want.max)
          if (Number.isNaN(max) || n > max) return false
        }
        return true
      }
      return true
    })
  }

  const filteredData = useMemo(() => {
    const f = filtersControlled ? controlledFilters : internalFilters
    if (!f || Object.keys(f ?? {}).length === 0) return data
    return data.filter((r) => filterMatches(r, f ?? {}))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, controlledFilters, internalFilters, filtersControlled, columns])

  const quickFilteredData = useMemo(() => {
    const needle = debouncedQuery.trim().toLowerCase()
    if (!needle || quickColumns.length === 0) return filteredData
    return filteredData.filter((row) =>
      quickColumns.some((col) =>
        accessorValues(col.accessor ? col.accessor(row) : renderCellValue(col, row)).some((v) =>
          v.toLowerCase().includes(needle),
        ),
      ),
    )
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filteredData, debouncedQuery, quickColumns])

  const quickFilteredRef = useRef(quickFilteredData)
  quickFilteredRef.current = quickFilteredData

  // Distinct values per enum-filterable column over `filterSourceData` (or
  // the current `data` when absent), for the dropdown options. Built once
  // per source/filter-column set; normalized accessor values are
  // de-duplicated case-insensitively, then static ENUM_FALLBACKS are
  // unioned after the dynamic values (dynamic-first).
  const filterOptions = useMemo(() => {
    const source = filterSourceData ?? data
    const map = new Map<string, { value: string; label: string }[]>()
    for (const col of columnsRef.current) {
      if (col.srOnly || col.enableColumnFilter === false) continue
      if ((col.filterType ?? "enum") !== "enum") continue
      const seen = new Map<string, string>()
      for (const row of source) {
        const v = col.accessor ? col.accessor(row) : renderCellValue(col, row)
        for (const s of accessorValues(v)) {
          const key = s.toLowerCase()
          if (!seen.has(key)) seen.set(key, s)
        }
      }
      for (const fb of col.filterOptions ?? ENUM_FALLBACKS[col.id] ?? []) {
        const key = fb.toLowerCase()
        if (!seen.has(key)) seen.set(key, fb)
      }
      map.set(
        col.id,
        [...seen.values()].map((v) => ({ value: v, label: v })),
      )
    }
    return map
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, filterSourceData, columns])

  const sortedData = useMemo(() => {
    const base = quickFilteredData
    if (controlled || !sortKey || !sortColumn) return base
    const dir = sortDirState === "asc" ? 1 : -1
    return [...base].sort((a, b) => {
      const av = sortColumn.accessor ? sortColumn.accessor(a) : renderCellValue(sortColumn, a)
      const bv = sortColumn.accessor ? sortColumn.accessor(b) : renderCellValue(sortColumn, b)
      return compareValues(av, bv) * dir
    })
  }, [quickFilteredData, sortKey, sortDirState, controlled, sortColumn])

  const alignClass = (align?: "left" | "center" | "right") =>
    align === "center" ? "text-center" : align === "right" ? "text-right" : "text-left"

  const renderCell = (col: DataTableColumn<T>, row: T) =>
    col.cell ? col.cell(row) : renderCellValue(col, row)

  // In client mode the component owns sorting + slicing; in server mode the
  // parent already passes exactly the rows for this page.
  const displayData = useMemo(() => {
    if (!internalPagination || !hasPagination) return sortedData
    const size = pageSize ?? 25
    return sortedData.slice(page! * size, (page! + 1) * size)
  }, [internalPagination, hasPagination, sortedData, page, pageSize])

  // Honest total: internal-pagination tables report the post-filter count;
  // server-mode tables keep the parent's server-provided total.
  const paginationTotal = internalPagination ? sortedData.length : total

  /* ── Row detail panel (§5.6) ───────────────────────────────────── */
  const detailControlled = rowDetailOpen !== undefined
  const [detailRowId, setDetailRowId] = useState<string | number | null>(() => persistedOf(viewKey, "openRow") ?? null)
  // Re-open the panel for a row restored from persistence (§5.6 stores the
  // open row id under `unetwatch_table_<viewKey>_openRow`).
  const [internalDetailOpen, setInternalDetailOpen] = useState(() => persistedOf(viewKey, "openRow") !== null)
  const detailOpen = detailControlled ? rowDetailOpen! : internalDetailOpen
  const setDetailOpen = useCallback(
    (open: boolean) => {
      if (detailControlled) onRowDetailOpenChange?.(open)
      else setInternalDetailOpen(open)
      writePersisted(viewKey, { openRow: open ? detailRowId : null })
    },
    [detailControlled, onRowDetailOpenChange, detailRowId, viewKey],
  )
  const activateRow = useCallback(
    (row: T) => {
      onRowActivate?.(row)
      if (rowDetail) {
        setDetailRowId(rowId(row))
        if (detailControlled) onRowDetailOpenChange?.(true)
        else setInternalDetailOpen(true)
      } else onRowClick?.(row)
    },
    [onRowActivate, rowDetail, detailControlled, onRowDetailOpenChange, onRowClick, rowId],
  )
  const detailRow = useMemo(() => {
    if (detailRowId === null) return null
    return data.find((r) => rowId(r) === detailRowId) ?? null
  }, [data, detailRowId, rowId])

  /* ── Context menu (§5.5) ──────────────────────────────────────── */
  const [menu, setMenu] = useState<{ x: number; y: number; row: T } | null>(null)
  // §4.2: enableContextMenu defaults true *when a rowMenu is given* — with no
  // rowMenu there is no command list, so the native browser menu is left alone
  // (this keeps every existing call site unaffected).
  const contextEnabled = enableContextMenu && !!rowMenu
  const openContextMenu = (e: React.MouseEvent, row: T) => {
    if (!contextEnabled) return
    e.preventDefault()
    setMenu({ x: e.clientX, y: e.clientY, row })
  }
  const menuItems: ContextMenuItem[] = useMemo(
    () => (menu && rowMenu ? rowMenu(menu.row) : []),
    [menu, rowMenu],
  )

  /* ── Export (§5.9) ────────────────────────────────────────────── */
  const [exportBusy, setExportBusy] = useState(false)
  const exportColumns = useMemo(
    // The actions slot is the structural command column (§3.1 slot 7): its
    // header is an sr-only ReactNode and its cell is a menu, so it must never
    // reach the CSV (it would serialize as "[object Object]"). Exclude by
    // slot, not only by `srOnly`, because no page sets `srOnly` on it.
    () => visibleColumns.filter((c) => !c.srOnly && c.slot !== "actions"),
    [visibleColumns],
  )
  const runExport = async (scope: ExportScope) => {
    setExportBusy(true)
    try {
      const filename = defaultExportFilename(viewKey, ariaLabel, exportFilename)
      if (scope === "server-all" && onExport) {
        const payload = await onExport(scope)
        if (payload) downloadCsv(filename, payloadToCsv(payload))
        else return
      } else {
        const source = scope === "view" ? displayData : sortedData
        const header = exportColumns.map((c) => exportHeaderOf(c as DataTableColumn<unknown>))
        const rows = source.map((row) =>
          exportColumns.map((c) => cellExportValue(c, row)),
        )
        downloadCsv(filename, toCsv(header, rows))
      }
      toast({ title: "Export ready", description: filename, variant: "success" })
    } catch {
      toast({ title: "Export failed", variant: "error" })
    } finally {
      setExportBusy(false)
    }
  }

  /* ── Chips (§5.2) ─────────────────────────────────────────────── */
  const chips: FilterChipModel[] = useMemo(() => {
    const out: FilterChipModel[] = []
    for (const col of orderedColumns) {
      const value = filters[col.id]
      if (!isActiveFilter(value)) continue
      const { text, negated } = summarizeFilter(value, col.filterType ?? "enum")
      out.push({
        id: col.id,
        label: String(col.header),
        onOpen: () => setChipOpenId(col.id),
        summary: text,
        negated,
        onClear: () => setFilter(col.id, emptyFilterFor(col.filterType ?? "enum")),
      })
    }
    return out
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orderedColumns, filters])

  const [chipOpenId, setChipOpenId] = useState<string | null>(null)
  const chipAnchors = useRef(new Map<string, HTMLElement>())
  const chipCol = chipOpenId ? visibleColumns.find((c) => c.id === chipOpenId) ?? null : null
  const resetView = () => {
    columnState.reset()
    setAllFilters({})
    setQuickQuery("")
    if (!controlled) setInternalSort({ key: defaultSortBy, dir: defaultSortDir })
    clearPersisted(viewKey)
    toast({ title: "View reset", variant: "default" })
  }

  /* ── Sticky-header scroll shadow (§6.1) ───────────────────────── */
  const scrollRef = useRef<HTMLDivElement>(null)
  const [scrolledX, setScrolledX] = useState(false)
  useLayoutEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const onScroll = () => {
      setScrolledX(el.scrollLeft > 0)
    }
    onScroll()
    el.addEventListener("scroll", onScroll, { passive: true })
    return () => el.removeEventListener("scroll", onScroll)
  }, [])

  const showColumnChooser = enableColumnVisibility && visibleColumns.filter((c) => !c.srOnly).length > 3
  const pad = DENSITY_PAD[density]
  const anyTagged = useMemo(() => columns.some((c) => c.slot !== undefined), [columns])
  const colSpan = visibleColumns.length + (selectable ? 1 : 0)

  /* ── Loading treatment ──────────────────────────────────────────────
   * A REFETCH while rows already exist must not blow the rows away: keeping
   * the last good data on screen is the single biggest perceived-performance
   * win here. We mark the region aria-busy, dim it quietly, and surface the
   * toolbar hint. Full skeleton rows are reserved for the genuinely-empty
   * first load (`data.length === 0`), where there is nothing to keep. */
  const showToolbarHint = useDelayedVisible(loading, {
    delayMs: LOADER_DELAY_MS,
    minVisibleMs: LOADER_MIN_VISIBLE_MS,
  })
  const { elapsed } = useElapsed(loading, loadingStartedAt)
  const dimInFlight = loading && !showToolbarHint
  // The dim is a quiet, opacity-only fade — never a blur or a colour change.
  const inFlightClass = loading && data.length > 0 ? (dimInFlight ? "opacity-60" : "opacity-50") : ""

  return (
    <div className={className}>
      {/* Toolbar (§5a) — always rendered so density is always available. */}
      <Toolbar
        aria-label="Table controls"
        className="mb-2"
        left={
          <>
        {enableQuickFilter && (
          <input
            type="search"
            value={quickQuery}
            onChange={(e) => {
              setQuickQuery(e.target.value)
              writePersisted(viewKey, { quickFilter: e.target.value })
            }}
            placeholder="Search"
            aria-label="Search table"
            className="h-8 w-52 rounded border border-border bg-card px-2.5 text-sm text-foreground placeholder:text-muted-foreground/60 focus:border-ring focus:outline-none focus:ring-1 focus:ring-ring"
          />
        )}
        {toolbar}
        <FilterChips
          chips={chips}
          onClearAll={() => setAllFilters({})}
          onChipRef={(id, el) => {
            if (el) chipAnchors.current.set(id, el)
            else chipAnchors.current.delete(id)
          }}
        />
        {/* Toolbar-level progress hint — the shared, honest "still working"
            surface. Anti-flickered, and shown only once a read is actually
            slow enough to warrant it. aria-live is NOT used here: the
            DataTable's own aria-busy on the region is the announcement. */}
        {showToolbarHint && (
          <span className="animate-in inline-flex items-center gap-2 text-xs text-muted-foreground">
            <span className="font-mono text-[11px] tabular-nums" aria-hidden="true">
              {elapsed}
            </span>
            <ProgressHint progress={loadingProgress} noun={loadingNoun} />
            <span className="sr-only">{loadingLabel}</span>
          </span>
        )}
          </>
        }
        right={
          <>
          {toolbarRight}
          {onRefresh && (
            <Button
              variant="outline"
              size="sm"
              // Fixed label + min-width (sized for the longest label): the box
              // is identical in both states, so the spinner swaps in without
              // resizing the button and shoving the right cluster — the row is
              // `flex-wrap`, so a wider button can also re-wrap it.
              className="h-8 min-w-[104px] gap-1.5 px-2.5"
              disabled={loading}
              onClick={onRefresh}
              aria-label={loading ? "Refreshing" : "Refresh"}
              aria-busy={loading || undefined}
            >
              {/* The spin is a CSS animation, so index.css:170 (data-paused) and
                  index.css:173 (prefers-reduced-motion) already cover it. The
                  elapsed figure in the toolbar hint carries the information
                  for a reduced-motion user. */}
              <RotateCcw
                className={cn("h-3.5 w-3.5", loading && "animate-spin")}
                aria-hidden="true"
              />
              <span className="hidden sm:inline">Refresh</span>
            </Button>
          )}
          <DensityToggle density={density} onChange={columnState.setDensity} />
          {showColumnChooser && (
            <ColumnChooser
              rows={orderedColumns
                .filter((c) => !c.srOnly)
                .map((c) => ({
                  col: c,
                  slot: c.slot,
                  hideable: c.hideable !== false,
                  reorderable: enableReorder && c.hideable !== false && c.slot !== "actions",
                  visible: columnState.state.visibility[c.id] ?? !c.defaultHidden,
                }))}
              onToggle={columnState.setVisibility}
              onReorder={columnState.setOrder}
              onReset={columnState.reset}
            />
          )}
          {enableExport && (
            <ExportMenu
              disabled={loading || busy || exportBusy}
              count={displayData.length}
              loadedCount={sortedData.length}
              serverAvailable={!!onExport}
              onExport={runExport}
            />
          )}
          {(columnState.isDirty || chips.length > 0 || quickQuery !== "") && (
            <Button
              variant="outline"
              size="sm"
              className="h-8 gap-1.5 px-2.5"
              onClick={resetView}
              aria-label="Reset view"
            >
              <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />
              <span className="hidden sm:inline">Reset</span>
            </Button>
        )}
          </>
        }
      />

      {filterBuilder && <div className="mb-2">{filterBuilder}</div>}

      {/* Bulk action bar (animate in/out) */}
      <AnimatePresence>
        {selectable && selected.size > 0 && (
          <motion.div
            key="bulk-bar"
            initial={{ opacity: 0, y: -6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -6 }}
            transition={{ duration: 0.18, ease: EASE }}
            className="mb-3 flex flex-wrap items-center gap-2 rounded-md border border-border bg-card px-3 py-2 text-xs font-medium text-foreground shadow-sm"
            role="toolbar"
            aria-label="Bulk actions"
          >
            <span className="tabular-nums">{selected.size} selected</span>
            <span className="h-4 w-px bg-border" aria-hidden="true" />
            {bulkActions.map((action) => {
              const Icon = action.icon
              return (
                <Button
                  key={action.label}
                  size="sm"
                  variant={action.variant ?? "outline"}
                  onClick={() => action.onClick(new Set(selected))}
                  disabled={action.disabled || busy}
                  className={action.className}
                >
                  {Icon && <Icon className="h-3.5 w-3.5" aria-hidden="true" />}
                  {action.label}
                </Button>
              )
            })}
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setSelected(new Set())}
              className="ml-auto"
            >
              <X className="h-3.5 w-3.5" aria-hidden="true" />
              Clear
            </Button>
          </motion.div>
        )}
      </AnimatePresence>

      {/* `aria-busy` + a quiet opacity fade while a REFETCH is in flight
          (rows still present). Opacity only — no blur, no layout shift. When
          there is no data yet the fade is skipped and skeleton rows take
          over below instead. Never `backdrop-blur` a scrolling container. */}
      <div
        ref={scrollRef}
        aria-busy={loading || undefined}
        className={cn(
          "overflow-x-auto rounded-md border border-border bg-card shadow-none transition-opacity duration-200",
          inFlightClass,
        )}
      >
        <table className="w-full text-sm" aria-label={ariaLabel}>
          <thead>
            <tr className="border-b border-border bg-muted/50 text-muted-foreground">
              {selectable && (
                <th
                  scope="col"
                  className={cn(
                    pad.th,
                    "w-12 text-left font-medium text-muted-foreground",
                    stickyHeader && "sticky top-0 z-20 bg-card",
                  )}
                >
                  <Checkbox
                    checked={allSelected}
                    indeterminate={someSelected}
                    disabled={busy || data.length === 0}
                    onChange={toggleSelectAll}
                    label="Select all rows"
                  />
                </th>
              )}
              {visibleColumns.map((col) => {
                const sortable = col.enableSorting !== false && col.sortable !== false && !col.srOnly
                const active = sortable && sortState.key === col.id
                const filterable = enableFiltering && !col.srOnly && col.enableColumnFilter !== false
                const stickySide = resolveSticky(col, anyTagged)
                const widthPx = columnState.state.widths[col.id] ?? defaults.defaultWidths[col.id]
                return (
                  <th
                    key={col.id}
                    scope="col"
                    title={col.headerTitle}
                    style={widthPx ? { width: widthPx, minWidth: col.minWidth ?? 64 } : undefined}
                    className={cn(
                      pad.th,
                      "font-medium text-muted-foreground",
                      alignClass(col.align),
                      col.width,
                      col.headerClassName,
                      // A header cell can stick in both axes at once; a
                      // sticky-pinned column keeps the higher header z-index
                      // so it paints above the body's sticky cells.
                      (stickyHeader || stickySide) && "sticky bg-card",
                      stickyHeader && "top-0",
                      stickyHeader && (stickySide ? "z-30" : "z-20"),
                      stickySide === "left" && "left-0",
                      stickySide === "right" && "right-0",
                      stickySide && !stickyHeader && "z-10",
                      stickySide === "left" && scrolledX && "border-r border-border",
                    )}
                    aria-sort={active ? (sortState.dir === "asc" ? "ascending" : "descending") : undefined}
                  >
                    <HeaderCell
                      col={col}
                      sortable={sortable}
                      active={active}
                      sortDir={sortState.dir}
                      onSort={() => handleSort(col)}
                      filterable={filterable}
                      filterValue={filters[col.id]}
                      onFilterApply={(v) => setFilter(col.id, v)}
                      filterOptions={filterOptions.get(col.id) ?? []}
                      showHandle={enableReorder && col.hideable !== false && col.slot !== "actions"}
                      onReorder={(from, to) => reorderColumns(from, to, columnState.state.order, columnState.setOrder)}
                      resizable={enableResize && (col.resizable ?? true) && !col.srOnly}
                      currentWidth={widthPx}
                      minWidth={col.minWidth ?? 64}
                      maxWidth={col.maxWidth ?? 640}
                      onResize={(w) => columnState.setWidth(col.id, w)}
                      onResetWidth={() => columnState.clearWidth(col.id)}
                    />
                  </th>
                )
              })}
            </tr>
          </thead>
          {/* Skeleton only when there is genuinely nothing to keep. A refetch
              over existing rows falls through to the live rows below, which
              the region above dims via `aria-busy` + opacity.

              The rows are emitted as a real `<tbody>` of this table — NOT
              via `TableSkeleton`, whose fixed wrapper (`<div><table>`) cannot
              legally sit inside the `<table>` opened above. Nesting it there
              makes the browser foster-parent the wrapper out of the table, so
              the skeleton detaches and paints ABOVE the real header. The row
              markup itself is still the one `TableSkeleton` defines; see
              `SkeletonRows` at the foot of this file. */}
          {loading && data.length === 0 ? (
            <tbody>
              <SkeletonRows
                rows={skeletonRows ?? pageSize ?? 25}
                columns={visibleColumns.map((c) => ({ width: c.width }))}
                selectable={selectable}
                td={pad.td}
              />
            </tbody>
          ) : data.length === 0 ? (
            <tbody>
              <tr>
                <td colSpan={colSpan}>
                  {empty ? (
                    <EmptyState
                      icon={empty.icon}
                      title={empty.title}
                      description={empty.description}
                      action={empty.action}
                      className="border-0"
                    />
                  ) : (
                    <EmptyState
                      icon={ArrowUpDown}
                      title="No rows"
                      className="border-0"
                    />
                  )}
                </td>
              </tr>
            </tbody>
          ) : (
            // Stagger the rows only while the table is small enough for the
            // entrance to read as an enhancement; `Stagger` owns the cap
            // (`STAGGER_MAX_ITEMS`) and, past it, renders a plain <tbody> with
            // identical classes, so the DOM — `cv-auto` row paint containment
            // included — does not change with the row count.
            <Stagger as="tbody" count={displayData.length}>
              {displayData.map((row) => {
                const id = rowId(row)
                const isSelected = selected.has(id)
                return (
                  <StaggerItem
                    as="tr"
                    key={id}
                    className={cn(
                      "border-b border-border transition-colors cv-auto",
                      isSelected ? "bg-primary/[0.04] hover:bg-primary/[0.06]" : "hover:bg-muted/50",
                      (onRowClick || rowDetail || onRowActivate) && "cursor-pointer",
                    )}
                    onClick={
                      onRowClick || rowDetail
                        ? () => {
                            if (rowDetail) activateRow(row)
                            else onRowClick?.(row)
                          }
                        : undefined
                    }
                    onDoubleClick={rowDetail ? () => activateRow(row) : undefined}
                    onContextMenu={contextEnabled ? (e) => openContextMenu(e, row) : undefined}
                  >
                    {selectable && (
                      <td className={pad.td} onClick={(e) => e.stopPropagation()}>
                        <Checkbox
                          checked={isSelected}
                          disabled={busy}
                          onChange={() => toggleSelectOne(id)}
                          label={`Select row ${id}`}
                        />
                      </td>
                    )}
                    {visibleColumns.map((col) => {
                      const stickySide = resolveSticky(col, anyTagged)
                      return (
                        <td
                          key={col.id}
                          className={cn(
                            pad.td,
                            alignClass(col.align),
                            col.align === "right" && "tabular-nums",
                            col.className,
                            col.cellClass,
                            stickySide && "bg-card",
                            stickySide === "left" && "sticky left-0 z-10",
                            stickySide === "left" && scrolledX && "border-r border-border",
                            stickySide === "right" && "sticky right-0 z-10",
                          )}
                        >
                          {col.srOnly ? <span className="sr-only">{renderCell(col, row)}</span> : renderCell(col, row)}
                        </td>
                      )
                    })}
                  </StaggerItem>
                )
              })}
            </Stagger>
          )}
        </table>
      </div>

      {hasPagination && (
        <Pagination
          page={page}
          pageSize={pageSize ?? 25}
          total={paginationTotal}
          hasNext={hasNext}
          onPageChange={onPageChange}
          onPageSizeChange={onPageSizeChange}
          className="mt-3"
        />
      )}

      {/* Row context menu (§5.5) */}
      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          items={menuItems}
          onClose={() => setMenu(null)}
        />
      )}

      {/* Chip-anchored filter popover (§5a) */}
      {chipCol && chipAnchors.current.get(chipCol.id) && (
        <PopoverPrimitive.Root open onOpenChange={(o) => !o && setChipOpenId(null)}>
          <PopoverPrimitive.Anchor virtualRef={{ current: chipAnchors.current.get(chipCol.id)! }} />
          <PopoverPrimitive.Portal>
            <PopoverPrimitive.Content
              align="start"
              sideOffset={4}
              aria-label={`Filter by ${String(chipCol.header)}`}
              className="z-[70] w-64 rounded-md border border-border bg-card p-3 shadow-md data-[state=open]:animate-in"
            >
              <FilterEditor
                col={chipCol}
                value={filters[chipCol.id]}
                onApply={(v) => {
                  setFilter(chipCol.id, v)
                  setChipOpenId(null)
                }}
                options={withCurrentOption(filterOptions.get(chipCol.id) ?? [], filters[chipCol.id])}
              />
            </PopoverPrimitive.Content>
          </PopoverPrimitive.Portal>
        </PopoverPrimitive.Root>
      )}

      {/* Row detail panel (§5.6) */}
      {rowDetail && detailRow && (
        <RowDetailPanel
          open={detailOpen}
          onOpenChange={setDetailOpen}
          title={String(detailRowId ?? "")}
          copyValue={JSON.stringify(detailRow, null, 2)}
          items={rowMenu?.(detailRow)}
          width={readPersisted(viewKey).panelWidth ?? 440}
          onWidthChange={(w) => writePersisted(viewKey, { panelWidth: w })}
        >
          {rowDetail(detailRow)}
        </RowDetailPanel>
      )}
    </div>
  )
}

/* ── Header cell (sort button + filter + resize + reorder) ─────── */

function HeaderCell<T>({
  col,
  sortable,
  active,
  sortDir,
  onSort,
  filterable,
  filterValue,
  onFilterApply,
  filterOptions,
  showHandle,
  onReorder,
  resizable,
  currentWidth,
  minWidth,
  maxWidth,
  onResize,
  onResetWidth,
}: {
  col: DataTableColumn<T>
  sortable: boolean
  active: boolean
  sortDir: SortDir
  onSort: () => void
  filterable: boolean
  filterValue: ColumnFilterValue | undefined
  onFilterApply: (value: ColumnFilterValue) => void
  filterOptions: { value: string; label: string }[]
  showHandle: boolean
  onReorder: (from: string, to: string) => void
  resizable: boolean
  currentWidth?: number
  minWidth: number
  maxWidth: number
  onResize: (width: number) => void
  onResetWidth: () => void
}) {
  const dragRef = useRef<{ startX: number; startWidth: number } | null>(null)
  const [dragging, setDragging] = useState(false)

  useEffect(() => {
    if (!dragging) return
    const onMove = (e: PointerEvent) => {
      const d = dragRef.current
      if (!d) return
      const next = Math.min(maxWidth, Math.max(minWidth, d.startWidth + (e.clientX - d.startX)))
      onResize(Math.round(next))
    }
    const onUp = () => {
      dragRef.current = null
      setDragging(false)
    }
    document.addEventListener("pointermove", onMove)
    document.addEventListener("pointerup", onUp)
    return () => {
      document.removeEventListener("pointermove", onMove)
      document.removeEventListener("pointerup", onUp)
    }
  }, [dragging, minWidth, maxWidth, onResize])

  const label = String(col.header)

  return (
    <span className="flex min-w-0 items-center gap-1">
      {showHandle && (
        <span
          draggable
          onDragStart={(e) => e.dataTransfer.setData("text/dt-col", col.id)}
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => {
            const from = e.dataTransfer.getData("text/dt-col")
            if (from) onReorder(from, col.id)
          }}
          className="cursor-grab text-muted-foreground/40 hover:text-muted-foreground"
          aria-hidden="true"
        >
          <GripVertical className="h-3.5 w-3.5" />
        </span>
      )}
      <span
        className={cn(
          "inline-flex min-w-0 items-center gap-1",
          col.align === "right" && "flex-row-reverse",
          col.align === "center" && "justify-center",
        )}
      >
        {sortable ? (
          <button
            type="button"
            onClick={onSort}
            title={col.headerTitle}
            className={cn(
              "inline-flex cursor-pointer items-center gap-1 mono-label transition-colors hover:text-foreground",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background rounded-sm",
            )}
            aria-label={`Sort by ${label}${active ? `, currently ${sortDir}ending` : ""}`}
          >
            <span className="min-w-0 truncate">{col.header}</span>
            {active ? (
              sortDir === "asc" ? (
                <ArrowUp className="h-3 w-3 opacity-100" aria-hidden="true" />
              ) : (
                <ArrowDown className="h-3 w-3 opacity-100" aria-hidden="true" />
              )
            ) : (
              <ArrowUpDown className="h-3 w-3 opacity-30" aria-hidden="true" />
            )}
          </button>
        ) : (
          <span className={cn("inline-flex min-w-0 items-center gap-1 mono-label", col.align === "right" && "flex-row-reverse", col.align === "center" && "justify-center")}>
            <span className="min-w-0 truncate">{col.header}</span>
          </span>
        )}
        {filterable && (
          <FilterBuilder
            col={col}
            value={filterValue}
            onApply={onFilterApply}
            options={withCurrentOption(filterOptions, filterValue)}
          />
        )}
      </span>
      {resizable && (
        <span
          role="separator"
          aria-orientation="vertical"
          aria-label={`Resize ${label} column`}
          onPointerDown={(e) => {
            dragRef.current = { startX: e.clientX, startWidth: currentWidth ?? e.currentTarget.parentElement?.parentElement?.getBoundingClientRect().width ?? minWidth }
            setDragging(true)
          }}
          onDoubleClick={onResetWidth}
          className={cn(
            "ml-auto h-full w-2 shrink-0 cursor-col-resize touch-none",
            dragging ? "bg-primary/40" : "hover:bg-border",
          )}
        />
      )}
    </span>
  )
}

/** The currently-applied scalar filter may not be in the derived options
 * (e.g. it came from a stale page) — append it so the popover can show it. */
function withCurrentOption(
  options: { value: string; label: string }[],
  value: ColumnFilterValue | undefined,
): { value: string; label: string }[] {
  if (typeof value !== "string" || !value) return options
  return options.some((o) => o.value === value) ? options : [...options, { value, label: value }]
}

/** Sticky side for a column: explicit `sticky` wins, else derived from the
 * slot (identity/select ⇒ left, actions ⇒ right) — but only once the table
 * has adopted the grammar, so un-tagged tables stay fully static. */
function resolveSticky<T>(col: DataTableColumn<T>, anyTagged: boolean): "left" | "right" | undefined {
  if (col.sticky) return col.sticky
  if (!anyTagged) return undefined
  if (col.slot === "identity" || col.slot === "select") return "left"
  if (col.slot === "actions") return "right"
  return undefined
}

/** Move `from` immediately before `to` in the operator-authored order. */
function reorderColumns(
  from: string,
  to: string,
  order: string[],
  setOrder: (order: string[]) => void,
): void {
  if (from === to) return
  const next = order.filter((id) => id !== from)
  const idx = next.indexOf(to)
  if (idx === -1) next.push(from)
  else next.splice(idx, 0, from)
  setOrder(next)
}

/* ── Density toggle (§5a) ─────────────────────────────────────── */

function DensityToggle({ density, onChange }: { density: Density; onChange: (d: Density) => void }) {
  const options: { value: Density; label: string }[] = [
    { value: "comfortable", label: "Comfortable" },
    { value: "compact", label: "Compact" },
  ]
  return (
    <div className="inline-flex items-center rounded-md border border-border bg-card p-0.5" role="radiogroup" aria-label="Row density">
      <Rows3 className="mx-1 h-3.5 w-3.5 text-muted-foreground" aria-hidden="true" />
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={density === o.value}
          onClick={() => onChange(o.value)}
          className={cn(
            "rounded px-2 py-1 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
            density === o.value ? "bg-primary text-white" : "text-muted-foreground hover:bg-muted",
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}

/* ── Export menu (§5.9) ───────────────────────────────────────── */

function ExportMenu({
  disabled,
  count,
  loadedCount,
  serverAvailable,
  onExport,
}: {
  disabled: boolean
  count: number
  loadedCount: number
  serverAvailable: boolean
  onExport: (scope: ExportScope) => void
}) {
  const items: { scope: ExportScope; label: string; show: boolean }[] = [
    { scope: "view", label: `Current view (${count})`, show: true },
    { scope: "all-loaded", label: `All loaded (${loadedCount})`, show: loadedCount > count },
    { scope: "server-all", label: "All matching (server)", show: serverAvailable },
  ]
  return (
    <DropdownMenuPrimitive.Root>
      <DropdownMenuPrimitive.Trigger asChild>
        <Button variant="outline" size="sm" className="h-8 gap-1.5 px-2.5" disabled={disabled} aria-label="Export CSV">
          <Download className="h-3.5 w-3.5" aria-hidden="true" />
          <span className="hidden sm:inline">Export</span>
        </Button>
      </DropdownMenuPrimitive.Trigger>
      <DropdownMenuPrimitive.Portal>
        <DropdownMenuPrimitive.Content
          align="end"
          sideOffset={6}
          className="z-[70] min-w-48 overflow-hidden rounded-md border border-border bg-card p-1 shadow-md data-[state=open]:animate-in data-[state=closed]:animate-out"
        >
          {items
            .filter((i) => i.show)
            .map((item) => (
              <DropdownMenuPrimitive.Item
                key={item.scope}
                onSelect={() => onExport(item.scope)}
                className="flex cursor-pointer select-none items-center gap-2 rounded-sm px-2 py-1.5 text-sm outline-none data-[highlighted]:bg-muted"
              >
                {item.label}
              </DropdownMenuPrimitive.Item>
            ))}
        </DropdownMenuPrimitive.Content>
      </DropdownMenuPrimitive.Portal>
    </DropdownMenuPrimitive.Root>
  )
}

/* ── Context menu (§5.5) ──────────────────────────────────────── */

function ContextMenu({
  x,
  y,
  items,
  onClose,
}: {
  x: number
  y: number
  items: ContextMenuItem[]
  onClose: () => void
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose()
    }
    document.addEventListener("keydown", onKey)
    return () => document.removeEventListener("keydown", onKey)
  }, [onClose])

  return (
    <DropdownMenuPrimitive.Root open onOpenChange={(o) => !o && onClose()}>
      <DropdownMenuPrimitive.Trigger asChild>
        <span
          style={{ position: "fixed", left: x, top: y, width: 1, height: 1 }}
          aria-hidden="true"
        />
      </DropdownMenuPrimitive.Trigger>
      <DropdownMenuPrimitive.Portal>
        <DropdownMenuPrimitive.Content
          className="z-[90] min-w-44 overflow-hidden rounded-md border border-border bg-card p-1 shadow-md data-[state=open]:animate-in"
        >
          {items.map((item) => {
            const Icon = item.icon
            return (
              <div key={item.key}>
                {item.separator && <DropdownMenuPrimitive.Separator className="my-1 h-px bg-border" />}
                <DropdownMenuPrimitive.Item
                  disabled={item.disabled}
                  onSelect={item.onClick}
                  className={cn(
                    "flex cursor-pointer select-none items-center gap-2 rounded-sm px-2 py-1.5 text-sm outline-none data-[highlighted]:bg-muted data-[disabled]:opacity-50",
                    item.variant === "destructive" && "text-danger data-[highlighted]:bg-danger/10",
                  )}
                >
                  {Icon && <Icon className="h-3.5 w-3.5" aria-hidden="true" />}
                  {item.label}
                </DropdownMenuPrimitive.Item>
              </div>
            )
          })}
        </DropdownMenuPrimitive.Content>
      </DropdownMenuPrimitive.Portal>
    </DropdownMenuPrimitive.Root>
  )
}

function renderCellValue<T>(col: DataTableColumn<T>, row: T): ReactNode {
  const value = col.accessor ? col.accessor(row) : undefined
  if (value === undefined || value === null) return ""
  return String(value)
}

/** Read one persisted key for the `viewKey` blob (uncontrolled state only). */
function persistedOf<K extends "filters" | "quickFilter" | "openRow">(
  viewKey: string | undefined,
  key: K,
): PersistedTableState[K] | null {
  if (!viewKey) return null
  return readPersisted(viewKey)[key] ?? null
}

/* ── Skeleton rows ───────────────────────────────────────────────
 * The first-load placeholder's `<tr>`s. The canonical `TableSkeleton`
 * (`ui.tsx`) owns this markup, but it hard-codes its own wrapper
 * (`<div class="overflow-x-auto rounded-md border …"><table>`), so it can
 * only be used where the CALLER does not already own the `<table>` element.
 *
 * `DataTable` DOES own one, and the skeleton must land between its real
 * `</thead>` and its real `<tbody>`. Nesting the wrapper there emits
 * `<table>…<div><table>…</table></div>…</table>`, which is invalid HTML:
 * the browser foster-parents the stray `<div>` out of the table, so the
 * skeleton detaches and renders ABOVE the real header. Hence this helper
 * emits the rows ONLY, for a caller-owned `<tbody>`.
 *
 * It is a deliberate byte-for-byte mirror of `TableSkeleton`'s row loop —
 * same density padding (`pad`), same `w-12` checkbox cell, same
 * `col.width ?? "w-24"` fallback that keeps a widthless column visible.
 * Change one and the other MUST move with it. */
function SkeletonRows({
  rows,
  columns,
  selectable,
  td,
}: {
  rows: number
  columns: Array<{ width?: string }>
  selectable: boolean
  td: string
}) {
  return Array.from({ length: rows }, (_, r) => (
    <tr key={r} className="border-b border-border last:border-b-0">
      {selectable && (
        <td className={td}>
          <Skeleton className="h-4 w-4" />
        </td>
      )}
      {columns.map((col, c) => (
        <td key={c} className={td}>
          <Skeleton className={cn("h-4", col.width ?? "w-24")} />
        </td>
      ))}
    </tr>
  ))
}
