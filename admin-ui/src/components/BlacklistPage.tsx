import { useCallback, useEffect, useMemo, useState } from "react"
import { Ban, Copy, Link2, RefreshCcw, Search, Trash2, X } from "lucide-react"
import {
  addBaseUrlToBlacklist,
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
  EmptyState,
  Input,
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
          <Button variant="outline" size="sm" onClick={onRefresh} disabled={loading}>
            <RefreshCcw className="h-3.5 w-3.5" />
            Refresh
          </Button>
          <Button variant="outline" size="sm" onClick={onCopy} disabled={loading || entries.length === 0}>
            <Copy className="h-3.5 w-3.5" />
            Copy
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        {loading ? (
          <Skeleton className="h-40 w-full" />
        ) : entries.length > 0 ? (
          <ul className="max-h-80 divide-y divide-border overflow-y-auto rounded-md border border-border bg-muted/30">
            {entries.map((value) => (
              <li
                key={value}
                className="group flex items-center gap-2 px-3 py-1.5 transition-colors hover:bg-muted/40"
              >
                <span className="min-w-0 flex-1 truncate font-mono text-xs" title={value}>
                  {value}
                </span>
                <button
                  type="button"
                  onClick={() => onDelete(kind, value)}
                  disabled={disabled}
                  aria-label={`Remove ${value} from blacklist`}
                  className="inline-flex h-7 w-7 shrink-0 cursor-pointer items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-danger/10 hover:text-destructive focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50"
                >
                  <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                </button>
              </li>
            ))}
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

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-2.5">
        <Ban className="h-5 w-5 text-muted-foreground" aria-hidden="true" />
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Blacklist</h1>
          <p className="text-sm text-muted-foreground">
            Concrete URLs and IPs blacklisted from findings. Entries are stored as bare hosts (no protocol or path).
          </p>
        </div>
      </div>

      <div className="flex gap-2">
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

      {/* Search */}
      <div className="flex flex-wrap items-center gap-3">
        <div className="relative">
          <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground pointer-events-none" />
          <Input
            placeholder="Search URLs or IPs..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-72 pl-8 pr-8"
            aria-label="Search blacklist entries"
          />
          {search && (
            <button
              type="button"
              onClick={() => setSearch("")}
              aria-label="Clear search"
              className="absolute right-2 top-2.5 rounded-sm text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <X className="h-4 w-4" />
            </button>
          )}
        </div>
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
          disabled={deleting}
        />
      </div>

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
    </div>
  )
}
