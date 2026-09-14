import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react"
import { createPortal } from "react-dom"
import { AnimatePresence, motion } from "framer-motion"
import { ArrowDown, ArrowUp, ArrowUpDown, Filter, X, type LucideIcon } from "lucide-react"
import { cn } from "../lib/utils"
import { Button, EmptyState, Pagination, Select, Skeleton } from "./ui"
import { EASE, Stagger, StaggerItem } from "./motion"

/* ════════════════════════════════════════════════════════════════
 * DataTable — reusable, sortable table with bulk actions
 *
 * One component for every table in the app. Supports:
 *  - sortable columns (client-side by default, or fully controlled
 *    for server-side sorting via onSortChange)
 *  - row selection + a bulk action bar (select-all, indeterminate,
 *    per-action buttons, clear)
 *  - loading skeleton rows, empty states, pagination slot
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

/** A column filter value: scalar for `enum`/`text`, range object for `datetime`/`number`. */
export type ColumnFilterValue = string | DatetimeFilter | NumberFilter

export function isActiveFilter(value: ColumnFilterValue | undefined): boolean {
  if (value === undefined) return false
  if (typeof value === "string") return value.trim() !== ""
  return Object.values(value).some((v) => v.trim() !== "")
}

function isDatetimeFilter(value: ColumnFilterValue): value is DatetimeFilter {
  return typeof value === "object" && "from" in value
}

function isNumberFilter(value: ColumnFilterValue): value is NumberFilter {
  return typeof value === "object" && "min" in value
}

function emptyFilterFor(type: FilterType): ColumnFilterValue {
  if (type === "datetime") return { from: "", to: "" }
  if (type === "number") return { min: "", max: "" }
  return ""
}

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
}

function compareValues(a: unknown, b: unknown): number {
  if (a === b) return 0
  if (a === undefined || a === null || a === "") return 1
  if (b === undefined || b === null || b === "") return -1
  if (typeof a === "number" && typeof b === "number") return a - b
  return String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: "base" })
}

/**
 * HeaderFilter — popover filter anchored in the `th`, with the type-matched
 * control + Clear/Apply. Draft state lives locally until Apply commits it via
 * `onApply`, so typing never refilters mid-keystroke.
 */
function HeaderFilter<T>({
  col,
  value,
  onApply,
  options,
}: {
  col: DataTableColumn<T>
  value: ColumnFilterValue | undefined
  onApply: (value: ColumnFilterValue) => void
  options: { value: string; label: string }[]
}) {
  const type = col.filterType ?? "enum"
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState<ColumnFilterValue>(value ?? emptyFilterFor(type))
  const triggerRef = useRef<HTMLButtonElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  // Portal the popover to document.body — the table wrapper is
  // overflow-x-auto, which forces overflow-y to auto and would clip an
  // absolutely-positioned panel inside the th on wide/scrolled tables.
  const [panelPos, setPanelPos] = useState<{ top: number; left: number } | null>(null)
  useLayoutEffect(() => {
    if (!open) {
      setPanelPos(null)
      return
    }
    const place = () => {
      const r = triggerRef.current?.getBoundingClientRect()
      if (!r) return
      // Clamp horizontally so right-edge columns never run off-viewport
      // (panel is w-56 = 224px).
      setPanelPos({
        top: r.bottom + window.scrollY + 4,
        left: Math.max(8, Math.min(r.left + window.scrollX, window.innerWidth - 232)),
      })
    }
    place()
    window.addEventListener("scroll", place, true)
    window.addEventListener("resize", place)
    return () => {
      window.removeEventListener("scroll", place, true)
      window.removeEventListener("resize", place)
    }
  }, [open ])

  // Resync the draft when the committed filter changes from outside
  // (Clear from the trigger state, parent-controlled resets).
  const committedKey = JSON.stringify(value ?? null)
  useEffect(() => {
    setDraft(value ?? emptyFilterFor(type))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [committedKey])

  // Dismiss on outside click / Escape.
  useEffect(() => {
    if (!open) return
    const onPointer = (e: PointerEvent) => {
      const t = e.target as Node
      if (panelRef.current?.contains(t) || triggerRef.current?.contains(t)) return
      setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false)
    }
    document.addEventListener("pointerdown", onPointer)
    document.addEventListener("keydown", onKey)
    return () => {
      document.removeEventListener("pointerdown", onPointer)
      document.removeEventListener("keydown", onKey)
    }
  }, [open ])

  const active = isActiveFilter(value)
  const label = String(col.header)
  const inputClass =
    "h-8 w-full rounded border border-border bg-card px-2 py-1 text-xs text-foreground placeholder:text-muted-foreground/60 focus:border-ring focus:outline-none focus:ring-1 focus:ring-ring"

  return (
    <span className="relative inline-flex">
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-label={`Filter by ${label}`}
        aria-expanded={open}
        aria-pressed={active}
        title={`Filter by ${label}`}
        className={cn(
          "inline-flex h-6 w-6 items-center justify-center rounded border border-transparent transition-colors hover:border-border hover:bg-muted",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
          active ? "text-primary" : "text-muted-foreground/60 hover:text-muted-foreground",
          open && "border-border bg-muted",
        )}
      >
        <Filter className={cn("h-3 w-3", active && "fill-current")} aria-hidden="true" />
        {active && (
          <span
            className="absolute right-0.5 top-0.5 h-1.5 w-1.5 rounded-full bg-primary"
            aria-hidden="true"
          />
        )}
      </button>
      {open && panelPos && createPortal(
        <div
          ref={panelRef}
          role="dialog"
          aria-label={`Filter by ${label}`}
          style={{ top: panelPos.top, left: panelPos.left }}
          className="fixed z-50 mt-1 w-56 rounded-md border border-border bg-card p-3 text-left shadow-md"
        >
          {type === "enum" && (
            <Select
              value={typeof draft === "string" ? draft : ""}
              onChange={(v) => setDraft(v)}
              options={[{ value: "", label: "All" }, ...options]}
              placeholder="All"
              size="sm"
              aria-label={`Filter by ${label}`}
              className="w-full"
            />
          )}
          {type === "text" && (
            <input
              type="search"
              value={typeof draft === "string" ? draft : ""}
              onChange={(e) => setDraft(e.target.value)}
              placeholder="Filter"
              aria-label={`Filter by ${label}`}
              className={inputClass}
            />
          )}
          {type === "datetime" && (
            <div className="space-y-2">
              <label className="mono-label block">
                From
                <input
                  type="datetime-local"
                  value={isDatetimeFilter(draft) ? draft.from : ""}
                  onChange={(e) =>
                    setDraft({ from: e.target.value, to: isDatetimeFilter(draft) ? draft.to : "" })
                  }
                  aria-label={`Filter by ${label}, from`}
                  className={cn(inputClass, "mt-1")}
                />
              </label>
              <label className="mono-label block">
                To
                <input
                  type="datetime-local"
                  value={isDatetimeFilter(draft) ? draft.to : ""}
                  onChange={(e) =>
                    setDraft({ to: e.target.value, from: isDatetimeFilter(draft) ? draft.from : "" })
                  }
                  aria-label={`Filter by ${label}, to`}
                  className={cn(inputClass, "mt-1")}
                />
              </label>
            </div>
          )}
          {type === "number" && (
            <div className="flex items-center gap-2">
              <label className="mono-label flex-1">
                Min
                <input
                  type="number"
                  inputMode="numeric"
                  value={isNumberFilter(draft) ? draft.min : ""}
                  onChange={(e) =>
                    setDraft({ min: e.target.value, max: isNumberFilter(draft) ? draft.max : "" })
                  }
                  aria-label={`Filter by ${label}, minimum`}
                  className={cn(inputClass, "mt-1")}
                />
              </label>
              <label className="mono-label flex-1">
                Max
                <input
                  type="number"
                  inputMode="numeric"
                  value={isNumberFilter(draft) ? draft.max : ""}
                  onChange={(e) =>
                    setDraft({ max: e.target.value, min: isNumberFilter(draft) ? draft.min : "" })
                  }
                  aria-label={`Filter by ${label}, maximum`}
                  className={cn(inputClass, "mt-1")}
                />
              </label>
            </div>
          )}
          <div className="mt-3 flex items-center justify-end gap-2">
            <Button variant="ghost" size="sm" onClick={() => { setDraft(emptyFilterFor(type)); onApply(emptyFilterFor(type)); setOpen(false) }}>
              Clear
            </Button>
            <Button
              variant="default"
              size="sm"
              onClick={() => { onApply(draft); setOpen(false) }}
            >
              Apply
            </Button>
          </div>
        </div>,
        document.body,
      )}
    </span>
  )
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
  skeletonRows = 8,
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
}: DataTableProps<T>) {
  const controlled = !!onSortChange
  const [internalSort, setInternalSort] = useState<{ key: SortKey | null; dir: SortDir }>({
    key: defaultSortBy,
    dir: defaultSortDir,
  })
  const sortState = controlled
    ? { key: sortBy ?? null, dir: sortDir ?? "asc" }
    : internalSort
  const filtersControlled = controlledFilters !== undefined
  const [internalFilters, setInternalFilters] = useState<Record<string, ColumnFilterValue>>({})
  const filters = filtersControlled ? controlledFilters : internalFilters
  const setFilter = (id: string, value: ColumnFilterValue) => {
    const next = { ...filters, [id]: value }
    if (!isActiveFilter(value)) delete next[id]
    if (filtersControlled) onColumnFiltersChange?.(next)
    else setInternalFilters(next)
  }
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
  useEffect(() => {
    setSelected((prev) => {
      if (prev.size === 0) return prev
      const visible = new Set(data.map((r) => rowIdRef.current(r)))
      const next = new Set([...prev].filter((id) => visible.has(id)))
      return next.size === prev.size ? prev : next
    })
  }, [data])

  useEffect(() => {
    onSelectionChange?.(selected)
  }, [selected, onSelectionChange])

  const ids = useMemo(() => data.map((r) => rowId(r)), [data, rowId])
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
    else setInternalSort({ key, dir })
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
  // enum = exact match, text = case-insensitive substring, datetime/number =
  // open-ended range match. NOTE: filterability is intentionally coupled to
  // sortability — a column opts out of both with enableSorting={false}
  // (or enableColumnFilter).
  const filterMatches = (row: T, filters: Record<string, ColumnFilterValue>): boolean => {
    const ids = Object.keys(filters)
    if (ids.length === 0) return true
    return ids.every((id) => {
      const want = filters[id]
      if (!isActiveFilter(want)) return true
      const col = columnsRef.current.find((c) => c.id === id)
      if (!col) return true
      const type = col.filterType ?? "enum"
      const val = col.accessor ? col.accessor(row) : renderCellValue(col, row)
      if (typeof want === "string") {
        const needle = want.trim().toLowerCase()
        if (!needle) return true
        const hay = String(val ?? "").toLowerCase()
        if (type === "text") return hay.includes(needle)
        return hay === needle
      }
      if (isDatetimeFilter(want)) {
        const ts = Date.parse(String(val ?? ""))
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
        const n = Number(val)
        if (val === null || val === undefined || val === "" || Number.isNaN(n)) return false
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

  // Distinct values per enum-filterable column over the current `data`, for
  // the dropdown options. Built once per data/filter-column set; values are
  // de-duplicated string forms of the accessor result.
  const filterOptions = useMemo(() => {
    const map = new Map<string, { value: string; label: string }[]>()
    for (const col of columnsRef.current) {
      if (col.enableSorting === false || col.srOnly || col.enableColumnFilter === false) continue
      if ((col.filterType ?? "enum") !== "enum") continue
      const seen = new Map<string, string>()
      for (const row of data) {
        const v = col.accessor ? col.accessor(row) : renderCellValue(col, row)
        const key = String(v ?? "").trim().toLowerCase()
        if (!key) continue
        if (!seen.has(key)) seen.set(key, String(v))
      }
      map.set(
        col.id,
        [...seen.values()].map((v) => ({ value: v, label: v })),
      )
    }
    return map
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, columns])

  const sortedData = useMemo(() => {
    const base = filteredData
    if (controlled || !sortKey || !sortColumn) return base
    const dir = sortDirState === "asc" ? 1 : -1
    return [...base].sort((a, b) => {
      const av = sortColumn.accessor ? sortColumn.accessor(a) : renderCellValue(sortColumn, a)
      const bv = sortColumn.accessor ? sortColumn.accessor(b) : renderCellValue(sortColumn, b)
      return compareValues(av, bv) * dir
    })
  }, [filteredData, sortKey, sortDirState, controlled, sortColumn])

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

  return (
    <div className={className}>
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
            <span className="h-4 w-px bg-border/20" aria-hidden="true" />
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

      <div className="overflow-x-auto rounded-md border border-border bg-card shadow-none">
        <table className="w-full text-sm" aria-label={ariaLabel}>
          <thead>
            <tr className="border-b border-border bg-transparent text-muted-foreground">
              {selectable && (
                <th className="w-12 px-4 py-3 text-left font-medium text-muted-foreground">
                  <Checkbox
                    checked={allSelected}
                    indeterminate={someSelected}
                    disabled={busy || data.length === 0}
                    onChange={toggleSelectAll}
                    label="Select all rows"
                  />
                </th>
              )}
              {columns.map((col) => {
                const sortable = col.enableSorting !== false && !col.srOnly
                const active = sortable && sortState.key === col.id
                const filterable = sortable && enableFiltering && col.enableColumnFilter !== false
                return (
                  <th
                    key={col.id}
                    className={cn(
                      "px-4 py-3 font-medium text-muted-foreground",
                      alignClass(col.align),
                      col.width,
                      col.headerClassName,
                    )}
                    aria-sort={
                      active ? (sortState.dir === "asc" ? "ascending" : "descending") : undefined
                    }
                  >
                    {sortable ? (
                      <span
                        className={cn(
                          "inline-flex items-center gap-1",
                          col.align === "right" && "flex-row-reverse",
                          col.align === "center" && "justify-center",
                        )}
                      >
                        <button
                          type="button"
                          onClick={() => handleSort(col)}
                          className={cn(
                            "inline-flex cursor-pointer items-center gap-1 mono-label transition-colors hover:text-foreground",
                            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background rounded-sm",
                          )}
                          aria-label={`Sort by ${String(col.header)}${active ? `, currently ${sortState.dir}ending` : ""}`}
                        >
                          {col.header}
                          {active ? (
                            sortState.dir === "asc" ? (
                              <ArrowUp className="h-3 w-3 opacity-100" aria-hidden="true" />
                            ) : (
                              <ArrowDown className="h-3 w-3 opacity-100" aria-hidden="true" />
                            )
                          ) : (
                            <ArrowUpDown className="h-3 w-3 opacity-30" aria-hidden="true" />
                          )}
                        </button>
                        {filterable && (
                          <HeaderFilter
                            col={col}
                            value={filters[col.id]}
                            onApply={(v) => setFilter(col.id, v)}
                            options={(() => {
                              const opts = filterOptions.get(col.id) ?? []
                              const cur = filters[col.id]
                              const curStr = typeof cur === "string" ? cur : ""
                              return curStr && !opts.some((o) => o.value === curStr)
                                ? [...opts, { value: curStr, label: curStr }]
                                : opts
                            })()}
                          />
                        )}
                      </span>
                    ) : (
                      <span
                        className={cn(
                          "mono-label",
                          col.align === "right" && "inline-block w-full text-right",
                          col.align === "center" && "inline-block w-full text-center",
                        )}
                      >
                        {col.header}
                      </span>
                    )}
                  </th>
                )
              })}
            </tr>
          </thead>
          {loading ? (
            <tbody>
              {Array.from({ length: skeletonRows }).map((_, i) => (
                <tr key={i} className="border-b border-border">
                  {selectable && (
                    <td className="px-4 py-3">
                      <Skeleton className="h-4 w-4" />
                    </td>
                  )}
                  {columns.map((col) => (
                    <td key={col.id} className="px-4 py-3">
                      <Skeleton className={cn("h-4", col.width ?? "w-24")} />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          ) : data.length === 0 ? (
            <tbody>
              <tr>
                <td colSpan={columns.length + (selectable ? 1 : 0)}>
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
            // Stagger only the visible page of rows on first paint — never the
            // full dataset (internalPagination keeps displayData ≤ page size).
            <Stagger as="tbody">
              {displayData.map((row) => {
                const id = rowId(row)
                const isSelected = selected.has(id)
                return (
                  <StaggerItem
                    as="tr"
                    key={id}
                    className={cn(
                      "border-b border-border transition-colors",
                      isSelected ? "bg-primary/[0.04] hover:bg-primary/[0.06]" : "hover:bg-muted/50",
                      onRowClick && "cursor-pointer",
                    )}
                    onClick={onRowClick ? () => onRowClick(row) : undefined}
                  >
                    {selectable && (
                      <td className="px-4 py-3" onClick={(e) => e.stopPropagation()}>
                        <Checkbox
                          checked={isSelected}
                          disabled={busy}
                          onChange={() => toggleSelectOne(id)}
                          label={`Select row ${id}`}
                        />
                      </td>
                    )}
                    {columns.map((col) => (
                      <td
                        key={col.id}
                        className={cn("px-4 py-3", alignClass(col.align), col.align === "right" && "tabular-nums", col.className)}
                      >
                        {col.srOnly ? <span className="sr-only">{renderCell(col, row)}</span> : renderCell(col, row)}
                      </td>
                    ))}
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
    </div>
  )
}

function renderCellValue<T>(col: DataTableColumn<T>, row: T): ReactNode {
  const value = col.accessor ? col.accessor(row) : undefined
  if (value === undefined || value === null) return ""
  return String(value)
}
