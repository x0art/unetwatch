import { useCallback, useEffect, useMemo, useState } from "react"
import {
  ArrowDown,
  ArrowUp,
  Ban,
  CornerUpRight,
  GitBranch,
  History,
  RefreshCcw,
  Search,
  SearchX,
  Trash2,
  Zap,
} from "lucide-react"
import {
  type RedirectGraph,
  type TrackedUrl,
  type UrlRedirectHistory,
  addBaseUrlToBlacklist,
  addTrackedUrl,
  checkRedirects,
  deleteTrackedUrl,
  getRedirectGraph,
  getUrlRedirectHistory,
  listTrackedUrls,
} from "../api"
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  ConfirmDialog,
  Dialog,
  EmptyState,
  Input,
  Pagination,
  Skeleton,
  StatCard,
  useToast,
} from "./ui"
import { useDebounce, cn } from "../lib/utils"

const PAGE_SIZE = 25

const STATUS_META: Record<
  TrackedUrl["status"],
  { label: string; variant: "secondary" | "success" | "warning" | "destructive" }
> = {
  unknown: { label: "Unknown", variant: "secondary" },
  ok: { label: "OK", variant: "success" },
  redirect: { label: "Redirecting", variant: "warning" },
  error: { label: "Error", variant: "destructive" },
}

const SOURCE_META: Record<
  TrackedUrl["source"],
  { label: string; variant: "default" | "secondary" | "outline" }
> = {
  manual: { label: "Manual", variant: "secondary" },
  finding: { label: "From finding", variant: "outline" },
  auto: { label: "Auto", variant: "default" },
}

type SortKey = "id" | "url" | "source" | "status" | "last_checked_at"
type SortDir = "asc" | "desc"
type GroupNode = RedirectGraph["nodes"][number]

function formatWhen(ts: string | null) {
  if (!ts) return "—"
  const date = new Date(ts)
  if (Number.isNaN(date.getTime())) return ts
  return date.toLocaleString()
}

function truncate(s: string, max: number) {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s
}

function SortableTh({
  label,
  sortKey,
  sortBy,
  sortDir,
  onSort,
}: {
  label: string
  sortKey: SortKey
  sortBy: SortKey | null
  sortDir: SortDir
  onSort: (key: SortKey) => void
}) {
  const active = sortBy === sortKey
  const Icon = active && sortDir === "asc" ? ArrowUp : ArrowDown
  return (
    <th className="px-4 py-3 text-left font-medium text-muted-foreground">
      <button
        type="button"
        onClick={() => onSort(sortKey)}
        className="inline-flex cursor-pointer items-center gap-1 uppercase tracking-wide transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background"
        aria-label={`Sort by ${label}${active ? `, currently ${sortDir}ending` : ""}`}
        aria-sort={active ? (sortDir === "asc" ? "ascending" : "descending") : "none"}
      >
        {label}
        <Icon className={active ? "h-3 w-3 opacity-100" : "h-3 w-3 opacity-30"} aria-hidden="true" />
      </button>
    </th>
  )
}

/* ── Page ───────────────────────────────────────────────────────────── */

export function RedirectsPage() {
  const { toast } = useToast()
  const [items, setItems] = useState<TrackedUrl[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [graph, setGraph] = useState<RedirectGraph | null>(null)
  const [graphLoading, setGraphLoading] = useState(true)
  const [page, setPage] = useState(0)
  const [search, setSearch] = useState("")
  const [sortBy, setSortBy] = useState<SortKey | null>("id")
  const [sortDir, setSortDir] = useState<SortDir>("desc")
  const [addUrl, setAddUrl] = useState("")
  const [busy, setBusy] = useState(false)
  const [busyUrl, setBusyUrl] = useState<string | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<TrackedUrl | null>(null)
  const [confirmBulkDelete, setConfirmBulkDelete] = useState(false)
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set())
  const [historyTarget, setHistoryTarget] = useState<TrackedUrl | null>(null)
  const [history, setHistory] = useState<UrlRedirectHistory | null>(null)
  const [historyLoading, setHistoryLoading] = useState(false)

  const debouncedSearch = useDebounce(search, 300)

  const loadTable = useCallback(() => {
    let cancelled = false
    setLoading(true)
    listTrackedUrls({
      search: debouncedSearch || undefined,
      limit: PAGE_SIZE,
      offset: page * PAGE_SIZE,
      sort_by: sortBy ?? undefined,
      sort_order: sortDir,
    })
      .then((data) => {
        if (cancelled) return
        setItems(data.items)
        setTotal(data.total)
      })
      .catch(() => {
        if (!cancelled) {
          setItems([])
          setTotal(0)
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [debouncedSearch, page, sortBy, sortDir])

  const loadGraph = useCallback(() => {
    let cancelled = false
    setGraphLoading(true)
    getRedirectGraph()
      .then((data) => {
        if (!cancelled) setGraph(data)
      })
      .catch(() => {
        if (!cancelled) setGraph(null)
      })
      .finally(() => {
        if (!cancelled) setGraphLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => loadTable(), [loadTable])
  useEffect(() => loadGraph(), [loadGraph])

  const reload = useCallback(() => {
    loadTable()
    loadGraph()
  }, [loadTable, loadGraph])

  const handleSearchChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setSearch(e.target.value)
    setPage(0)
  }

  const handleSort = (key: SortKey) => {
    if (sortBy === key) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"))
    } else {
      setSortBy(key)
      setSortDir(key === "id" ? "desc" : "asc")
    }
    setPage(0)
  }

  /* ── Selection (bulk actions) ─────────────────────────────────────── */

  // Drop selections for rows no longer present after a refetch/page change.
  useEffect(() => {
    setSelectedIds((prev) => {
      if (prev.size === 0) return prev
      const visible = new Set(items.map((i) => i.id))
      const next = new Set([...prev].filter((id) => visible.has(id)))
      return next.size === prev.size ? prev : next
    })
  }, [items])

  const allSelected = items.length > 0 && selectedIds.size === items.length
  const someSelected = selectedIds.size > 0 && !allSelected

  const toggleSelectAll = () => {
    setSelectedIds(allSelected ? new Set() : new Set(items.map((i) => i.id)))
  }

  const toggleSelectOne = (id: number) => {
    setSelectedIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const selectedUrls = items.filter((i) => selectedIds.has(i.id)).map((i) => i.url)

  const handleBulkCheck = async () => {
    const urls = [...selectedUrls]
    if (!urls.length) return
    setBusy(true)
    try {
      const res = await checkRedirects(urls)
      const changed = res.updated.filter((u) => u.error || u.status === "redirect").length
      toast({
        title: `Checked ${res.checked} URL${res.checked === 1 ? "" : "s"}`,
        description: `${changed} changed or errored`,
        variant: changed ? "info" : "success",
      })
      reload()
    } catch (e) {
      toast({ title: "Check failed", description: (e as Error).message, variant: "error" })
    } finally {
      setBusy(false)
    }
  }

  const handleBulkBlacklist = async () => {
    const urls = [...selectedUrls]
    if (!urls.length) return
    setBusy(true)
    try {
      const results = await Promise.all(urls.map((u) => addBaseUrlToBlacklist(u)))
      const added = results.reduce((n, r) => n + r.added.length, 0)
      toast({
        title: added
          ? `${added} URL${added === 1 ? "" : "s"} added to blacklist`
          : "Already in blacklist",
        variant: added ? "success" : "info",
      })
    } catch (e) {
      toast({ title: "Blacklist failed", description: (e as Error).message, variant: "error" })
    } finally {
      setBusy(false)
    }
  }

  const handleBulkDelete = async () => {
    setConfirmBulkDelete(false)
    const ids = [...selectedIds]
    if (!ids.length) return
    setBusy(true)
    try {
      await Promise.all(ids.map((id) => deleteTrackedUrl(id)))
      toast({
        title: `Removed ${ids.length} URL${ids.length === 1 ? "" : "s"} from tracking`,
        variant: "success",
      })
      setSelectedIds(new Set())
      if (ids.length >= items.length && page > 0) setPage(page - 1)
      else reload()
    } catch (e) {
      toast({ title: "Bulk delete failed", description: (e as Error).message, variant: "error" })
    } finally {
      setBusy(false)
    }
  }

  /* ── Single-row actions ───────────────────────────────────────────── */

  const handleAdd = async () => {
    const url = addUrl.trim()
    if (!url) return
    setBusy(true)
    try {
      await addTrackedUrl({ url, source: "manual" })
      toast({ title: "URL added to redirect tracking", description: url, variant: "success" })
      setAddUrl("")
      reload()
    } catch (e) {
      const message = (e as Error).message
      if (message.includes("already tracked")) {
        toast({ title: "Already tracked", description: url, variant: "info" })
      } else {
        toast({ title: "Failed to add URL", description: message, variant: "error" })
      }
    } finally {
      setBusy(false)
    }
  }

  const handleCheckNow = async () => {
    setBusy(true)
    try {
      const res = await checkRedirects()
      const changed = res.updated.filter((u) => u.error || u.status === "redirect").length
      toast({
        title: `Checked ${res.checked} URL${res.checked === 1 ? "" : "s"}`,
        description: `${changed} changed or errored`,
        variant: changed ? "info" : "success",
      })
      reload()
    } catch (e) {
      toast({ title: "Check failed", description: (e as Error).message, variant: "error" })
    } finally {
      setBusy(false)
    }
  }

  const handleCheckOne = async (item: TrackedUrl) => {
    setBusyUrl(item.url)
    try {
      const res = await checkRedirects([item.url])
      const result = res.updated[0]
      toast({
        title: `Checked ${item.url}`,
        description: result
          ? `${STATUS_META[result.status].label}${
              result.final_url && result.final_url !== item.url
                ? ` → ${result.final_url}`
                : ""
            }`
          : "No result",
        variant:
          result?.status === "error"
            ? "error"
            : result?.status === "redirect"
              ? "info"
              : "success",
      })
      reload()
    } catch (e) {
      toast({ title: "Check failed", description: (e as Error).message, variant: "error" })
    } finally {
      setBusyUrl(null)
    }
  }

  const handleDelete = async () => {
    if (!deleteTarget) return
    const target = deleteTarget
    setDeleteTarget(null)
    setBusy(true)
    try {
      await deleteTrackedUrl(target.id)
      toast({
        title: "URL removed from tracking",
        description: target.url,
        variant: "success",
      })
      if (items.length === 1 && page > 0) setPage(page - 1)
      else reload()
    } catch (e) {
      toast({ title: "Delete failed", description: (e as Error).message, variant: "error" })
    } finally {
      setBusy(false)
    }
  }

  const openHistory = async (target: TrackedUrl) => {
    setHistoryTarget(target)
    setHistory(null)
    setHistoryLoading(true)
    try {
      setHistory(await getUrlRedirectHistory(target.id))
    } catch (e) {
      toast({ title: "Failed to load history", description: (e as Error).message, variant: "error" })
    } finally {
      setHistoryLoading(false)
    }
  }

  /* ── Grouped-by-current-target visualization ──────────────────────── */

  const groups = useMemo(() => {
    const links = (graph?.links ?? []).filter((l) => l.active)
    const byId = new Map((graph?.nodes ?? []).map((n) => [n.id, n]))
    const members = new Map<string, GroupNode[]>()
    const edgeStatus = new Map<string, number>()
    for (const l of links) {
      const source = byId.get(l.source)
      const target = byId.get(l.target)
      if (!source || !target) continue
      const list = members.get(l.target) ?? []
      list.push(source)
      members.set(l.target, list)
      edgeStatus.set(l.source, l.http_status)
    }
    const ordered = [...members.entries()]
      .map(([targetId, sources]) => ({
        target: byId.get(targetId)!,
        sources: [...sources].sort((a, b) => a.label.localeCompare(b.label)),
      }))
      .sort(
        (a, b) =>
          b.sources.length - a.sources.length ||
          a.target.label.localeCompare(b.target.label),
      )
    return { groups: ordered, edgeStatus }
  }, [graph])

  // Tracked URLs that neither point anywhere nor are pointed at.
  const isolated = useMemo(() => {
    if (!graph) return []
    const links = graph.links.filter((l) => l.active)
    const sources = new Set(links.map((l) => l.source))
    const targets = new Set(links.map((l) => l.target))
    return graph.nodes
      .filter((n) => !sources.has(n.id) && !targets.has(n.id))
      .sort((a, b) => a.label.localeCompare(b.label))
  }, [graph])

  const focusTable = (url: string) => {
    setSearch(url)
    setPage(0)
    toast({ title: "Filtering table", description: url, variant: "info" })
  }

  /* ── Stats from the full node set ─────────────────────────────────── */

  const stats = useMemo(() => {
    const nodes = graph?.nodes ?? []
    return {
      total: nodes.length,
      redirecting: nodes.filter((n) => n.status === "redirect").length,
      ok: nodes.filter((n) => n.status === "ok").length,
      error: nodes.filter((n) => n.status === "error").length,
    }
  }, [graph])

  const graphEmpty = !graphLoading && (!graph || graph.nodes.length === 0)
  const tableEmpty = !loading && total === 0

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-2xl font-semibold tracking-tight">Redirect Tracker</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            URLs under watch for redirects — chains are followed, destinations monitored, and
            target changes recorded over time.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative">
            <CornerUpRight className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground pointer-events-none" />
            <Input
              value={addUrl}
              onChange={(e) => setAddUrl(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") handleAdd()
              }}
              placeholder="http://example.com/path"
              className="w-72 pl-8"
              aria-label="Add URL to redirect tracking"
            />
          </div>
          <Button onClick={handleAdd} disabled={busy || !addUrl.trim()}>
            Track URL
          </Button>
          <Button variant="outline" size="sm" onClick={handleCheckNow} disabled={busy || loading}>
            <Zap className="h-4 w-4" />
            Check now
          </Button>
          <Button variant="outline" size="sm" onClick={reload} disabled={busy}>
            <RefreshCcw className="h-4 w-4" />
            Refresh
          </Button>
        </div>
      </div>

      {/* Summary chips */}
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <StatCard icon={GitBranch} label="Tracked URLs" value={stats.total.toLocaleString()} tone="info" hint="Manual + auto-discovered" />
        <StatCard icon={CornerUpRight} label="Redirecting" value={stats.redirecting.toLocaleString()} tone="warning" hint="Currently pointing elsewhere" />
        <StatCard icon={RefreshCcw} label="OK" value={stats.ok.toLocaleString()} tone="success" hint="No redirect, reachable" />
        <StatCard icon={SearchX} label="Errors" value={stats.error.toLocaleString()} tone="danger" hint="Unreachable or failed check" />
      </div>

      {/* Visualization: grouped by current target */}
      <div className="overflow-hidden rounded-lg border border-border bg-card shadow-sm">
        <div className="border-b border-border px-4 py-3">
          <h3 className="text-sm font-semibold tracking-tight">Grouped by current target</h3>
          <p className="text-xs text-muted-foreground">
            One card per destination URL, listing every tracked URL currently redirecting into
            it. Click a source to filter the table.
          </p>
        </div>
        {graphLoading ? (
          <div className="space-y-3 p-4" aria-busy="true">
            <Skeleton className="h-40 w-full rounded-lg" />
          </div>
        ) : graphEmpty ? (
          <EmptyState
            icon={GitBranch}
            title="No relations yet"
            description="Track a URL and run “Check now” — redirect targets will appear here as groups."
            className="border-0"
          />
        ) : (
          <div className="grid gap-4 p-4 md:grid-cols-2 xl:grid-cols-3">
            {groups.groups.map(({ target, sources }) => (
              <Card key={target.id} className="overflow-hidden">
                <CardHeader className="gap-1 border-b border-border bg-muted/30 p-3.5">
                  <div className="flex items-start justify-between gap-2">
                    <p className="min-w-0 font-mono text-xs font-semibold" title={target.label}>
                      {truncate(target.label, 44)}
                    </p>
                    <Badge variant={STATUS_META[target.status].variant} className="shrink-0">
                      {STATUS_META[target.status].label}
                    </Badge>
                  </div>
                  <p className="text-[11px] text-muted-foreground">
                    {sources.length} source{sources.length === 1 ? "" : "s"} redirect here
                  </p>
                </CardHeader>
                <CardContent className="space-y-2 p-3">
                  {sources.map((s) => (
                    <button
                      key={s.id}
                      type="button"
                      onClick={() => focusTable(s.label)}
                      className="group flex w-full items-center gap-2 rounded-md border border-border px-2.5 py-2 text-left transition-colors hover:border-info/40 hover:bg-accent/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      title={`${s.label} → ${target.label}`}
                      aria-label={`Filter table by ${s.label}`}
                    >
                      <CornerUpRight
                        className="h-3.5 w-3.5 shrink-0 text-muted-foreground transition-colors group-hover:text-info"
                        aria-hidden="true"
                      />
                      <span className="min-w-0 flex-1 truncate font-mono text-xs">{s.label}</span>
                      <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground">
                        HTTP {groups.edgeStatus.get(s.id) ?? "?"}
                      </span>
                      <Badge variant={STATUS_META[s.status].variant} className="shrink-0">
                        {STATUS_META[s.status].label}
                      </Badge>
                    </button>
                  ))}
                </CardContent>
              </Card>
            ))}

            {isolated.length > 0 && (
              <Card className="border-dashed">
                <CardHeader className="gap-1 border-b border-border bg-muted/30 p-3.5">
                  <p className="font-mono text-xs font-semibold">Not redirecting</p>
                  <p className="text-[11px] text-muted-foreground">
                    {isolated.length} tracked URL{isolated.length === 1 ? "" : "s"} with no
                    current redirect
                  </p>
                </CardHeader>
                <CardContent className="space-y-2 p-3">
                  {isolated.map((n) => (
                    <div
                      key={n.id}
                      className="flex w-full items-center gap-2 rounded-md border border-border px-2.5 py-2"
                    >
                      <span className="min-w-0 flex-1 truncate font-mono text-xs" title={n.label}>
                        {n.label}
                      </span>
                      <Badge variant={STATUS_META[n.status].variant} className="shrink-0">
                        {STATUS_META[n.status].label}
                      </Badge>
                    </div>
                  ))}
                </CardContent>
              </Card>
            )}
          </div>
        )}
      </div>

      {/* Table */}
      <div>
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <p className="text-sm text-muted-foreground">
            {total.toLocaleString()} tracked URL{total !== 1 ? "s" : ""}
          </p>
          <div className="relative">
            <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground pointer-events-none" />
            <Input
              placeholder="Search URLs..."
              value={search}
              onChange={handleSearchChange}
              className="w-64 pl-8"
              aria-label="Search tracked URLs"
            />
          </div>
        </div>

        {selectedIds.size > 0 && (
          <div className="mb-3 flex flex-wrap items-center gap-2 rounded-lg border border-border bg-card px-3 py-2 text-sm">
            <span className="font-medium">{selectedIds.size} selected</span>
            <Button size="sm" variant="outline" onClick={handleBulkCheck} disabled={busy}>
              <Zap className="h-3.5 w-3.5" />
              Check
            </Button>
            <Button size="sm" variant="outline" onClick={handleBulkBlacklist} disabled={busy}>
              <Ban className="h-3.5 w-3.5" />
              Add to blacklist
            </Button>
            <Button
              size="sm"
              variant="outline"
              className="text-destructive hover:text-destructive"
              onClick={() => setConfirmBulkDelete(true)}
              disabled={busy}
            >
              <Trash2 className="h-3.5 w-3.5" />
              Delete
            </Button>
          </div>
        )}

        {tableEmpty ? (
          <EmptyState
            icon={SearchX}
            title={debouncedSearch ? "No matching URLs" : "No tracked URLs"}
            description={
              debouncedSearch
                ? "Try adjusting your search."
                : "Add a URL above, or use the Track button on a Finding."
            }
          />
        ) : (
          <>
            <div className="overflow-x-auto rounded-lg border border-border bg-card">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border bg-muted/50">
                    <th className="px-4 py-3 text-left font-medium text-muted-foreground">
                      <label className="inline-flex items-center gap-2 uppercase tracking-wide">
                        <input
                          type="checkbox"
                          checked={allSelected}
                          ref={(el) => {
                            if (el) el.indeterminate = someSelected
                          }}
                          onChange={toggleSelectAll}
                          disabled={busy || items.length === 0}
                          aria-label="Select all tracked URLs"
                          className="h-4 w-4 rounded border-border text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background"
                        />
                        <span className="sr-only">Select</span>
                      </label>
                    </th>
                    <SortableTh label="ID" sortKey="id" sortBy={sortBy} sortDir={sortDir} onSort={handleSort} />
                    <SortableTh label="URL" sortKey="url" sortBy={sortBy} sortDir={sortDir} onSort={handleSort} />
                    <SortableTh label="Status" sortKey="status" sortBy={sortBy} sortDir={sortDir} onSort={handleSort} />
                    <th className="px-4 py-3 text-left font-medium text-muted-foreground">
                      <span className="uppercase tracking-wide">Current target</span>
                    </th>
                    <SortableTh label="Source" sortKey="source" sortBy={sortBy} sortDir={sortDir} onSort={handleSort} />
                    <SortableTh label="Last checked" sortKey="last_checked_at" sortBy={sortBy} sortDir={sortDir} onSort={handleSort} />
                    <th className="px-4 py-3 text-left font-medium text-muted-foreground">
                      <span className="uppercase tracking-wide">Targets</span>
                    </th>
                    <th className="px-4 py-3 text-right font-medium text-muted-foreground">
                      <span className="sr-only">Actions</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {loading
                    ? Array.from({ length: 6 }).map((_, i) => (
                        <tr key={i} className="border-b border-border">
                          <td className="px-4 py-3"><Skeleton className="h-4 w-4" /></td>
                          <td className="px-4 py-3"><Skeleton className="h-4 w-8" /></td>
                          <td className="px-4 py-3"><Skeleton className="h-4 w-56" /></td>
                          <td className="px-4 py-3"><Skeleton className="h-4 w-20" /></td>
                          <td className="px-4 py-3"><Skeleton className="h-4 w-48" /></td>
                          <td className="px-4 py-3"><Skeleton className="h-4 w-16" /></td>
                          <td className="px-4 py-3"><Skeleton className="h-4 w-24" /></td>
                          <td className="px-4 py-3"><Skeleton className="h-4 w-10" /></td>
                          <td className="px-4 py-3" />
                        </tr>
                      ))
                    : items.map((item) => (
                        <tr
                          key={item.id}
                          className={cn(
                            "border-b border-border transition-colors hover:bg-muted/30",
                            selectedIds.has(item.id) && "bg-muted/40",
                          )}
                        >
                          <td className="px-4 py-3">
                            <input
                              type="checkbox"
                              checked={selectedIds.has(item.id)}
                              onChange={() => toggleSelectOne(item.id)}
                              disabled={busy}
                              aria-label={`Select ${item.url}`}
                              className="h-4 w-4 rounded border-border text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background"
                            />
                          </td>
                          <td className="px-4 py-3 text-xs font-mono text-muted-foreground">{item.id}</td>
                          <td className="px-4 py-3">
                            <span className="font-mono text-xs" title={item.url}>
                              {truncate(item.url, 52)}
                            </span>
                          </td>
                          <td className="px-4 py-3">
                            <Badge variant={STATUS_META[item.status].variant}>
                              {STATUS_META[item.status].label}
                              {item.http_status ? ` · ${item.http_status}` : ""}
                            </Badge>
                            {item.last_error && (
                              <span
                                className="block max-w-[200px] truncate text-[11px] text-muted-foreground"
                                title={item.last_error}
                              >
                                {item.last_error}
                              </span>
                            )}
                          </td>
                          <td className="px-4 py-3 font-mono text-xs text-muted-foreground">
                            <span className="block max-w-[280px] truncate" title={item.final_url ?? undefined}>
                              {item.final_url ?? "—"}
                            </span>
                          </td>
                          <td className="px-4 py-3">
                            <Badge variant={SOURCE_META[item.source].variant}>
                              {SOURCE_META[item.source].label}
                            </Badge>
                          </td>
                          <td className="px-4 py-3 whitespace-nowrap text-muted-foreground">
                            {formatWhen(item.last_checked_at)}
                          </td>
                          <td className="px-4 py-3">
                            <button
                              type="button"
                              onClick={() => openHistory(item)}
                              className="inline-flex cursor-pointer items-center gap-1 rounded-full border border-border px-2 py-0.5 text-xs font-semibold text-muted-foreground transition-colors hover:border-info/40 hover:text-info focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                              aria-label={`View redirect history for ${item.url}`}
                            >
                              <History className="h-3 w-3" />
                              {item.history_count}
                            </button>
                          </td>
                          <td className="px-4 py-3 text-right">
                            <div className="flex justify-end gap-1">
                              <Button
                                variant="ghost"
                                size="icon"
                                className="h-8 w-8 text-muted-foreground hover:text-foreground"
                                onClick={() => handleCheckOne(item)}
                                disabled={busy || busyUrl !== null}
                                aria-label={`Check redirects for ${item.url}`}
                              >
                                {busyUrl === item.url ? (
                                  <RefreshCcw className="h-4 w-4 animate-spin" />
                                ) : (
                                  <Zap className="h-4 w-4" />
                                )}
                              </Button>
                              <Button
                                variant="ghost"
                                size="icon"
                                className="h-8 w-8 text-muted-foreground hover:text-destructive"
                                onClick={() => setDeleteTarget(item)}
                                disabled={busy || busyUrl !== null}
                                aria-label={`Stop tracking ${item.url}`}
                              >
                                <Trash2 className="h-4 w-4" />
                              </Button>
                            </div>
                          </td>
                        </tr>
                      ))}
                </tbody>
              </table>
            </div>

            <Pagination
              page={page}
              pageSize={PAGE_SIZE}
              total={total}
              onPageChange={setPage}
            />
          </>
        )}
      </div>

      {/* History dialog */}
      <Dialog
        open={!!historyTarget}
        onClose={() => setHistoryTarget(null)}
        title="Redirect history"
        description={historyTarget ? historyTarget.url : undefined}
        className="max-w-xl"
      >
        {historyLoading ? (
          <div className="space-y-2">
            <Skeleton className="h-8 w-full" />
            <Skeleton className="h-8 w-full" />
            <Skeleton className="h-8 w-full" />
          </div>
        ) : history && history.edges.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No redirects observed yet — run “Check now” to follow this URL's chain.
          </p>
        ) : (
          <div className="space-y-2">
            {history?.edges.map((e, i) => (
              <div
                key={i}
                className={cn(
                  "flex flex-wrap items-center gap-2 rounded-md border border-border px-3 py-2",
                  e.active ? "bg-warning/5" : "opacity-70",
                )}
              >
                <span className="font-mono text-xs" title={e.target_url}>
                  {truncate(e.target_url, 56)}
                </span>
                <Badge variant="secondary">HTTP {e.http_status}</Badge>
                {e.active ? (
                  <Badge variant="warning">Current</Badge>
                ) : (
                  <Badge variant="outline">Historical</Badge>
                )}
                <span className="ml-auto whitespace-nowrap text-[11px] text-muted-foreground">
                  {formatWhen(e.first_seen_at)} → {formatWhen(e.last_seen_at)}
                </span>
              </div>
            ))}
          </div>
        )}
      </Dialog>

      {/* Single delete confirm */}
      <ConfirmDialog
        open={!!deleteTarget}
        title="Stop tracking this URL?"
        description={
          deleteTarget
            ? `${deleteTarget.url} will be removed from redirect monitoring. Its redirect history is kept.`
            : undefined
        }
        confirmLabel="Stop tracking"
        variant="destructive"
        onConfirm={handleDelete}
        onCancel={() => setDeleteTarget(null)}
      />

      {/* Bulk delete confirm */}
      <ConfirmDialog
        open={confirmBulkDelete}
        title="Stop tracking selected URLs?"
        description={`${selectedIds.size} selected URL${
          selectedIds.size !== 1 ? "s" : ""
        } will be removed from redirect monitoring. Their redirect history is kept.`}
        confirmLabel="Stop tracking"
        variant="destructive"
        onConfirm={handleBulkDelete}
        onCancel={() => setConfirmBulkDelete(false)}
      />
    </div>
  )
}
