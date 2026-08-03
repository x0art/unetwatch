import { useState, useEffect, useCallback } from "react"
import { type Pattern, listPatterns, deletePattern, createPattern, updatePattern, bulkImport } from "../api"
import { Button, Input, Badge, Dialog, Select, Label, Card, CardContent } from "./ui"

export function PatternTable() {
  const [patterns, setPatterns] = useState<Pattern[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [search, setSearch] = useState("")
  const [filterType, setFilterType] = useState("")
  const [page, setPage] = useState(0)
  const [toast, setToast] = useState<string | null>(null)

  // Edit dialog
  const [editOpen, setEditOpen] = useState(false)
  const [editPattern, setEditPattern] = useState<Pattern | null>(null)
  const [editValue, setEditValue] = useState("")
  const [editType, setEditType] = useState("block")

  // Create dialog
  const [createOpen, setCreateOpen] = useState(false)
  const [createValue, setCreateValue] = useState("")
  const [createType, setCreateType] = useState("block")

  // Bulk import dialog
  const [bulkOpen, setBulkOpen] = useState(false)
  const [bulkValue, setBulkValue] = useState("")
  const [bulkType, setBulkType] = useState("block")

  const showToast = (msg: string) => {
    setToast(msg)
    setTimeout(() => setToast(null), 3000)
  }

  const fetchPatterns = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const data = await listPatterns({
        pattern_type: filterType || undefined,
        search: search || undefined,
        limit: 50,
        offset: page * 50,
      })
      setPatterns(data)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setLoading(false)
    }
  }, [search, filterType, page])

  useEffect(() => {
    fetchPatterns()
  }, [fetchPatterns])

  const handleDelete = async (id: number) => {
    if (!confirm("Delete this pattern?")) return
    try {
      await deletePattern(id)
      showToast("Pattern deleted")
      fetchPatterns()
    } catch (e) {
      showToast(`Error: ${(e as Error).message}`)
    }
  }

  const handleEdit = (p: Pattern) => {
    setEditPattern(p)
    setEditValue(p.pattern)
    setEditType(p.pattern_type)
    setEditOpen(true)
  }

  const handleSaveEdit = async () => {
    if (!editPattern) return
    try {
      await updatePattern(editPattern.id, {
        pattern: editValue,
        pattern_type: editType,
      })
      showToast("Pattern updated")
      setEditOpen(false)
      fetchPatterns()
    } catch (e) {
      showToast(`Error: ${(e as Error).message}`)
    }
  }

  const handleCreate = async () => {
    if (!createValue.trim()) return
    try {
      await createPattern({ pattern: createValue, pattern_type: createType })
      showToast("Pattern created")
      setCreateOpen(false)
      setCreateValue("")
      fetchPatterns()
    } catch (e) {
      showToast(`Error: ${(e as Error).message}`)
    }
  }

  const handleBulkImport = async () => {
    const lines = bulkValue.split("\n").map((l) => l.trim()).filter(Boolean)
    if (!lines.length) return
    try {
      const result = await bulkImport({ patterns: lines, pattern_type: bulkType })
      showToast(`Imported ${result.length} patterns`)
      setBulkOpen(false)
      setBulkValue("")
      fetchPatterns()
    } catch (e) {
      showToast(`Error: ${(e as Error).message}`)
    }
  }

  return (
    <div className="space-y-4">
      {toast && (
        <div className="fixed bottom-4 right-4 z-50 rounded-md bg-primary text-primary-foreground px-4 py-2 text-sm shadow-lg">
          {toast}
        </div>
      )}

      <div className="flex items-center gap-3 flex-wrap">
        <Input
          placeholder="Search patterns..."
          value={search}
          onChange={(e) => { setSearch(e.target.value); setPage(0) }}
          className="max-w-xs"
        />
        <Select
          value={filterType}
          onChange={(e) => { setFilterType(e.target.value); setPage(0) }}
          options={[
            { value: "", label: "All types" },
            { value: "block", label: "Block" },
            { value: "whitelist", label: "Whitelist" },
          ]}
          className="max-w-[140px]"
        />
        <Button onClick={() => setCreateOpen(true)}>+ Add Pattern</Button>
        <Button variant="outline" onClick={() => setBulkOpen(true)}>Bulk Import</Button>
      </div>

      {error && <p className="text-destructive text-sm">{error}</p>}

      <Card>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border bg-muted/50">
                  <th className="text-left px-4 py-3 font-medium">ID</th>
                  <th className="text-left px-4 py-3 font-medium">Pattern</th>
                  <th className="text-left px-4 py-3 font-medium">Type</th>
                  <th className="text-left px-4 py-3 font-medium">Created</th>
                  <th className="text-right px-4 py-3 font-medium">Actions</th>
                </tr>
              </thead>
              <tbody>
                {loading ? (
                  Array.from({ length: 5 }).map((_, i) => (
                    <tr key={i} className="border-b border-border">
                      <td className="px-4 py-3"><div className="h-4 w-8 bg-muted rounded animate-pulse" /></td>
                      <td className="px-4 py-3"><div className="h-4 w-40 bg-muted rounded animate-pulse" /></td>
                      <td className="px-4 py-3"><div className="h-4 w-16 bg-muted rounded animate-pulse" /></td>
                      <td className="px-4 py-3"><div className="h-4 w-24 bg-muted rounded animate-pulse" /></td>
                      <td className="px-4 py-3"><div className="h-4 w-16 bg-muted rounded animate-pulse" /></td>
                    </tr>
                  ))
                ) : patterns.length === 0 ? (
                  <tr>
                    <td colSpan={5} className="px-4 py-8 text-center text-muted-foreground">
                      No patterns found
                    </td>
                  </tr>
                ) : (
                  patterns.map((p) => (
                    <tr key={p.id} className="border-b border-border hover:bg-muted/50 transition-colors">
                      <td className="px-4 py-3 text-muted-foreground">{p.id}</td>
                      <td className="px-4 py-3 font-mono text-sm">{p.pattern}</td>
                      <td className="px-4 py-3">
                        <Badge variant={p.pattern_type === "block" ? "destructive" : "secondary"}>
                          {p.pattern_type}
                        </Badge>
                      </td>
                      <td className="px-4 py-3 text-muted-foreground text-xs">
                        {p.created_at?.split("T")[0]}
                      </td>
                      <td className="px-4 py-3 text-right">
                        <div className="flex justify-end gap-2">
                          <Button size="sm" variant="ghost" onClick={() => handleEdit(p)}>Edit</Button>
                          <Button size="sm" variant="ghost" className="text-destructive hover:text-destructive" onClick={() => handleDelete(p.id)}>Del</Button>
                        </div>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>

      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">
          {patterns.length > 0 ? `Showing ${page * 50 + 1}-${page * 50 + patterns.length}` : "No results"}
        </p>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" disabled={page === 0} onClick={() => setPage((p) => p - 1)}>Previous</Button>
          <Button variant="outline" size="sm" disabled={patterns.length < 50} onClick={() => setPage((p) => p + 1)}>Next</Button>
        </div>
      </div>

      {/* Edit Dialog */}
      <Dialog open={editOpen} onClose={() => setEditOpen(false)} title="Edit Pattern">
        <div className="space-y-4">
          <div>
            <Label>Pattern</Label>
            <Input value={editValue} onChange={(e) => setEditValue(e.target.value)} />
          </div>
          <div>
            <Label>Type</Label>
            <Select
              value={editType}
              onChange={(e) => setEditType(e.target.value)}
              options={[{ value: "block", label: "Block" }, { value: "whitelist", label: "Whitelist" }]}
            />
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => setEditOpen(false)}>Cancel</Button>
            <Button onClick={handleSaveEdit}>Save</Button>
          </div>
        </div>
      </Dialog>

      {/* Create Dialog */}
      <Dialog open={createOpen} onClose={() => setCreateOpen(false)} title="Add Pattern">
        <div className="space-y-4">
          <div>
            <Label>Pattern</Label>
            <Input value={createValue} onChange={(e) => setCreateValue(e.target.value)} placeholder="*porn*" />
          </div>
          <div>
            <Label>Type</Label>
            <Select
              value={createType}
              onChange={(e) => setCreateType(e.target.value)}
              options={[{ value: "block", label: "Block" }, { value: "whitelist", label: "Whitelist" }]}
            />
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => setCreateOpen(false)}>Cancel</Button>
            <Button onClick={handleCreate}>Create</Button>
          </div>
        </div>
      </Dialog>

      {/* Bulk Import Dialog */}
      <Dialog open={bulkOpen} onClose={() => setBulkOpen(false)} title="Bulk Import Patterns">
        <div className="space-y-4">
          <div>
            <Label>Patterns (one per line)</Label>
            <textarea
              className="flex min-h-[120px] w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring font-mono"
              value={bulkValue}
              onChange={(e) => setBulkValue(e.target.value)}
              placeholder="*pattern1*\n*pattern2*"
            />
          </div>
          <div>
            <Label>Type</Label>
            <Select
              value={bulkType}
              onChange={(e) => setBulkType(e.target.value)}
              options={[{ value: "block", label: "Block" }, { value: "whitelist", label: "Whitelist" }]}
            />
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => setBulkOpen(false)}>Cancel</Button>
            <Button onClick={handleBulkImport}>Import</Button>
          </div>
        </div>
      </Dialog>
    </div>
  )
}