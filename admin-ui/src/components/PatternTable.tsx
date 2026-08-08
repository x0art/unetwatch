import { useState, useEffect, useCallback } from "react"
import {
  type Pattern,
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
  useToast,
} from "./ui"
import { DataTable, type DataTableColumn, type SortDir, type SortKey } from "./DataTable"
import { useDebounce } from "../lib/utils"
import { AddPatternDialog, AddPatternButton } from "./AddPatternDialog"
import {
  Search,
  Upload,
  Pencil,
  Trash2,
  Loader2,
  ListFilter,
} from "lucide-react"

const PAGE_SIZE = 50

export function PatternTable() {
  const [patterns, setPatterns] = useState<Pattern[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [search, setSearch] = useState("")
  const debouncedSearch = useDebounce(search, 300)
  const [filterType, setFilterType] = useState("all")
  const [page, setPage] = useState(0)
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
        sort_by: (sortBy ?? "id") as "id" | "pattern" | "pattern_type" | "created_at",
        sort_order: sortDir,
      })
      setPatterns(data)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setLoading(false)
    }
  }, [debouncedSearch, filterType, page, sortBy, sortDir])

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

  const editTypeOptions = [
    { value: "block", label: "Block" },
    { value: "whitelist", label: "Whitelist" },
  ]

  const columns: DataTableColumn<Pattern>[] = [
    {
      id: "id",
      header: "ID",
      accessor: (p) => p.id,
      cell: (p) => <span className="font-mono text-xs text-muted-foreground">{p.id}</span>,
      width: "w-14",
    },
    {
      id: "pattern",
      header: "Pattern",
      accessor: (p) => p.pattern,
      defaultSortDir: "asc",
      cell: (p) => (
        <span className="block max-w-[260px] truncate font-mono text-sm" title={p.pattern}>
          {p.pattern}
        </span>
      ),
    },
    {
      id: "pattern_type",
      header: "Type",
      accessor: (p) => p.pattern_type,
      defaultSortDir: "asc",
      cell: (p) => (
        <Badge variant={p.pattern_type === "block" ? "destructive" : "secondary"}>
          {p.pattern_type}
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
            disabled={busy}
            aria-label="Delete pattern"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
        </div>
      ),
    },
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
            aria-label="Search patterns"
          />
        </div>
        <Select value={filterType} onChange={handleFilterChange} options={typeOptions} />
        <AddPatternButton onOpen={() => setCreateOpen(true)} />
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
      <DataTable
        columns={columns}
        data={patterns}
        rowId={(p) => p.id}
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
          title: debouncedSearch || filterType !== "all" ? "No patterns match your search" : "No patterns yet",
          description:
            debouncedSearch || filterType !== "all"
              ? "Try adjusting your search or filter"
              : "Add your first pattern to get started",
        }}
        sortBy={sortBy}
        sortDir={sortDir}
        onSortChange={handleSortChange}
        page={page}
        pageSize={PAGE_SIZE}
        hasNext={patterns.length === PAGE_SIZE}
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
