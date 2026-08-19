import { useCallback, useEffect, useMemo, useState } from "react"
import {
  Copy,
  Link2,
  ListPlus,
  RefreshCcw,
  Search,
  Trash2,
} from "lucide-react"
import {
  addBaseUrlToBlacklist,
  bulkAddBlacklist,
  bulkDeleteBlacklist,
  deleteBlacklistEntry,
  getBlacklistIps,
  getBlacklistUrls,
} from "../api"
import {
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  ConfirmDialog,
  CopyUrlButton,
  Dialog,
  EmptyState,
  Input,
  Label,
  SearchInput,
  Skeleton,
  useToast,
} from "./ui"

interface FeedCardProps {
  title: string
  path: string
  kind: "url" | "ip"
  entries: string[]
  /** Total entries before filtering (shown when a search is active). */
  totalEntries?: number
  searchActive?: boolean
  loading: boolean
  onRefresh: () => void
  onCopy: () => void
  onDelete: (kind: "url" | "ip", value: string) => void
  /** Selection mode for bulk delete. */
  selectMode?: boolean
  selected?: Set<string>
  onToggleSelect?: (value: string) => void
  onEnterSelectMode?: () => void
  onClearSelection?: () => void
  onDeleteSelected?: () => void
  disabled?: boolean
}

function FeedCard({
  title,
  path,
  kind,
  entries,
  totalEntries,
  searchActive,
  loading,
  onRefresh,
  onCopy,
  onDelete,
  selectMode = false,
  selected = new Set(),
  onToggleSelect,
  onEnterSelectMode,
  onClearSelection,
  onDeleteSelected,
  disabled,
}: FeedCardProps) {
  return (
    <Card>
      <CardHeader className="flex-row items-start justify-between gap-3 space-y-0">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <CardTitle>{title}</CardTitle>
            {searchActive && typeof totalEntries === "number" && (
              <span className="rounded-full border border-border bg-muted/40 px-2 py-0.5 text-[10px] font-semibold tabular-nums text-muted-foreground">
                {entries.length}/{totalEntries}
              </span>
            )}
          </div>
          <code className="mt-1.5 inline-block rounded bg-muted px-1.5 py-0.5 text-xs font-mono text-muted-foreground">
            {path}
          </code>
        </div>
        <div className="flex shrink-0 gap-2">
          {selectMode ? (
            <Button variant="outline" size="sm" onClick={onClearSelection} disabled={disabled}>
              Cancel
            </Button>
          ) : (
            <>
              <Button variant="outline" size="sm" onClick={onEnterSelectMode} disabled={loading || entries.length === 0}>
                <Trash2 className="h-3.5 w-3.5" />
                Select
              </Button>
              <Button variant="outline" size="sm" onClick={onRefresh} disabled={loading}>
                <RefreshCcw className="h-3.5 w-3.5" />
                Refresh
              </Button>
              <Button variant="outline" size="sm" onClick={onCopy} disabled={loading || entries.length === 0}>
                <Copy className="h-3.5 w-3.5" />
                Copy
              </Button>
            </>
          )}
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        {/* Bulk-select toolbar */}
        {selectMode ? (
          <div className="flex flex-wrap items-center gap-2 rounded-md border border-border bg-muted/40 px-3 py-2">
            <span className="text-xs font-medium tabular-nums text-muted-foreground">
              {selected.size} selected
            </span>
            <div className="ml-auto flex items-center gap-1.5">
              <Button variant="ghost" size="sm" onClick={onClearSelection} disabled={disabled}>
                Cancel
              </Button>
              <Button
                variant="destructive"
                size="sm"
                onClick={onDeleteSelected}
                disabled={selected.size === 0 || disabled}
              >
                <Trash2 className="h-3.5 w-3.5" />
                Delete
              </Button>
            </div>
          </div>
        ) : null}

        {loading ? (
          <Skeleton className="h-40 w-full" />
        ) : entries.length > 0 ? (
          <ul className="max-h-80 divide-y divide-border overflow-y-auto rounded-md border border-border bg-muted/30">
            {entries.map((value) => {
              const isSelected = selected.has(value)
              return (
                <li
                  key={value}
                  className={`group flex items-center gap-2 px-3 py-1.5 transition-colors ${
                    isSelected ? "bg-primary/10" : "hover:bg-muted/40"
                  }`}
                >
                  {selectMode && onToggleSelect && (
                    <input
                      type="checkbox"
                      checked={isSelected}
                      onChange={() => onToggleSelect(value)}
                      aria-label={`Select ${value}`}
                      className="h-4 w-4 shrink-0 rounded border-border accent-primary"
                    />
                  )}
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
                </li>
              )
            })}
          </ul>
        ) : searchActive ? (
          <EmptyState
            icon={Search}
            title="No matches"
            description="Nothing in this feed matches your search."
          />
        ) : (
          <EmptyState icon={Link2} title="Empty feed" description="No entries yet." />
        )}
      </CardContent>
    </Card>
  )
}

export function BlacklistPage() {
  const [urls, setUrls] = useState<string[]>([])
  const [ips, setIps] = useState<string[]>([])
  const [loading, setLoading] = useState(true)
  const [, setError] = useState<string | null>(null)
  const [addValue, setAddValue] = useState("")
  const [adding, setAdding] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [search, setSearch] = useState("")
  const [deleteTarget, setDeleteTarget] = useState<{
    kind: "url" | "ip"
    value: string
  } | null>(null)

  // Bulk add
  const [bulkOpen, setBulkOpen] = useState(false)
  const [bulkValue, setBulkValue] = useState("")
  const [bulkSubmitting, setBulkSubmitting] = useState(false)

  // Bulk delete (per-feed selection)
  const [selectFeed, setSelectFeed] = useState<"url" | "ip" | null>(null)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [confirmBulkDelete, setConfirmBulkDelete] = useState(false)

  const { toast } = useToast()

  const splitLines = useCallback((text: string) => {
    return text.split("\n").filter((l) => l.trim().length > 0)
  }, [])

  const q = search.trim().toLowerCase()
  const filteredUrls = useMemo(
    () => (q ? urls.filter((u) => u.toLowerCase().includes(q)) : urls),
    [urls, q],
  )
  const filteredIps = useMemo(
    () => (q ? ips.filter((i) => i.toLowerCase().includes(q)) : ips),
    [ips, q],
  )

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const [u, i] = await Promise.all([getBlacklistUrls(), getBlacklistIps()])
      setUrls(splitLines(u))
      setIps(splitLines(i))
    } catch (e) {
      const msg = (e as Error).message
      setError(msg)
      toast({ title: "Failed to load blacklist", description: msg, variant: "error" })
    } finally {
      setLoading(false)
    }
  }, [splitLines, toast])

  useEffect(() => {
    load()
  }, [load])

  const copy = useCallback(
    async (text: string, label: string) => {
      try {
        await navigator.clipboard.writeText(text)
        toast({ title: `${label} copied`, variant: "success" })
      } catch {
        toast({ title: "Copy failed", variant: "error" })
      }
    },
    [toast],
  )

  const add = useCallback(async () => {
    const value = addValue.trim()
    if (!value) return
    setAdding(true)
    try {
      const res = await addBaseUrlToBlacklist(value)
      setAddValue("")
      toast({ title: "Added to blacklist", description: res.added.join(", "), variant: "success" })
      await load()
    } catch (e) {
      toast({ title: "Failed to add blacklist entry", description: (e as Error).message, variant: "error" })
    } finally {
      setAdding(false)
    }
  }, [addValue, load, toast])

  const handleDelete = async () => {
    if (!deleteTarget) return
    const target = deleteTarget
    setDeleteTarget(null)
    setDeleting(true)
    try {
      await deleteBlacklistEntry(target.kind, target.value)
      toast({ title: "Removed from blacklist", description: target.value, variant: "success" })
    } catch (e) {
      toast({ title: "Delete failed", description: (e as Error).message, variant: "error" })
    } finally {
      // Refresh either way so a stale row (e.g. already removed server-side)
      // never lingers in the list.
      await load()
      setDeleting(false)
    }
  }

  const requestDelete = useCallback((kind: "url" | "ip", value: string) => {
    setDeleteTarget({ kind, value })
  }, [])

  /* ── Bulk add ─────────────────────────────────────────────────── */
  const bulkLines = useMemo(
    () => bulkValue.split("\n").map((l) => l.trim()).filter(Boolean),
    [bulkValue],
  )

  const handleBulkAdd = async () => {
    if (bulkLines.length === 0) return
    setBulkSubmitting(true)
    try {
      const res = await bulkAddBlacklist(bulkLines)
      const parts: string[] = []
      if (res.added.length) parts.push(`${res.added.length} added`)
      if (res.skipped.length) parts.push(`${res.skipped.length} already present`)
      if (res.errors.length) parts.push(`${res.errors.length} invalid`)
      toast({
        title: "Bulk add complete",
        description: parts.join(" · ") || "Nothing to add",
        variant: res.errors.length ? "error" : "success",
      })
      setBulkOpen(false)
      setBulkValue("")
      await load()
    } catch (e) {
      toast({ title: "Bulk add failed", description: (e as Error).message, variant: "error" })
    } finally {
      setBulkSubmitting(false)
    }
  }

  /* ── Bulk delete ──────────────────────────────────────────────── */
  const enterSelectMode = (kind: "url" | "ip") => {
    setSelectFeed(kind)
    setSelected(new Set())
  }

  const exitSelectMode = () => {
    setSelectFeed(null)
    setSelected(new Set())
  }

  const toggleSelect = useCallback((value: string) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(value)) next.delete(value)
      else next.add(value)
      return next
    })
  }, [])

  const handleBulkDelete = async () => {
    if (!selectFeed || selected.size === 0) return
    const kind = selectFeed
    const values = [...selected]
    setConfirmBulkDelete(false)
    setDeleting(true)
    try {
      const res = await bulkDeleteBlacklist(values.map((v) => ({ kind, value: v })))
      toast({
        title: `Removed ${res.deleted} entr${res.deleted === 1 ? "y" : "ies"} from ${kind} blacklist`,
        variant: "success",
      })
      exitSelectMode()
    } catch (e) {
      toast({ title: "Bulk delete failed", description: (e as Error).message, variant: "error" })
    } finally {
      await load()
      setDeleting(false)
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-2xl font-semibold tracking-tight">Blacklist</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Concrete URLs and IPs blacklisted from findings. Entries are stored as bare hosts (no protocol or path).
          </p>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <div className="flex min-w-0 flex-1 gap-2">
          <Input
            value={addValue}
            onChange={(e) => setAddValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") add()
            }}
            placeholder="Add URL or IP — saved as bare host"
          />
          <Button onClick={add} disabled={adding || !addValue.trim()}>
            Add
          </Button>
        </div>
        <Button variant="outline" onClick={() => setBulkOpen(true)}>
          <ListPlus className="h-4 w-4" />
          Bulk add
        </Button>
      </div>

      {/* Search */}
      <div className="flex flex-wrap items-center gap-3">
        <SearchInput
          placeholder="Search URLs or IPs..."
          value={search}
          onChange={setSearch}
          className="w-72"
          aria-label="Search blacklist entries"
        />
        {q && (
          <span className="text-xs text-muted-foreground">
            {filteredUrls.length + filteredIps.length} match
            {filteredUrls.length + filteredIps.length === 1 ? "" : "es"} across both feeds
          </span>
        )}
      </div>

      <div className="space-y-4">
        <FeedCard
          title="URL blacklist"
          path="/api/blacklist/urls.txt"
          kind="url"
          entries={filteredUrls}
          totalEntries={urls.length}
          searchActive={!!q}
          loading={loading}
          onRefresh={load}
          onCopy={() => copy(urls.join("\n"), "URLs")}
          onDelete={requestDelete}
          selectMode={selectFeed === "url"}
          selected={selected}
          onToggleSelect={toggleSelect}
          onEnterSelectMode={() => enterSelectMode("url")}
          onClearSelection={exitSelectMode}
          onDeleteSelected={() => setConfirmBulkDelete(true)}
          disabled={deleting}
        />
        <FeedCard
          title="IP blacklist"
          path="/api/blacklist/ips.txt"
          kind="ip"
          entries={filteredIps}
          totalEntries={ips.length}
          searchActive={!!q}
          loading={loading}
          onRefresh={load}
          onCopy={() => copy(ips.join("\n"), "IPs")}
          onDelete={requestDelete}
          selectMode={selectFeed === "ip"}
          selected={selected}
          onToggleSelect={toggleSelect}
          onEnterSelectMode={() => enterSelectMode("ip")}
          onClearSelection={exitSelectMode}
          onDeleteSelected={() => setConfirmBulkDelete(true)}
          disabled={deleting}
        />
      </div>

      {/* Per-row delete confirm */}
      <ConfirmDialog
        open={!!deleteTarget}
        title="Remove from blacklist?"
        description={
          deleteTarget
            ? `${deleteTarget.value} will no longer be blocked by the ${deleteTarget.kind} blacklist.`
            : undefined
        }
        confirmLabel="Remove"
        variant="destructive"
        onConfirm={handleDelete}
        onCancel={() => setDeleteTarget(null)}
      />

      {/* Bulk delete confirm */}
      <ConfirmDialog
        open={confirmBulkDelete}
        title="Delete selected entries?"
        description={
          selectFeed
            ? `${selected.size} selected entr${selected.size === 1 ? "y" : "ies"} will be removed from the ${selectFeed} blacklist. This cannot be undone.`
            : undefined
        }
        confirmLabel="Delete selected"
        variant="destructive"
        onConfirm={handleBulkDelete}
        onCancel={() => setConfirmBulkDelete(false)}
      />

      {/* Bulk add dialog */}
      <Dialog open={bulkOpen} onClose={() => setBulkOpen(false)} title="Bulk add to blacklist">
        <div className="space-y-4">
          <div>
            <Label>Values (one per line)</Label>
            <textarea
              className="flex min-h-[140px] w-full rounded-md border border-input bg-background px-3 py-2 font-mono text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              value={bulkValue}
              onChange={(e) => setBulkValue(e.target.value)}
              placeholder={"http://example.com/foo\n1.2.3.4"}
              autoFocus
            />
            <p className="mt-1.5 text-xs text-muted-foreground">
              {bulkLines.length === 0
                ? "Enter URLs or IPs, one per line. Each is saved as a bare host."
                : `${bulkLines.length} line${bulkLines.length === 1 ? "" : "s"} will be added`}
            </p>
          </div>
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="outline" onClick={() => setBulkOpen(false)} disabled={bulkSubmitting}>
              Cancel
            </Button>
            <Button onClick={handleBulkAdd} disabled={bulkLines.length === 0 || bulkSubmitting}>
              {bulkSubmitting ? "Adding…" : `Add${bulkLines.length > 0 ? ` (${bulkLines.length})` : ""}`}
            </Button>
          </div>
        </div>
      </Dialog>
    </div>
  )
}
