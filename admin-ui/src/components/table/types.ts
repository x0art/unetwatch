import type { ReactNode } from "react"
import type { LucideIcon } from "lucide-react"
import type { ColumnFilterValue, DatetimeFilter, FilterType, NumberFilter, SortDir, SortKey } from "../DataTable"

/* ════════════════════════════════════════════════════════════════
 * Shared grid types — the slot grammar (§3), the capability surface
 * (§4) and the persistence shapes (§4.3/§5.7).
 *
 * Kept in a leaf module so `DataTable.tsx`, `useColumnState.ts`,
 * `exportCsv.ts` and the table sub-components can all import them
 * without circularity.
 * ════════════════════════════════════════════════════════════════ */

/* ── §3.1 the seven ordered slots ─────────────────────────────── */
export type ColumnSlot =
  | "select"
  | "identity"
  | "subject"
  | "object"
  | "verdict"
  | "evidence"
  | "measures"
  | "actions"

/** Render order, left → right. `select` is structural (the checkbox
 * prepends everything) and `actions` pins last. */
export const SLOT_ORDER: ColumnSlot[] = [
  "select",
  "identity",
  "subject",
  "object",
  "verdict",
  "evidence",
  "measures",
  "actions",
]

/**
 * Canonical slot order (§3.1). Returns the input untouched when **no**
 * column is tagged — the §4.5 compatibility net — otherwise it ranks by
 * slot, preserving declaration order within a slot, with untagged
 * columns sinking to the end (surfaced in the chooser as "Unslotted").
 */
export function orderBySlot<T extends { slot?: ColumnSlot }>(columns: T[]): T[] {
  if (!columns.some((c) => c.slot !== undefined)) return columns
  const rank = (c: T) => {
    const i = c.slot ? SLOT_ORDER.indexOf(c.slot) : -1
    return i === -1 ? SLOT_ORDER.length : i
  }
  return [...columns]
    .map((col, index) => ({ col, index }))
    .sort((a, b) => rank(a.col) - rank(b.col) || a.index - b.index)
    .map((entry) => entry.col)
}

/* ── §4.1 new column surface ──────────────────────────────────── */

/** Static enum options for a column, superseding `ENUM_FALLBACKS[col.id]`. */
export type FilterOptions = string[]

/* ── §4.3 supporting types ────────────────────────────────────── */

export interface ContextMenuItem {
  key: string
  label: string
  icon?: LucideIcon
  variant?: "default" | "destructive"
  separator?: boolean
  disabled?: boolean
  onClick: () => void
}

export type ExportScope = "view" | "all-loaded" | "server-all"

export interface ExportPayload {
  columns: { id: string; header: string }[]
  rows: Record<string, string | number | null>[]
}

export interface SavedView {
  id: string
  name: string
  sort: { key: SortKey | null; dir: SortDir }
  filters: Record<string, ColumnFilterValue>
  quickFilter: string
  columnOrder: string[]
  columnVisibility: Record<string, boolean>
  columnWidths: Record<string, number>
  density: Density
  pageSize?: number
}

export interface ColumnState {
  order: string[]
  visibility: Record<string, boolean>
  widths: Record<string, number>
}

export type Density = "comfortable" | "compact"

/* ── §5.2 tri-state enum filter ───────────────────────────────── */

/** Object form for a `filterType: "enum"` column. A plain `string`
 * remains a scalar exact-match (today's behaviour). */
export interface EnumFilter {
  include: string[]
  exclude: string[]
}

export type EnumState = "off" | "include" | "exclude"

export function isEnumFilter(value: ColumnFilterValue | undefined): value is EnumFilter {
  return (
    typeof value === "object" &&
    value !== null &&
    "include" in value &&
    "exclude" in value
  )
}

/** Cycle off → include → exclude → off (§7.2). */
export function cycleEnumState(state: EnumState): EnumState {
  return state === "off" ? "include" : state === "include" ? "exclude" : "off"
}

/** Read one option's tri-state out of an EnumFilter. */
export function enumStateOf(option: string, filter: EnumFilter | undefined): EnumState {
  if (!filter) return "off"
  if (filter.include.includes(option)) return "include"
  if (filter.exclude.includes(option)) return "exclude"
  return "off"
}

/** Toggle one option's state, producing a new EnumFilter. */
export function setEnumState(
  filter: EnumFilter | undefined,
  option: string,
  next: EnumState,
): EnumFilter {
  const base: EnumFilter = {
    include: (filter?.include ?? []).filter((v) => v !== option),
    exclude: (filter?.exclude ?? []).filter((v) => v !== option),
  }
  if (next === "include") base.include = [...base.include, option]
  else if (next === "exclude") base.exclude = [...base.exclude, option]
  return base
}

export function isEnumFilterActive(filter: EnumFilter | undefined): boolean {
  if (!filter) return false
  return filter.include.length > 0 || filter.exclude.length > 0
}

/** Narrowing guards for the two range filter shapes — shared by the filter
 * UI and the engine so the union is read exactly one way. */
export function isDatetimeFilter(value: ColumnFilterValue): value is DatetimeFilter {
  return typeof value === "object" && value !== null && "from" in value
}

export function isNumberFilter(value: ColumnFilterValue): value is NumberFilter {
  return typeof value === "object" && value !== null && "min" in value
}

/* ── Persistence (§4.4 / §5.7) ────────────────────────────────── */

export const TABLE_STORAGE_PREFIX = "unetwatch_table_"

/** The one JSON blob written under `unetwatch_table_<viewKey>`. */
export interface PersistedTableState {
  order?: string[]
  visibility?: Record<string, boolean>
  widths?: Record<string, number>
  density?: Density
  sort?: { key: SortKey | null; dir: SortDir }
  filters?: Record<string, ColumnFilterValue>
  quickFilter?: string
  pageSize?: number
  panelWidth?: number
  openRow?: string | number | null
}

export function storageKey(viewKey: string): string {
  return `${TABLE_STORAGE_PREFIX}${viewKey}`
}

/** Read the persisted blob; returns `{}` when absent, unparseable or
 * the storage API is unavailable (private mode / SSR). */
export function readPersisted(viewKey: string | undefined): PersistedTableState {
  if (!viewKey) return {}
  try {
    const raw = window.localStorage.getItem(storageKey(viewKey))
    if (!raw) return {}
    const parsed = JSON.parse(raw) as unknown
    return parsed && typeof parsed === "object" ? (parsed as PersistedTableState) : {}
  } catch {
    return {}
  }
}

/** Merge a patch into the persisted blob. */
export function writePersisted(viewKey: string | undefined, patch: PersistedTableState): void {
  if (!viewKey) return
  try {
    const current = readPersisted(viewKey)
    window.localStorage.setItem(storageKey(viewKey), JSON.stringify({ ...current, ...patch }))
  } catch {
    /* storage may be unavailable */
  }
}

export function clearPersisted(viewKey: string | undefined): void {
  if (!viewKey) return
  try {
    window.localStorage.removeItem(storageKey(viewKey))
  } catch {
    /* ignore */
  }
}

/* ── Column model as consumed by the table sub-components ─────── */

/** The resolved view of a column: the authored column plus the
 * effective slot/density/render hints the engine derived. */
export interface ResolvedColumn<T> {
  col: DataTableColumnLike<T>
  slot?: ColumnSlot
  /** `false` when the chooser must pin it (`hideable: false`). */
  hideable: boolean
  /** Effective visibility after precedence resolution. */
  visible: boolean
  /** Effective width in px after precedence resolution. */
  width?: number
  /** `false` when the column cannot be reordered. */
  reorderable: boolean
}

/** Structural subset of `DataTableColumn<T>` the sub-components need —
 * declared here as an interface so the table modules never import the
 * page-level React file (avoids a false fast-refresh cycle). */
export interface DataTableColumnLike<T> {
  id: string
  header: ReactNode
  accessor?: (row: T) => unknown
  cell?: (row: T) => ReactNode
  enableSorting?: boolean
  enableColumnFilter?: boolean
  filterType?: FilterType
  defaultSortDir?: SortDir
  align?: "left" | "center" | "right"
  className?: string
  headerClassName?: string
  width?: string
  srOnly?: boolean
  slot?: ColumnSlot
  hideable?: boolean
  defaultHidden?: boolean
  minWidth?: number
  maxWidth?: number
  resizable?: boolean
  sticky?: "left" | "right"
  sortable?: boolean
  quickFilter?: boolean
  searchable?: boolean
  filterOptions?: FilterOptions
  cellClass?: string
  headerTitle?: string
  exportValue?: (row: T) => string | number | null
  exportHeader?: string
}
