import { useEffect, useMemo, useRef, useState, type ReactNode } from "react"
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
  columnFilters?: Record<string, string>
  onColumnFiltersChange?: (filters: Record<string, string>) => void
  /** Hide the entire per-column filter row across the table. */
  enableFiltering?: boolean
  /**
   * The per-column filter control. `combobox` (default) renders a compact
   * dropdown of the distinct accessor values over the current `data`, exact-matching
   * the selected value. `text` keeps a substring input. Only paginated tables
   * (onPageChange + page) render the filter row at all.
   */
  filterControl?: "combobox" | "text"
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
  filterControl = "combobox",
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
  const [internalFilters, setInternalFilters] = useState<Record<string, string>>({})
  const filters = filtersControlled ? controlledFilters : internalFilters
  const setFilter = (id: string, value: string) => {
    const next = { ...filters, [id]: value }
    if (!value) delete next[id]
    if (filtersControlled) onColumnFiltersChange?.(next)
    else setInternalFilters(next)
  }
  // A changed column filter can shrink the result set below the current page —
  // jump back to page 0 so the table never lands on a now-empty page. Compare
  // by serialized key so parents re-creating the filters object every render
  // (uncontrolled or not) can't fire the reset spuriously.
  const hasPagination = onPageChange !== undefined && page !== undefined
  const filterKey = Object.keys(filters)
    .filter((k) => filters[k] && filters[k].trim())
    .sort()
    .map((k) => `${k}=${filters[k].trim().toLowerCase()}`)
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
  // Combobox mode (the default on paginated tables) matches the exact
  // accessor value the user picked. Text mode keeps case-insensitive substring
  // matching.
  const filterMatches = (row: T, filters: Record<string, string>): boolean => {
    const ids = Object.keys(filters)
    if (ids.length === 0) return true
    return ids.every((id) => {
      const want = filters[id].trim().toLowerCase()
      if (!want) return true
      const col = columnsRef.current.find((c) => c.id === id)
      if (!col) return true
      const val = col.accessor ? col.accessor(row) : renderCellValue(col, row)
      if (filterControl === "combobox") return String(val ?? "").toLowerCase() === want
      return String(val ?? "").toLowerCase().includes(want)
    })
  }

  const filteredData = useMemo(() => {
    const f = filtersControlled ? controlledFilters : internalFilters
    if (!f || Object.keys(f ?? {}).length === 0) return data
    return data.filter((r) => filterMatches(r, f ?? {}))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, controlledFilters, internalFilters, filtersControlled, filterControl])

  // Distinct values per filterable column over the current `data`, for the
  // combobox options. Built once per data/filter-column set; values are
  // de-duplicated string forms of the accessor result.
  const filterOptions = useMemo(() => {
    const map = new Map<string, { value: string; label: string }[]>()
    if (filterControl !== "combobox") return map
    for (const col of columnsRef.current) {
      if (col.enableSorting === false || col.srOnly || col.enableColumnFilter === false) continue
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
  }, [data, columns, filterControl])

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
            className="mb-3 flex flex-wrap items-center gap-2 rounded-md border border-border bg-secondary px-3 py-2 text-xs font-medium text-foreground shadow-sm"
            role="toolbar"
            aria-label="Bulk actions"
          >
            <span className="tabular-nums">[ {selected.size} SELECTED ]</span>
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

      <div className="overflow-x-auto rounded-md border border-border bg-card shadow-sm">
        <table className="w-full text-sm" aria-label={ariaLabel}>
          <thead>
            <tr className="border-b border-border bg-foreground text-background dark:bg-foreground dark:text-background">
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
                const filterActive = filterable && !!filters[col.id]
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
                      <button
                        type="button"
                        onClick={() => handleSort(col)}
                        className={cn(
                          "inline-flex cursor-pointer items-center gap-1 uppercase tracking-wide transition-colors hover:text-foreground",
                          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background rounded-sm",
                          col.align === "right" && "flex-row-reverse",
                          col.align === "center" && "justify-center",
                        )}
                        aria-label={`Sort by ${String(col.header)}${active ? `, currently ${sortState.dir}ending` : ""}`}
                      >
                        {col.header}
                        {filterActive && (
                          <Filter className="h-3 w-3 text-warning" aria-hidden="true" />
                        )}
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
                    ) : (
                      <span
                        className={cn(
                          "uppercase tracking-wide",
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
            {/* Per-column filter row - only on paginated tables. Combobox of distinct
                accessor values in combobox mode, or a mono substring input in
                text mode. */}
            {enableFiltering && hasPagination && (
              <tr className="border-b-[2.5px] border-border bg-muted/40">
                {selectable && <td className="px-4 py-1.5" />}
                {columns.map((col) => {
                  const filterable = col.enableSorting !== false && !col.srOnly && col.enableColumnFilter !== false
                  const val = filters[col.id] ?? ""
                  return (
                    <td key={col.id} className={cn("px-2 py-1.5", alignClass(col.align))}>
                      {filterable ? (
                        filterControl === "combobox" ? (
                          <div className="flex items-center gap-1">
                            <Filter className="h-3 w-3 shrink-0 opacity-40" aria-hidden="true" />
                            {(() => {
                              const opts = filterOptions.get(col.id) ?? []
                              const patched = val && !opts.some((o) => o.value === val)
                                ? [...opts, { value: val, label: val }]
                                : opts
                              return (
                                <Select
                                  value={val}
                                  onChange={(v) => setFilter(col.id, v)}
                                  options={[{ value: "", label: "All" }, ...patched]}
                                  placeholder="All"
                                  size="sm"
                                  aria-label={`Filter by ${String(col.header)}`}
                                  className="flex-1"
                                />
                              )
                            })()}
                          </div>
                        ) : (
                          <div className={cn("group relative", col.align === "right" && "ml-auto", col.width ? `max-w-full` : "", "w-full")}>
                            <span className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 opacity-40">
                              <Filter className="h-3 w-3" aria-hidden="true" />
                            </span>
                            <input
                              type="search"
                              value={val}
                              onChange={(e) => setFilter(col.id, e.target.value)}
                              placeholder="Filter..."
                              aria-label={`Filter by ${String(col.header)}`}
                              className={cn(
                                "h-7 w-full rounded border-[1.5px] border-border bg-card py-1 pr-6 pl-7 font-mono text-[11px] text-foreground placeholder:text-muted-foreground/60 focus:border-ring focus:outline-none focus:ring-1 focus:ring-ring",
                                col.align === "right" && "text-right",
                              )}
                            />
                            {val && (
                              <button
                                type="button"
                                onClick={() => setFilter(col.id, "")}
                                className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded border border-transparent p-0.5 text-muted-foreground hover:border-border hover:bg-muted"
                                aria-label={`Clear filter on ${String(col.header)}`}
                              >
                                <X className="h-3 w-3" aria-hidden="true" />
                              </button>
                            )}
                          </div>
                        )
                      ) : (
                        <span />
                      )}
                    </td>
                  )
                })}
              </tr>
            )}
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
                      "border-b border-border transition-colors hover:bg-muted/30",
                      isSelected && "bg-muted/40",
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
