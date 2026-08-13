import { useCallback, useEffect, useMemo, useState } from "react"
import {
  Ban,
  CornerUpRight,
  GitBranch,
  History,
  RefreshCcw,
  SearchX,
  Trash2,
  Zap,
} from "lucide-react"
import {
  type RedirectGraph,
  type RedirectLink,
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
  ConfirmDialog,
  CopyUrlButton,
  Dialog,
  EmptyState,
  Input,
  PageHeader,
  SearchInput,
  Skeleton,
  StatCard,
  useToast,
} from "./ui"
import { DataTable, type DataTableColumn, type SortDir, type SortKey } from "./DataTable"
import { ListActionCell } from "./ListActionDropdown"
import { SankeyDiagram, type SankeyLink, type SankeyNode } from "./SankeyDiagram"
import { cn, useDebounce } from "../lib/utils"

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

function formatWhen(ts: string | null) {
  if (!ts) return "—"
  const date = new Date(ts)
  if (Number.isNaN(date.getTime())) return ts
  return date.toLocaleString()
}

/* Module-level handles to component state, synced each render, so
 * REDIRECTS_COLUMNS stays referentially stable at module scope while its
 * cells still read live busy state and trigger actions. */
const REDIRECTS_UI: {
  busy: boolean
  busyUrl: string | null
  onCheck: (i: TrackedUrl) => void
  onHistory: (i: TrackedUrl) => void
  onDelete: (i: TrackedUrl) => void
} = {
  busy: false,
  busyUrl: null,
  onCheck: () => {},
  onHistory: () => {},
  onDelete: () => {},
}

/** Stable row identity for the tracked-URLs table. */
const REDIRECTS_ROW_ID = (i: TrackedUrl) => i.id

/* Module-scope columns for the tracked-URLs table — referentially stable so
 * DataTable never re-sorts/re-renders when RedirectsPage re-renders. */
const REDIRECTS_COLUMNS: DataTableColumn<TrackedUrl>[] = [
  {
    id: "id",
    header: "ID",
    accessor: (i) => i.id,
    cell: (i) => <span className="font-mono text-xs text-muted-foreground">{i.id}</span>,
    width: "w-14",
  },
  {
    id: "url",
    header: "URL",
    accessor: (i) => i.url,
    defaultSortDir: "asc",
    cell: (i) => (
      <span className="flex items-center gap-1.5">
        <span className="block max-w-[320px] truncate font-mono text-xs" title={i.url}>
          {i.url}
        </span>
        <CopyUrlButton value={i.url} label="URL" />
      </span>
    ),
  },
  {
    id: "status",
    header: "Status",
    accessor: (i) => i.status,
    defaultSortDir: "asc",
    cell: (i) => (
      <Badge variant={STATUS_META[i.status].variant}>{STATUS_META[i.status].label}</Badge>
    ),
    width: "w-28",
  },
  {
    id: "http_status",
    header: "HTTP",
    accessor: (i) => i.http_status,
    cell: (i) => (
      <span className="tabular-nums text-xs text-muted-foreground">
        {i.http_status ?? "—"}
      </span>
    ),
    align: "right",
    width: "w-16",
  },
  {
    id: "final_url",
    header: "Final URL",
    accessor: (i) => i.final_url,
    cell: (i) =>
      i.final_url && i.final_url !== i.url ? (
        <span className="flex items-center gap-1.5">
          <span className="block max-w-[280px] truncate font-mono text-xs text-muted-foreground" title={i.final_url}>
            {i.final_url}
          </span>
          <CopyUrlButton value={i.final_url} label="Final URL" />
        </span>
      ) : (
        <span className="text-xs text-muted-foreground/60">—</span>
      ),
  },
  {
    id: "source",
    header: "Source",
    accessor: (i) => i.source,
    defaultSortDir: "asc",
    cell: (i) => <Badge variant={SOURCE_META[i.source].variant}>{SOURCE_META[i.source].label}</Badge>,
    width: "w-24",
  },
  {
    id: "last_checked_at",
    header: "Last checked",
    accessor: (i) => i.last_checked_at,
    cell: (i) => (
      <span className="whitespace-nowrap text-xs text-muted-foreground">{formatWhen(i.last_checked_at)}</span>
    ),
    width: "w-40",
  },
  {
    id: "history_count",
    header: "Targets",
    accessor: (i) => i.history_count,
    cell: (i) => <span className="tabular-nums text-xs text-muted-foreground">{i.history_count}</span>,
    align: "right",
    width: "w-16",
  },
  {
    id: "actions",
    header: <span className="sr-only">Actions</span>,
    enableSorting: false,
    align: "right",
    width: "w-32",
    cell: (i) => (
      <div className="flex justify-end">
        <ListActionCell
          baseUrl={i.url}
          extra={[
            {
              key: "check",
              label: REDIRECTS_UI.busyUrl === i.url ? "Checking…" : "Check now",
              icon: REDIRECTS_UI.busyUrl === i.url ? RefreshCcw : Zap,
              onClick: () => REDIRECTS_UI.onCheck(i),
              disabled: REDIRECTS_UI.busy || REDIRECTS_UI.busyUrl === i.url,
            },
            {
              key: "history",
              label: "View history",
              icon: History,
              onClick: () => REDIRECTS_UI.onHistory(i),
              disabled: REDIRECTS_UI.busy,
            },
            {
              key: "delete",
              label: "Delete",
              icon: Trash2,
              variant: "destructive",
              separator: true,
              onClick: () => REDIRECTS_UI.onDelete(i),
              disabled: REDIRECTS_UI.busy,
            },
          ]}
        />
      </div>
    ),
  },
]

/* URLs that don't redirect (direct hits, errors) — shown as chips below
 * the flow. */
function directNodes(graph: RedirectGraph | null): RedirectGraph["nodes"] {
  if (!graph) return []
  return graph.nodes
    .filter((n) => !(n.final_url && n.final_url !== n.id))
    .sort((a, b) => a.label.localeCompare(b.label))
}

/* Layered (alluvial) input for the redirect flow.
 *
 * The backend graph exposes every hop of every chain as a `links` edge
 * (source → target, http_status). Layering by longest-path depth turns
 * those hops into a true alluvial flow, so chains longer than one hop
 * show their intermediate destinations:
 *
 *   [] url1  final_url1 []
 *   [] url2  [] url2_1  [] url2_2  final_url2 []
 *
 * Only `active` edges render — historical (superseded) hops stay in the
 * table + per-URL history drawer, not in the live flow. */
function toSankey(graph: RedirectGraph | null): {
  nodes: SankeyNode[]
  links: SankeyLink[]
} {
  if (!graph) return { nodes: [], links: [] }

  const active = graph.links.filter((l) => l.active)
  if (active.length === 0) return { nodes: [], links: [] }

  // Adjacency for depth computation.
  const outgoing = new Map<string, RedirectLink[]>()
  const incoming = new Map<string, RedirectLink[]>()
  for (const l of active) {
    if (!outgoing.has(l.source)) outgoing.set(l.source, [])
    if (!incoming.has(l.target)) incoming.set(l.target, [])
    outgoing.get(l.source)!.push(l)
    incoming.get(l.target)!.push(l)
  }

  // Every URL that appears in an active hop is a node; drop nodes with no
  // active edges (e.g. stale tracked URLs whose chain moved on).
  const nodeIds = new Set<string>()
  for (const l of active) {
    nodeIds.add(l.source)
    nodeIds.add(l.target)
  }

  // Longest-path depth: a node's layer is the farthest a chain can reach
  // before it, so roots sit at 0 and terminals on the last layer.
  const depth = new Map<string, number>()
  const visit = (id: string): number => {
    const cached = depth.get(id)
    if (cached !== undefined) return cached
    const parents = incoming.get(id) ?? []
    const d = parents.length === 0 ? 0 : 1 + Math.max(...parents.map((p) => visit(p.source)))
    depth.set(id, d)
    return d
  }
  for (const id of nodeIds) visit(id)

  const nodes: SankeyNode[] = [...nodeIds].map((id) => ({
    id,
    name: graph.nodes.find((n) => n.id === id)?.label ?? id,
    layer: depth.get(id) ?? 0,
  }))

  const links: SankeyLink[] = active.map((l) => ({
    source: l.source,
    target: l.target,
    value: 1,
    name: `${l.http_status} →`,
  }))

  return { nodes, links }
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
  const [pendingBulkDelete, setPendingBulkDelete] = useState<Set<string | number> | null>(null)
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
      sort_by: (sortBy ?? "id") as "id" | "url" | "source" | "status" | "last_checked_at",
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

  const handleSortChange = (key: SortKey, dir: SortDir) => {
    setSortBy(key)
    setSortDir(dir)
    setPage(0)
  }

  const handleSearchChange = (value: string) => {
    setSearch(value)
    setPage(0)
  }

  /* ── Actions ─────────────────────────────────────────────────────── */

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

  const handleBulkCheck = async (ids: Set<string | number>) => {
    const urls = items.filter((i) => ids.has(i.id)).map((i) => i.url)
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

  const handleBulkBlacklist = async (ids: Set<string | number>) => {
    const urls = items.filter((i) => ids.has(i.id)).map((i) => i.url)
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

  const handleBulkDelete = async (ids: Set<string | number>) => {
    setPendingBulkDelete(null)
    setConfirmBulkDelete(false)
    const idList = [...ids] as number[]
    if (!idList.length) return
    setBusy(true)
    try {
      await Promise.all(idList.map((id) => deleteTrackedUrl(id)))
      toast({
        title: `Removed ${idList.length} URL${idList.length === 1 ? "" : "s"} from tracking`,
        variant: "success",
      })
      if (idList.length >= items.length && page > 0) setPage(page - 1)
      else reload()
    } catch (e) {
      toast({ title: "Bulk delete failed", description: (e as Error).message, variant: "error" })
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

  const focusTable = (url: string) => {
    setSearch(url)
    setPage(0)
    toast({ title: "Filtering table", description: url, variant: "info" })
  }

  /* ── Derived data ────────────────────────────────────────────────── */

  const direct = useMemo(() => directNodes(graph), [graph])
  const redirectSankey = useMemo(() => toSankey(graph), [graph])

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

  /* ── Table columns ───────────────────────────────────────────────── */

  // Sync live state into the module-scope REDIRECTS_COLUMNS handles.
  REDIRECTS_UI.busy = busy
  REDIRECTS_UI.busyUrl = busyUrl
  REDIRECTS_UI.onCheck = handleCheckOne
  REDIRECTS_UI.onHistory = openHistory
  REDIRECTS_UI.onDelete = (i) => setDeleteTarget(i)
  const columns: DataTableColumn<TrackedUrl>[] = REDIRECTS_COLUMNS

  return (
    <div className="space-y-6">
      {/* Header */}
      <PageHeader
        title="Redirect Tracker"
        description="URLs under watch for redirects — chains are followed, destinations monitored, and target changes recorded over time."
      >
        <div className="relative">
          <CornerUpRight className="absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground pointer-events-none" />
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
      </PageHeader>

      {/* Summary chips */}
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <StatCard icon={GitBranch} label="Tracked URLs" value={stats.total.toLocaleString()} tone="info" hint="Manual + auto-discovered" />
        <StatCard icon={CornerUpRight} label="Redirecting" value={stats.redirecting.toLocaleString()} tone="warning" hint="Currently pointing elsewhere" />
        <StatCard icon={RefreshCcw} label="OK" value={stats.ok.toLocaleString()} tone="success" hint="No redirect, reachable" />
        <StatCard icon={SearchX} label="Errors" value={stats.error.toLocaleString()} tone="danger" hint="Unreachable or failed check" />
      </div>

      {/* Visualization: redirect flow clustered by final URL */}
      <div className="overflow-hidden rounded-lg border border-border bg-card shadow-sm">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-3">
          <div>
            <h3 className="text-sm font-semibold tracking-tight">Redirect flow</h3>
            <p className="text-xs text-muted-foreground">
              Sources grouped by the destination they currently land on. Click a source to
              filter the table.
            </p>
          </div>
          {graph && !graphEmpty && (
            <span className="text-xs text-muted-foreground">
              {redirectSankey.links.length} flow{redirectSankey.links.length === 1 ? "" : "s"}
            </span>
          )}
        </div>

        {graphLoading ? (
          <div className="space-y-3 p-4" aria-busy="true">
            <Skeleton className="h-64 w-full rounded-lg" />
          </div>
        ) : graphEmpty ? (
          <EmptyState
            icon={GitBranch}
            title="No relations yet"
            description="Track a URL and run “Check now” — redirect chains will cluster here by destination."
            className="border-0"
          />
        ) : (
          <div className="p-4 sm:p-6">
            {redirectSankey && redirectSankey.links.length > 0 ? (
              <SankeyDiagram
                nodes={redirectSankey.nodes}
                links={redirectSankey.links}
                layerColors={{
                  0: "var(--color-warning)",
                  1: "var(--color-success)",
                }}
                ariaLabel="Redirect source to final URL flow"
              />
            ) : (
              <p className="py-8 text-center text-sm text-muted-foreground">
                No redirects observed yet — run “Check now” to discover chains.
              </p>
            )}

            {/* Direct / unresolved URLs */}
            {direct.length > 0 && (
              <div className="mt-5 border-t border-border pt-4">
                <p className="mb-2 text-xs font-medium text-muted-foreground">
                  Direct &amp; unresolved ({direct.length})
                </p>
                <div className="flex flex-wrap gap-1.5">
                  {direct.map((n) => (
                    <button
                      key={n.id}
                      type="button"
                      onClick={() => focusTable(n.label)}
                      title={`${n.label} — ${STATUS_META[n.status].label}`}
                      className={cn(
                        "inline-flex max-w-full cursor-pointer items-center gap-1.5 rounded-full border border-border/60 bg-muted/30 px-2.5 py-1 font-mono text-[11px] text-muted-foreground transition-colors",
                        "hover:border-info/40 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                      )}
                    >
                      <span
                        className={cn(
                          "h-1.5 w-1.5 shrink-0 rounded-full",
                          n.status === "ok" && "bg-success",
                          n.status === "error" && "bg-danger",
                          n.status === "unknown" && "bg-muted-foreground/50",
                        )}
                        aria-hidden="true"
                      />
                      <span className="truncate">{n.label}</span>
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Table */}
      <div>
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <p className="text-sm text-muted-foreground">
            {total.toLocaleString()} tracked URL{total === 1 ? "" : "s"}
            {debouncedSearch && ` matching "${debouncedSearch}"`}
          </p>
          <SearchInput
            placeholder="Search URLs..."
            value={search}
            onChange={handleSearchChange}
            className="w-64"
            aria-label="Search tracked URLs"
          />
        </div>

        {tableEmpty ? (
          <EmptyState
            icon={SearchX}
            title={debouncedSearch ? "No matching URLs" : "No tracked URLs"}
            description={
              debouncedSearch
                ? "Try adjusting your search."
                : "Track a URL above to start monitoring its redirects."
            }
          />
        ) : (
          <DataTable
            columns={columns}
            data={items}
            rowId={REDIRECTS_ROW_ID}
            loading={loading}
            selectable
            busy={busy}
            bulkActions={[
              {
                label: "Check",
                icon: Zap,
                variant: "outline",
                onClick: handleBulkCheck,
                disabled: busy,
              },
              {
                label: "Blacklist",
                icon: Ban,
                variant: "outline",
                onClick: handleBulkBlacklist,
                disabled: busy,
              },
              {
                label: "Delete",
                icon: Trash2,
                variant: "destructive",
                onClick: (ids) => {
                  setPendingBulkDelete(ids)
                  setConfirmBulkDelete(true)
                },
              },
            ]}
            sortBy={sortBy}
            sortDir={sortDir}
            onSortChange={handleSortChange}
            page={page}
            pageSize={PAGE_SIZE}
            total={total}
            onPageChange={setPage}
            ariaLabel="Tracked URLs"
          />
        )}
      </div>

      {/* Dialogs */}
      <ConfirmDialog
        open={!!deleteTarget}
        title="Remove from tracking?"
        description={
          deleteTarget
            ? `${deleteTarget.url} will no longer be monitored. Redirect history is kept.`
            : undefined
        }
        confirmLabel="Remove"
        variant="destructive"
        onConfirm={handleDelete}
        onCancel={() => setDeleteTarget(null)}
      />

      <ConfirmDialog
        open={confirmBulkDelete}
        title="Remove selected URLs?"
        description={`${pendingBulkDelete?.size ?? 0} selected URL${
          (pendingBulkDelete?.size ?? 0) !== 1 ? "s" : ""
        } will no longer be monitored. Redirect history is kept.`}
        confirmLabel="Remove"
        variant="destructive"
        onConfirm={() => {
          if (pendingBulkDelete) handleBulkDelete(pendingBulkDelete)
        }}
        onCancel={() => setConfirmBulkDelete(false)}
      />

      {/* History dialog */}
      <Dialog
        open={!!historyTarget}
        onClose={() => setHistoryTarget(null)}
        title="Redirect history"
        description={historyTarget ? `${historyTarget.url} · ${STATUS_META[historyTarget.status].label}` : undefined}
        className="max-w-2xl"
      >
        {historyLoading ? (
          <div className="space-y-3" aria-busy="true">
            <Skeleton className="h-40 w-full rounded-lg" />
          </div>
        ) : history && history.edges.length > 0 ? (
          <div className="space-y-2">
            {history.edges.map((edge, i) => (
              <div
                key={i}
                className={cn(
                  "rounded-md border px-3 py-2.5",
                  edge.active ? "border-success/40 bg-success/5" : "border-border/60 bg-muted/30 opacity-70",
                )}
              >
                <div className="flex flex-wrap items-center gap-2">
                  <Badge variant={edge.active ? "success" : "secondary"}>
                    {edge.active ? "Active" : "Historical"}
                  </Badge>
                  <span className="text-xs text-muted-foreground">HTTP {edge.http_status}</span>
                  <span className="ml-auto text-[11px] text-muted-foreground">
                    {formatWhen(edge.first_seen_at)} → {formatWhen(edge.last_seen_at)}
                  </span>
                </div>
                <p className="mt-1.5 truncate font-mono text-xs" title={edge.target_url}>
                  {edge.target_url}
                </p>
              </div>
            ))}
          </div>
        ) : (
          <p className="py-8 text-center text-sm text-muted-foreground">
            No redirects observed for this URL yet.
          </p>
        )}
      </Dialog>
    </div>
  )
}
