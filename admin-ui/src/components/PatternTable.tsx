import { useState, useEffect, useCallback, useMemo } from "react"
import {
  type Pattern,
  type PatternStats,
  getPatternStats,
  patternAction,
  listPatterns,
  deletePattern,
  updatePattern,
  bulkImport,
} from "../api"
import {
  Button,
  Input,
  Badge,
  Dialog,
  Select,
  Label,
  ConfirmDialog,
  PageHeader,
  SearchInput,
  useToast,
} from "./ui"
import { DataTable, type DataTableColumn, type SortDir, type SortKey } from "./DataTable"
import { useDebounce } from "../lib/utils"
import { actionVariant } from "../lib/logRow"
import { AddPatternDialog, AddPatternButton } from "./AddPatternDialog"
import { PatternSummaryCards } from "./PatternSummaryCards"
import { PatternSimulationDrawer } from "./PatternSimulationDrawer"
import {
  Upload,
  Pencil,
  Trash2,
  Loader2,
  ListFilter,
  FlaskConical,
} from "lucide-react"

const DEFAULT_PAGE_SIZE = 50

/** A pattern row enriched with the Pattern Manager display fields (spec §3.3).
 *  The backend registry exposes only id/pattern/pattern_type/timestamps, so
 *  CATEGORY, ACTION and STATUS are derived client-side from pattern_type. */
interface PatternRow extends Pattern {
  category: string
  action: "ALLOW" | "DENY" | "FLAG"
  /** Per-pattern hits in the 24h window — not yet exposed by the backend, so
   *  always "—" until Task 9/10 lands per-pattern aggregation. */
  matches24h: number | null
  status: "active" | "draft"
}

/* Module-level handles to component state, synced each render, so
 * PATTERNS_COLUMNS stays referentially stable at module scope while its
 * cells still trigger edits/deletes and read the busy flag. */
const PATTERNS_UI: {
  busy: boolean
  onEdit: (p: Pattern) => void
  onDelete: (id: number) => void
} = {
  busy: false,
  onEdit: () => {},
  onDelete: () => {},
}

/** Stable row identity for the patterns table. */
const PATTERNS_ROW_ID = (p: PatternRow) => p.id

/* Module-scope columns for the patterns table — referentially stable so
 * DataTable never re-sorts/re-renders when PatternTable re-renders. */
const PATTERNS_COLUMNS: DataTableColumn<PatternRow>[] = [
  {
    id: "id",
    header: "ID",
    accessor: (p) => p.id,
    cell: (p) => <span className="font-mono text-xs text-muted-foreground">{p.id}</span>,
    width: "w-14",
  },
  {
    id: "pattern",
    header: "Pattern Regex/Wildcard",
    accessor: (p) => p.pattern,
    defaultSortDir: "asc",
    cell: (p) => (
      <span className="block max-w-[260px] truncate font-mono text-sm font-bold uppercase" title={p.pattern}>
        {p.pattern}
      </span>
    ),
  },
  {
    id: "category",
    header: "Category",
    accessor: (p) => p.category,
    defaultSortDir: "asc",
    cell: (p) => (
      <Badge variant="secondary">{p.category}</Badge>
    ),
    width: "w-28",
  },
  {
    id: "action",
    header: "Action",
    accessor: (p) => p.action,
    defaultSortDir: "asc",
    cell: (p) => (
      <Badge variant={actionVariant(p.action)}>{p.action}</Badge>
    ),
    width: "w-24",
  },
  {
    id: "matches_24h",
    header: "Matches (24h)",
    accessor: (p) => p.matches24h ?? 0,
    cell: (p) => (
      <span className="font-mono text-xs tabular-nums text-muted-foreground">
        {p.matches24h === null ? "—" : p.matches24h.toLocaleString()}
      </span>
    ),
    width: "w-24",
  },
  {
    id: "status",
    header: "Status",
    accessor: (p) => p.status,
    defaultSortDir: "asc",
    cell: (p) => (
      <Badge variant={p.status === "active" ? "success" : "outline"} className={p.status === "active" ? "" : "text-muted-foreground"}>
        {p.status === "active" ? "[Active]" : "Draft"}
      </Badge>
    ),
    width: "w-24",
  },
  {
    id: "created_at",
    header: "Created",
    accessor: (p) => p.created_at,
    cell: (p) => (
      <span className="whitespace-nowrap text-xs text-muted-foreground">
        {p.created_at ? new Date(p.created_at).toLocaleDateString() : "—"}
      </span>
    ),
    width: "w-28",
  },
  {
    id: "actions",
    header: <span className="sr-only">Actions</span>,
    enableSorting: false,
    align: "right",
    width: "w-20",
    cell: (p) => (
      <div className="flex justify-end gap-1">
        <Button
          size="sm"
          variant="ghost"
          onClick={() => PATTERNS_UI.onEdit(p)}
          aria-label="Edit pattern"
        >
          <Pencil className="h-3.5 w-3.5" />
        </Button>
        <Button
          size="sm"
          variant="ghost"
          className="text-destructive hover:text-destructive/80 hover:bg-destructive/10"
          onClick={() => PATTERNS_UI.onDelete(p.id)}
          disabled={PATTERNS_UI.busy}
          aria-label="Delete pattern"
        >
          <Trash2 className="h-3.5 w-3.5" />
        </Button>
      </div>
    ),
  },
]

export function PatternTable() {
  const [patterns, setPatterns] = useState<PatternRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [search, setSearch] = useState("")
  const debouncedSearch = useDebounce(search, 300)
  const [filterType, setFilterType] = useState("all")
  const [filterCategory, setFilterCategory] = useState("all")
  const [filterAction, setFilterAction] = useState("all")
  const [filterActive, setFilterActive] = useState("all")
  const [stats, setStats] = useState<PatternStats>({
    totalActive: 0,
    flagged24h: 0,
    highRisk: 0,
    pendingDrafts: 0,
  })
  const [page, setPage] = useState(0)
  const [pageSize, setPageSize] = useState(DEFAULT_PAGE_SIZE)
  const [sortBy, setSortBy] = useState<SortKey | null>("id")
  const [sortDir, setSortDir] = useState<SortDir>("desc")
  const [busy, setBusy] = useState(false)

  // ── Edit dialog ──
  const [editOpen, setEditOpen] = useState(false)
  const [editPattern, setEditPattern] = useState<Pattern | null>(null)
  const [editValue, setEditValue] = useState("")
  const [editType, setEditType] = useState("block")
  const [editSaving, setEditSaving] = useState(false)

  // ── Create dialog (shared AddPatternDialog) ──
  const [createOpen, setCreateOpen] = useState(false)

  // ── Live Kibana simulation drawer (Task 9 — spec §3.3) ──
  // Pattern draft handed off from InspectionDrawer (Task 13 click-to-filter):
  // read ?pattern= (or the stored draft) on mount and auto-open the drawer
  // pre-filled so Rule Generation continues the spec §7 workflow seamlessly.
  const [simulateOpen, setSimulateOpen] = useState(() => {
    try {
      const params = new URLSearchParams(window.location.search)
      if (params.has("pattern")) return true
      return !!window.localStorage.getItem("unetwatch_pattern_draft")
    } catch {
      return false
    }
  })
  const [initialPattern, setInitialPattern] = useState<string | undefined>(() => {
    try {
      const params = new URLSearchParams(window.location.search)
      const p = params.get("pattern")
      if (p) {
        // Consume the one-shot ?pattern= draft so it doesn't re-trigger on refresh.
        params.delete("pattern")
        window.history.replaceState(null, "", `${window.location.pathname}${params.toString() ? `?${params.toString()}` : ""}`)
        return p
      }
      return window.localStorage.getItem("unetwatch_pattern_draft") ?? undefined
    } catch {
      return undefined
    }
  })

  // ── Bulk import dialog ──
  const [bulkOpen, setBulkOpen] = useState(false)
  const [bulkValue, setBulkValue] = useState("")
  const [bulkType, setBulkType] = useState("block")
  const [bulkImporting, setBulkImporting] = useState(false)

  // ── Confirm delete ──
  const [deleteTarget, setDeleteTarget] = useState<number | null>(null)
  const [confirmBulkDelete, setConfirmBulkDelete] = useState(false)
  const [pendingBulk, setPendingBulk] = useState<Set<string | number> | null>(null)

  const { toast } = useToast()

  /* ── Derived values ────────────────────────────────────────────── */
  const validLineCount = bulkValue
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean).length

  /* ── Data fetching ────────────────────────────────────────────────
   * Server-side: pattern_type (block/whitelist) + search + sort.
   * Client-side (documented in Task 8 report): the Category/Action/Active
   * filters operate on derived fields the backend does not expose, so they
   * apply over the fetched registry page below. The table stays server-
   * paginated by the base pattern_type/search; rows hidden by a derived
   * filter are simply not rendered. */
  const fetchPatterns = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const data = await listPatterns({
        pattern_type: filterType === "all" ? undefined : filterType,
        search: debouncedSearch || undefined,
        limit: pageSize,
        offset: page * pageSize,
        sort_by: (sortBy ?? "id") as "id" | "pattern" | "pattern_type" | "created_at",
        sort_order: sortDir,
      })
      const rows: PatternRow[] = data.map((p) => {
        const action = patternAction(p)
        return {
          ...p,
          category: p.pattern_type === "block" ? "Block" : "Whitelist",
          action,
          matches24h: null,
          status: p.pattern_type === "block" ? "active" : "draft",
        }
      })
      setPatterns(rows)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setLoading(false)
    }
  }, [debouncedSearch, filterType, page, pageSize, sortBy, sortDir])

  /* ── Pattern Manager summary cards (spec §3.3) ──────────────────── */
  const fetchStats = useCallback(async () => {
    try {
      setStats(await getPatternStats())
    } catch {
      /* leave the last known values in place */
    }
  }, [])

  useEffect(() => {
    fetchStats()
  }, [fetchStats])

  /* Category/Action/Active filters are client-side (derived fields). When one
   * is active the fetched page is smaller than pageSize, so drop to page 0 to
   * avoid showing an empty page while matching rows exist on earlier pages. */
  useEffect(() => {
    if (
      (filterCategory !== "all" || filterAction !== "all" || filterActive !== "all") &&
      page > 0
    ) {
      setPage(0)
    }
  }, [filterCategory, filterAction, filterActive, page])

  useEffect(() => {
    fetchPatterns()
  }, [fetchPatterns])

  /* ── Handlers ───────────────────────────────────────────────────── */

  const handleSearchChange = (value: string) => {
    setSearch(value)
    setPage(0)
  }

  const handleFilterChange = (val: string) => {
    setFilterType(val)
    setPage(0)
  }

  const handleSortChange = (key: SortKey, dir: SortDir) => {
    setSortBy(key)
    setSortDir(dir)
    setPage(0)
  }

  const handleDeleteConfirm = async () => {
    if (deleteTarget === null) return
    setBusy(true)
    try {
      await deletePattern(deleteTarget)
      toast({ title: "Pattern deleted", variant: "success" })
      setDeleteTarget(null)
      fetchPatterns()
    } catch (e) {
      toast({ title: "Error", description: (e as Error).message, variant: "error" })
    } finally {
      setBusy(false)
    }
  }

  const handleBulkDelete = async (ids: Set<string | number>) => {
    const idList = [...ids] as number[]
    setPendingBulk(null)
    setConfirmBulkDelete(false)
    if (!idList.length) return
    setBusy(true)
    try {
      await Promise.all(idList.map((id) => deletePattern(id)))
      toast({ title: `Deleted ${idList.length} pattern${idList.length === 1 ? "" : "s"}`, variant: "success" })
      if (idList.length >= patterns.length && page > 0) setPage(page - 1)
      else fetchPatterns()
    } catch (e) {
      toast({ title: "Bulk delete failed", description: (e as Error).message, variant: "error" })
    } finally {
      setBusy(false)
    }
  }

  // Edit
  const openEdit = (p: Pattern) => {
    setEditPattern(p)
    setEditValue(p.pattern)
    setEditType(p.pattern_type)
    setEditOpen(true)
  }

  const handleSaveEdit = async () => {
    if (!editPattern || !editValue.trim()) return
    setEditSaving(true)
    try {
      await updatePattern(editPattern.id, {
        pattern: editValue,
        pattern_type: editType,
      })
      toast({ title: "Pattern updated", variant: "success" })
      setEditOpen(false)
      fetchPatterns()
    } catch (e) {
      toast({ title: "Error", description: (e as Error).message, variant: "error" })
    } finally {
      setEditSaving(false)
    }
  }

  // Bulk import
  const handleBulkImport = async () => {
    if (validLineCount === 0) return
    setBulkImporting(true)
    try {
      const lines = bulkValue
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean)
      const result = await bulkImport({ patterns: lines, pattern_type: bulkType })
      toast({ title: `Imported ${result.length} patterns`, variant: "success" })
      setBulkOpen(false)
      setBulkValue("")
      fetchPatterns()
    } catch (e) {
      toast({ title: "Error", description: (e as Error).message, variant: "error" })
    } finally {
      setBulkImporting(false)
    }
  }

  /* ── Shared options ─────────────────────────────────────────────── */
  const typeOptions = [
    { value: "all", label: "All types" },
    { value: "block", label: "Block" },
    { value: "whitelist", label: "Whitelist" },
  ]

  const categoryOptions = [
    { value: "all", label: "Category: All" },
    { value: "Block", label: "Category: Block" },
    { value: "Whitelist", label: "Category: Whitelist" },
  ]

  const actionOptions = [
    { value: "all", label: "Action: All" },
    { value: "FLAG", label: "Action: FLAG" },
    { value: "DENY", label: "Action: DENY" },
    { value: "ALLOW", label: "Action: ALLOW" },
  ]

  /* Status filter — spec §3.3 renders this as `[Active v]`. The "all" (no
   * filter) state is not a dropdown entry: the closed trigger falls back to
   * the placeholder "Active" so it reads exactly like the spec, while the
   * dropdown offers Active / Draft as explicit filters. */
  const activeOptions = [
    { value: "active", label: "Active" },
    { value: "draft", label: "Draft" },
  ]

  const editTypeOptions = [
    { value: "block", label: "Block" },
    { value: "whitelist", label: "Whitelist" },
  ]

  // Sync live state into the module-scope PATTERNS_COLUMNS handles.
  PATTERNS_UI.busy = busy
  PATTERNS_UI.onEdit = openEdit
  PATTERNS_UI.onDelete = (id) => setDeleteTarget(id)
  const columns: DataTableColumn<PatternRow>[] = PATTERNS_COLUMNS

  const filteredPatterns = useMemo(() => {
    let rows = patterns
    if (filterCategory !== "all") {
      const want = filterCategory.toLowerCase()
      rows = rows.filter((p) => p.category.toLowerCase() === want)
    }
    if (filterAction !== "all") {
      rows = rows.filter((p) => p.action === filterAction)
    }
    if (filterActive !== "all") {
      rows = rows.filter((p) => p.status === filterActive)
    }
    return rows
  }, [patterns, filterCategory, filterAction, filterActive])

  const anyDerivedFilter =
    filterCategory !== "all" || filterAction !== "all" || filterActive !== "all"

  /* ── Render ─────────────────────────────────────────────────────── */
  return (
    <div className="space-y-4">
      {/* ── Header + Toolbar ── */}
      <PageHeader
        title="Pattern Manager"
        description="Block and whitelist patterns used for URL matching — summary cards, filters and the pattern registry (spec §3.3)"
      >
        <AddPatternButton onOpen={() => setCreateOpen(true)} />
        <Button variant="outline" onClick={() => setSimulateOpen(true)}>
          <FlaskConical className="h-4 w-4 mr-1.5" />
          Run Simulation
        </Button>
        <Button variant="outline" onClick={() => setBulkOpen(true)}>
          <Upload className="h-4 w-4 mr-1.5" />
          Bulk Import
        </Button>
      </PageHeader>

      {/* ── Pattern Manager summary cards (spec §3.3) ── */}
      <PatternSummaryCards stats={stats} />

      {/* ── Search + Category/Action/Active filter bar ── */}
      <div className="flex flex-wrap items-center gap-2 rounded-lg border border-border bg-card p-3 shadow-sm">
        <SearchInput
          placeholder="Search patterns, tags, domain..."
          value={search}
          onChange={handleSearchChange}
          className="w-64"
          aria-label="Search patterns"
        />
        <Select value={filterCategory} onChange={setFilterCategory} options={categoryOptions} aria-label="Filter by category" />
        <Select value={filterAction} onChange={setFilterAction} options={actionOptions} aria-label="Filter by action" />
        <Select value={filterActive} onChange={setFilterActive} options={activeOptions} placeholder="Active" aria-label="Filter by status" />
        <Select value={filterType} onChange={handleFilterChange} options={typeOptions} aria-label="Filter by type" />
        {(debouncedSearch || filterType !== "all" || anyDerivedFilter) && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setSearch("")
              setFilterType("all")
              setFilterCategory("all")
              setFilterAction("all")
              setFilterActive("all")
              setPage(0)
            }}
          >
            Reset
          </Button>
        )}
      </div>

      {/* ── Error banner ── */}
      {error && (
        <div className="flex items-center gap-3 border-[2.5px] border-[#0A0A0A] bg-danger px-4 py-3 font-mono text-xs font-bold uppercase tracking-widest text-white">
          <span className="flex-1">{error}</span>
          <Button variant="outline" size="sm" onClick={fetchPatterns}>
            Retry
          </Button>
        </div>
      )}

      {/* ── Table ── */}
      <DataTable
        columns={columns}
        data={filteredPatterns}
        rowId={PATTERNS_ROW_ID}
        loading={loading}
        selectable
        busy={busy}
        bulkActions={[
          {
            label: "Delete",
            icon: Trash2,
            variant: "destructive",
            onClick: (ids) => {
              setPendingBulk(ids)
              setConfirmBulkDelete(true)
            },
          },
        ]}
        empty={{
          icon: ListFilter,
          title:
            debouncedSearch || filterType !== "all" || anyDerivedFilter
              ? "No patterns match your filters"
              : "No patterns yet",
          description:
            debouncedSearch || filterType !== "all" || anyDerivedFilter
              ? "Try adjusting your search or filter"
              : "Add your first pattern to get started",
        }}
        sortBy={sortBy}
        sortDir={sortDir}
        onSortChange={handleSortChange}
        page={page}
        pageSize={pageSize}
        hasNext={patterns.length === pageSize}
        onPageSizeChange={(size) => { setPageSize(size); setPage(0) }}
        onPageChange={setPage}
        ariaLabel="Patterns"
      />

      {/* ── Confirm Delete Dialog ── */}
      <ConfirmDialog
        open={deleteTarget !== null}
        title="Delete Pattern"
        description="Are you sure you want to delete this pattern? This action cannot be undone."
        confirmLabel="Delete"
        variant="destructive"
        onConfirm={handleDeleteConfirm}
        onCancel={() => setDeleteTarget(null)}
      />

      <ConfirmDialog
        open={confirmBulkDelete}
        title="Delete selected patterns?"
        description={`${pendingBulk?.size ?? 0} selected pattern${
          (pendingBulk?.size ?? 0) !== 1 ? "s" : ""
        } will be permanently removed. This cannot be undone.`}
        confirmLabel="Delete selected"
        variant="destructive"
        onConfirm={() => {
          if (pendingBulk) handleBulkDelete(pendingBulk)
        }}
        onCancel={() => setConfirmBulkDelete(false)}
      />

      {/* ── Edit Dialog ── */}
      <Dialog open={editOpen} onClose={() => setEditOpen(false)} title="Edit Pattern">
        <div className="space-y-4">
          <div>
            <Label>Pattern</Label>
            <Input
              value={editValue}
              onChange={(e) => setEditValue(e.target.value)}
              placeholder="*pattern*"
            />
          </div>
          <div>
            <Label>Type</Label>
            <Select value={editType} onChange={setEditType} options={editTypeOptions} />
          </div>
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="outline" onClick={() => setEditOpen(false)} disabled={editSaving}>
              Cancel
            </Button>
            <Button onClick={handleSaveEdit} disabled={!editValue.trim() || editSaving}>
              {editSaving && <Loader2 className="h-4 w-4 mr-1.5 animate-spin" />}
              Save
            </Button>
          </div>
        </div>
      </Dialog>

      {/* ── Add Pattern Dialog (shared, also used from the header) ── */}
      <AddPatternDialog
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onCreated={fetchPatterns}
      />

      {/* ── Live Kibana simulation drawer (Task 9 — spec §3.3) ── */}
      <PatternSimulationDrawer
        open={simulateOpen}
        onClose={() => {
          setSimulateOpen(false)
          // Draft consumed — clear both the stored and in-flight handoff.
          try {
            window.localStorage.removeItem("unetwatch_pattern_draft")
          } catch {
            /* ignore */
          }
          setInitialPattern(undefined)
        }}
        onCreated={fetchPatterns}
        initialUrl={initialPattern}
      />

      {/* ── Bulk Import Dialog ── */}
      <Dialog open={bulkOpen} onClose={() => setBulkOpen(false)} title="Bulk Import Patterns">
        <div className="space-y-4">
          <div>
            <Label>Patterns (one per line)</Label>
            <textarea
              className="flex min-h-[120px] w-full border-[2.5px] border-[#0A0A0A] bg-card px-3 py-2 font-mono text-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              value={bulkValue}
              onChange={(e) => setBulkValue(e.target.value)}
              placeholder={`*pattern1*\n*pattern2*`}
            />
            <p className="text-xs text-muted-foreground mt-1.5">
              {validLineCount === 0
                ? "Enter patterns, one per line"
                : `${validLineCount} valid ${validLineCount === 1 ? "line" : "lines"}`}
            </p>
          </div>
          <div>
            <Label>Type</Label>
            <Select value={bulkType} onChange={setBulkType} options={editTypeOptions} />
          </div>
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="outline" onClick={() => setBulkOpen(false)} disabled={bulkImporting}>
              Cancel
            </Button>
            <Button onClick={handleBulkImport} disabled={validLineCount === 0 || bulkImporting}>
              {bulkImporting && <Loader2 className="h-4 w-4 mr-1.5 animate-spin" />}
              Import{validLineCount > 0 ? ` (${validLineCount})` : ""}
            </Button>
          </div>
        </div>
      </Dialog>
    </div>
  )
}
