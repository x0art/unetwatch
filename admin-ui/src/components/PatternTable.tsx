import { useState, useEffect, useCallback } from "react"
import {
  type Pattern,
  listPatterns,
  deletePattern,
  createPattern,
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
  Skeleton,
  ConfirmDialog,
  Pagination,
  useToast,
} from "./ui"
import { useDebounce } from "../lib/utils"
import {
  Search,
  Plus,
  Upload,
  Pencil,
  Trash2,
  Loader2,
  ArrowUpDown,
  ChevronUp,
  ChevronDown,
} from "lucide-react"

const PAGE_SIZE = 50

type SortKey = "id" | "pattern" | "pattern_type" | "created_at"
type SortOrder = "asc" | "desc"

function SortableHeader({
  label,
  sortKey,
  sortBy,
  sortOrder,
  onSort,
}: {
  label: string
  sortKey: SortKey
  sortBy: SortKey
  sortOrder: SortOrder
  onSort: (key: SortKey) => void
}) {
  const active = sortBy === sortKey
  return (
    <th className="text-left px-4 py-3 font-medium text-muted-foreground">
      <button
        type="button"
        onClick={() => onSort(sortKey)}
        className="inline-flex items-center gap-1.5 transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-sm"
        aria-label={`Sort by ${label}${active && sortOrder === "asc" ? " (descending)" : " (ascending)"}`}
      >
        {label}
        {active ? (
          sortOrder === "desc" ? (
            <ChevronDown className="h-3.5 w-3.5" aria-hidden="true" />
          ) : (
            <ChevronUp className="h-3.5 w-3.5" aria-hidden="true" />
          )
        ) : (
          <ArrowUpDown className="h-3.5 w-3.5 opacity-50" aria-hidden="true" />
        )}
      </button>
    </th>
  )
}

export function PatternTable() {
  const [patterns, setPatterns] = useState<Pattern[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [search, setSearch] = useState("")
  const debouncedSearch = useDebounce(search, 300)
  const [filterType, setFilterType] = useState("all")
  const [page, setPage] = useState(0)
  const [sortBy, setSortBy] = useState<SortKey>("id")
  const [sortOrder, setSortOrder] = useState<SortOrder>("desc")

  // ── Edit dialog ──
  const [editOpen, setEditOpen] = useState(false)
  const [editPattern, setEditPattern] = useState<Pattern | null>(null)
  const [editValue, setEditValue] = useState("")
  const [editType, setEditType] = useState("block")
  const [editSaving, setEditSaving] = useState(false)

  // ── Create dialog ──
  const [createOpen, setCreateOpen] = useState(false)
  const [createValue, setCreateValue] = useState("")
  const [createType, setCreateType] = useState("block")
  const [createSaving, setCreateSaving] = useState(false)

  // ── Bulk import dialog ──
  const [bulkOpen, setBulkOpen] = useState(false)
  const [bulkValue, setBulkValue] = useState("")
  const [bulkType, setBulkType] = useState("block")
  const [bulkImporting, setBulkImporting] = useState(false)

  // ── Confirm delete ──
  const [deleteTarget, setDeleteTarget] = useState<number | null>(null)

  const { toast } = useToast()

  /* ── Derived values ────────────────────────────────────────────── */
  const validLineCount = bulkValue
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean).length

  /* ── Data fetching ──────────────────────────────────────────────── */
  const fetchPatterns = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const data = await listPatterns({
        pattern_type: filterType === "all" ? undefined : filterType,
        search: debouncedSearch || undefined,
        limit: PAGE_SIZE,
        offset: page * PAGE_SIZE,
        sort_by: sortBy,
        sort_order: sortOrder,
      })
      setPatterns(data)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setLoading(false)
    }
  }, [debouncedSearch, filterType, page, sortBy, sortOrder])

  useEffect(() => {
    fetchPatterns()
  }, [fetchPatterns])

  /* ── Handlers ───────────────────────────────────────────────────── */

  const handleSearchChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setSearch(e.target.value)
    setPage(0)
  }

  const handleFilterChange = (val: string) => {
    setFilterType(val)
    setPage(0)
  }

  const handleSort = (key: SortKey) => {
    setSortBy(key)
    setSortOrder((prev) => (sortBy === key && prev === "asc" ? "desc" : "asc"))
    setPage(0)
  }

  // Delete
  const handleDeleteConfirm = async () => {
    if (deleteTarget === null) return
    try {
      await deletePattern(deleteTarget)
      toast({ title: "Pattern deleted", variant: "success" })
      setDeleteTarget(null)
      fetchPatterns()
    } catch (e) {
      toast({ title: "Error", description: (e as Error).message, variant: "error" })
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

  // Create
  const handleCreate = async () => {
    if (!createValue.trim()) return
    setCreateSaving(true)
    try {
      await createPattern({ pattern: createValue, pattern_type: createType })
      toast({ title: "Pattern created", variant: "success" })
      setCreateOpen(false)
      setCreateValue("")
      fetchPatterns()
    } catch (e) {
      toast({ title: "Error", description: (e as Error).message, variant: "error" })
    } finally {
      setCreateSaving(false)
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

  const editTypeOptions = [
    { value: "block", label: "Block" },
    { value: "whitelist", label: "Whitelist" },
  ]

  /* ── Render ─────────────────────────────────────────────────────── */
  return (
    <div className="space-y-4">
      {/* ── Toolbar ── */}
      <div className="flex items-center gap-3 flex-wrap">
        <div className="relative">
          <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground pointer-events-none" />
          <Input
            placeholder="Search patterns..."
            value={search}
            onChange={handleSearchChange}
            className="pl-8 max-w-xs"
          />
        </div>
        <Select value={filterType} onChange={handleFilterChange} options={typeOptions} />
        <Button onClick={() => setCreateOpen(true)}>
          <Plus className="h-4 w-4 mr-1.5" />
          Add Pattern
        </Button>
        <Button variant="outline" onClick={() => setBulkOpen(true)}>
          <Upload className="h-4 w-4 mr-1.5" />
          Bulk Import
        </Button>
      </div>

      {/* ── Error banner ── */}
      {error && (
        <div className="flex items-center gap-3 rounded-md border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">
          <span className="flex-1">{error}</span>
          <Button variant="outline" size="sm" onClick={fetchPatterns}>
            Retry
          </Button>
        </div>
      )}

      {/* ── Table ── */}
      <div className="rounded-lg border border-border bg-card">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border bg-muted/50">
                <SortableHeader label="ID" sortKey="id" sortBy={sortBy} sortOrder={sortOrder} onSort={handleSort} />
                <SortableHeader label="Pattern" sortKey="pattern" sortBy={sortBy} sortOrder={sortOrder} onSort={handleSort} />
                <SortableHeader label="Type" sortKey="pattern_type" sortBy={sortBy} sortOrder={sortOrder} onSort={handleSort} />
                <SortableHeader label="Created" sortKey="created_at" sortBy={sortBy} sortOrder={sortOrder} onSort={handleSort} />
                <th className="text-right px-4 py-3 font-medium text-muted-foreground">Actions</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                Array.from({ length: 5 }).map((_, i) => (
                  <tr key={i} className="border-b border-border">
                    <td className="px-4 py-3"><Skeleton className="h-4 w-8" /></td>
                    <td className="px-4 py-3"><Skeleton className="h-4 w-40" /></td>
                    <td className="px-4 py-3"><Skeleton className="h-5 w-16 rounded-full" /></td>
                    <td className="px-4 py-3"><Skeleton className="h-4 w-24" /></td>
                    <td className="px-4 py-3">
                      <div className="flex justify-end gap-1">
                        <Skeleton className="h-8 w-8 rounded-md" />
                        <Skeleton className="h-8 w-8 rounded-md" />
                      </div>
                    </td>
                  </tr>
                ))
              ) : patterns.length === 0 ? (
                <tr>
                  <td colSpan={5}>
                    <div className="flex flex-col items-center justify-center py-12 text-center">
                      <Search className="h-8 w-8 text-muted-foreground/40 mb-3" />
                      <p className="text-sm font-medium text-muted-foreground">
                        {debouncedSearch || filterType
                          ? "No patterns match your search"
                          : "No patterns yet"}
                      </p>
                      <p className="text-xs text-muted-foreground/60 mt-1">
                        {debouncedSearch || filterType
                          ? "Try adjusting your search or filter"
                          : "Add your first pattern to get started"}
                      </p>
                    </div>
                  </td>
                </tr>
              ) : (
                patterns.map((p) => (
                  <tr
                    key={p.id}
                    className="border-b border-border hover:bg-muted/50 transition-colors"
                  >
                    <td className="px-4 py-3 text-muted-foreground text-xs font-mono">{p.id}</td>
                    <td className="px-4 py-3 font-mono text-sm max-w-[260px] truncate" title={p.pattern}>
                      {p.pattern}
                    </td>
                    <td className="px-4 py-3">
                      <Badge variant={p.pattern_type === "block" ? "destructive" : "secondary"}>
                        {p.pattern_type}
                      </Badge>
                    </td>
                    <td className="px-4 py-3 text-muted-foreground text-xs whitespace-nowrap">
                      {p.created_at ? new Date(p.created_at).toLocaleDateString() : "—"}
                    </td>
                    <td className="px-4 py-3 text-right">
                      <div className="flex justify-end gap-1">
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => openEdit(p)}
                          aria-label="Edit pattern"
                        >
                          <Pencil className="h-3.5 w-3.5" />
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          className="text-destructive hover:text-destructive/80 hover:bg-destructive/10"
                          onClick={() => setDeleteTarget(p.id)}
                          aria-label="Delete pattern"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* ── Pagination (unknown total — prev/next only) ── */}
      <Pagination
        page={page}
        pageSize={PAGE_SIZE}
        hasNext={patterns.length === PAGE_SIZE}
        onPageChange={setPage}
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

      {/* ── Create Dialog ── */}
      <Dialog open={createOpen} onClose={() => setCreateOpen(false)} title="Add Pattern">
        <div className="space-y-4">
          <div>
            <Label>Pattern</Label>
            <Input
              value={createValue}
              onChange={(e) => setCreateValue(e.target.value)}
              placeholder="*porn*"
              autoFocus
            />
          </div>
          <div>
            <Label>Type</Label>
            <Select value={createType} onChange={setCreateType} options={editTypeOptions} />
          </div>
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="outline" onClick={() => setCreateOpen(false)} disabled={createSaving}>
              Cancel
            </Button>
            <Button onClick={handleCreate} disabled={!createValue.trim() || createSaving}>
              {createSaving && <Loader2 className="h-4 w-4 mr-1.5 animate-spin" />}
              Create
            </Button>
          </div>
        </div>
      </Dialog>

      {/* ── Bulk Import Dialog ── */}
      <Dialog open={bulkOpen} onClose={() => setBulkOpen(false)} title="Bulk Import Patterns">
        <div className="space-y-4">
          <div>
            <Label>Patterns (one per line)</Label>
            <textarea
              className="flex min-h-[120px] w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring font-mono"
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