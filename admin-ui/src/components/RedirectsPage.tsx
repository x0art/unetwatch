import { useCallback, useEffect, useMemo, useRef, useState } from "react"
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
  type RedirectCheckResult,
  type RedirectGraph,
  type TrackedUrl,
  type UrlRedirectHistory,
  addBaseUrlToBlacklist,
  addTrackedUrl,
  checkRedirectsBackground,
  deleteTrackedUrl,
  getRedirectCheckStatus,
  getRedirectGraph,
  getUrlRedirectHistory,
  listTrackedUrls,
} from "../api"
import {
  Badge,
  Button,
  Callout,
  ConfirmDialog,
  CopyUrlButton,
  Dialog,
  EmptyState,
  HeaderStatus,
  Input,
  LoadingIcon,
  PageHeader,
  SearchInput,
  SkeletonShape,
  StatCard,
  useToast,
} from "./ui"
import { DataTable, type DataTableColumn, type SortDir, type SortKey } from "./DataTable"
import { ListActionCell } from "./ListActionDropdown"
import { NetworkGraphDiagram, type NetworkNode, type NetworkLink } from "./NetworkGraphDiagram"
import { cn, useAbortable, useDebounce, useGeneration } from "../lib/utils"
import { LoadingIndicator, useElapsed } from "./loading"

const DEFAULT_PAGE_SIZE = 25

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
    id: "url",
    slot: "identity",
    header: "URL",
    filterType: "text",
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
    id: "final_url",
    slot: "object",
    header: "Final URL",
    filterType: "text",
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
    id: "status",
    slot: "verdict",
    header: "Status",
    filterType: "enum",
    accessor: (i) => i.status,
    defaultSortDir: "asc",
    cell: (i) => (
      <Badge variant={STATUS_META[i.status].variant}>{STATUS_META[i.status].label}</Badge>
    ),
    width: "w-28",
  },
  {
    id: "http_status",
    slot: "verdict",
    header: "HTTP",
    filterType: "number",
    accessor: (i) => i.http_status,
    cell: (i) => (
      <span className="whitespace-nowrap font-mono tabular-nums text-xs text-muted-foreground">
        {i.http_status ?? "—"}
      </span>
    ),
    align: "right",
    width: "w-16",
  },
  {
    id: "source",
    slot: "evidence",
    header: "Source",
    filterType: "enum",
    accessor: (i) => i.source,
    defaultSortDir: "asc",
    cell: (i) => <Badge variant={SOURCE_META[i.source].variant}>{SOURCE_META[i.source].label}</Badge>,
    width: "w-24",
  },
  {
    id: "id",
    slot: "evidence",
    defaultHidden: true,
    header: "ID",
    filterType: "number",
    accessor: (i) => i.id,
    cell: (i) => <span className="font-mono text-xs text-muted-foreground">{i.id}</span>,
    width: "w-14",
  },
  {
    id: "history_count",
    slot: "measures",
    header: "Redirects",
    filterType: "number",
    accessor: (i) => i.history_count,
    cell: (i) => <span className="whitespace-nowrap font-mono tabular-nums text-xs text-muted-foreground">{i.history_count}</span>,
    align: "right",
    width: "w-16",
  },
  {
    id: "last_checked_at",
    slot: "measures",
    header: "Last checked",
    filterType: "datetime",
    accessor: (i) => i.last_checked_at,
    cell: (i) => (
      <span className="whitespace-nowrap font-mono text-xs text-muted-foreground">{formatWhen(i.last_checked_at)}</span>
    ),
    width: "w-40",
  },
  {
    id: "actions",
    slot: "actions",
    header: <span className="sr-only">Actions</span>,
    enableSorting: false,
    enableColumnFilter: false,
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

/** Compact node label: strip the scheme and keep host + a bit of path. */
function shortUrl(url: string): string {
  const afterScheme = url.split("://").pop() ?? url
  return afterScheme.length > 32 ? `${afterScheme.slice(0, 31)}…` : afterScheme
}

/* Node-graph (layered DAG) input for the redirect flow.
 *
 * The backend graph exposes every hop of every chain as a `links` edge
 * (source → target, http_status). Layering by longest-path depth turns
 * those hops into a left → right flow, so chains longer than one hop show
 * their intermediate destinations:
 *
 *   url1 ──▶ final_url1
 *   url2 ──▶ url2_1 ──▶ url2_2 ──▶ final_url2
 *
 * Only `active` edges render — historical (superseded) hops stay in the
 * table + per-URL history drawer, not in the live flow. Tracked URLs keep
 * their status color; pure redirect targets (waypoints/destinations) render
 * as info-colored nodes. */
function toFlow(graph: RedirectGraph | null): { nodes: NetworkNode[]; links: NetworkLink[] } {
  if (!graph) return { nodes: [], links: [] }

  const active = graph.links.filter((l) => l.active)
  if (active.length === 0) return { nodes: [], links: [] }

  // Every URL that appears in an active hop is a node; drop nodes with no
  // active edges (e.g. stale tracked URLs whose chain moved on).
  const nodeIds = new Set<string>()
  for (const l of active) {
    nodeIds.add(l.source)
    nodeIds.add(l.target)
  }

  const nodes: NetworkNode[] = [...nodeIds].map((id) => {
    const tracked = graph.nodes.find((n) => n.id === id)
    return {
      id,
      name: shortUrl(tracked?.label ?? id),
      kind: tracked?.status === "redirect" ? "destination" : undefined,
      detail: tracked?.label ?? id,
      clickable: !!tracked,
    }
  })

  const links: NetworkLink[] = active.map((l) => ({
    source: l.source,
    target: l.target,
    value: 1,
    name: String(l.http_status),
  }))

  return { nodes, links }
}

/* ── Page ───────────────────────────────────────────────────────────── */

export function RedirectsPage({ active = true }: { active?: boolean } = {}) {
  const { toast } = useToast()
  const [items, setItems] = useState<TrackedUrl[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [tableError, setTableError] = useState<string | null>(null)
  const [graph, setGraph] = useState<RedirectGraph | null>(null)
  const [graphLoading, setGraphLoading] = useState(true)
  const [graphError, setGraphError] = useState<string | null>(null)
  const [page, setPage] = useState(0)
  const [pageSize, setPageSize] = useState(DEFAULT_PAGE_SIZE)
  const [search, setSearch] = useState("")
  const [sortBy, setSortBy] = useState<SortKey | null>("last_checked_at")
  const [sortDir, setSortDir] = useState<SortDir>("desc")
  const [addUrl, setAddUrl] = useState("")
  const [busy, setBusy] = useState(false)
  const [busyUrl, setBusyUrl] = useState<string | null>(null)
  const [checking, setChecking] = useState(false)
  const [deleteTarget, setDeleteTarget] = useState<TrackedUrl | null>(null)
  const [confirmBulkDelete, setConfirmBulkDelete] = useState(false)
  const [pendingBulkDelete, setPendingBulkDelete] = useState<Set<string | number> | null>(null)
  const [historyTarget, setHistoryTarget] = useState<TrackedUrl | null>(null)
  const [history, setHistory] = useState<UrlRedirectHistory | null>(null)
  const [historyLoading, setHistoryLoading] = useState(false)
  const [historyError, setHistoryError] = useState<string | null>(null)
  // Epoch-ms the current tracked-URL read left for the API; reset per run so
  // the elapsed figure never inherits a previous read's clock.
  const [loadingStartedAt, setLoadingStartedAt] = useState<number | undefined>(undefined)
  const { elapsed } = useElapsed(loading)

  const debouncedSearch = useDebounce(search, 300)

  // User-keyed READ (search/page/sort). A newer load aborts the previous one
  // and the generation drops a slow earlier load that lands after a newer one
  // (the bare `cancelled` flag only suppressed setState on cleanup).
  const runTable = useAbortable()
  // Destructure the two STABLE useCallback functions, not the `useGeneration()`
  // object — that object is a fresh literal each render, so depending on it
  // would make `loadTable` new every render and reload in a loop.
  const { next: tableNext, isCurrent: tableCurrent } = useGeneration()
  const tableLoadedRef = useRef(false)
  const loadTable = useCallback(() => {
    const g = tableNext()
    const isFirstLoad = !tableLoadedRef.current
    setLoading(true)
    setLoadingStartedAt(Date.now())
    setTableError(null)
    return runTable((signal) =>
      listTrackedUrls({
        search: debouncedSearch || undefined,
        limit: pageSize,
        offset: page * pageSize,
        sort_by: (sortBy ?? "last_checked_at") as "id" | "url" | "source" | "status" | "last_checked_at",
        sort_order: sortDir,
      }, { signal }),
    )
      .then((data) => {
        if (data === undefined || !tableCurrent(g)) return
        setItems(data.items)
        setTotal(data.total)
        tableLoadedRef.current = true
      })
      .catch((e) => {
        if (!tableCurrent(g)) return
        if ((e as Error).name === "AbortError") return
        // Never blank good rows on a FAILED refetch; a failed first load has
        // nothing to keep, so it may still reset (§4.6 never-blank).
        if (isFirstLoad) {
          setItems([])
          setTotal(0)
        }
        setTableError((e as Error).message)
      })
      .finally(() => {
        if (tableCurrent(g)) setLoading(false)
      })
  }, [runTable, tableNext, tableCurrent, debouncedSearch, page, pageSize, sortBy, sortDir])

  // Not user-keyed (fixed params) but still overlappable via `reload`; the
  // abort+generation keep a slow first graph from clobbering a fresher one.
  const runGraph = useAbortable()
  const { next: graphNext, isCurrent: graphCurrent } = useGeneration()
  const graphLoadedRef = useRef(false)
  const loadGraph = useCallback(() => {
    const g = graphNext()
    const isFirstLoad = !graphLoadedRef.current
    setGraphLoading(true)
    setGraphError(null)
    return runGraph((signal) => getRedirectGraph({ signal }))
      .then((data) => {
        if (data === undefined || !graphCurrent(g)) return
        setGraph(data)
        graphLoadedRef.current = true
      })
      .catch((e) => {
        if (!graphCurrent(g)) return
        if ((e as Error).name === "AbortError") return
        // Never blank a graph already on screen on a FAILED refetch.
        if (isFirstLoad) setGraph(null)
        setGraphError((e as Error).message)
      })
      .finally(() => {
        if (graphCurrent(g)) setGraphLoading(false)
      })
  }, [runGraph, graphNext, graphCurrent])

  useEffect(() => {
    // Gate on the in-app view, not the mount: App.tsx keeps every visited page
    // mounted behind a CSS `hidden` wrapper, so a hidden Redirects page would
    // otherwise keep re-running its two (server-expensive) loads on arrival
    // forever. `active` is true on navigate, so the first visit loads at once.
    // `loadTable` carries the search/page/sort deps, so including it is what
    // makes a control change reload the table. The generation/abort guards are
    // unchanged.
    if (!active) return
    void loadTable()
  }, [active, loadTable])

  useEffect(() => {
    // Separate gate for the graph load: same hidden-page reason, but
    // `loadGraph` takes fixed params (no user controls), so this re-runs only
    // when `active` flips — which is correct.
    if (!active) return
    void loadGraph()
  }, [active, loadGraph])

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

  const pollTimerRef = useRef<number | null>(null)

  useEffect(() => () => {
    if (pollTimerRef.current != null) window.clearTimeout(pollTimerRef.current)
  }, [])

  const pollCheck = useCallback(async (checkId: string, onDone: (res: { checked: number; updated: RedirectCheckResult[] }) => void) => {
    let attempts = 0
    const tick = async (): Promise<void> => {
      attempts += 1
      try {
        const run = await getRedirectCheckStatus(checkId)
        if (run.status === "done") {
          onDone({ checked: run.checked, updated: run.updated })
          return
        }
        if (run.status === "error") {
          toast({ title: "Check failed", description: run.error || "Background check errored", variant: "error" })
          return
        }
      } catch {
        /* transient poll failure - keep waiting unless too many attempts */
      }
      if (attempts >= 300) {
        toast({ title: "Check timed out", description: "The background check did not finish.", variant: "error" })
        return
      }
      pollTimerRef.current = window.setTimeout(tick, 500)
    }
    await tick()
  }, [toast])

  const handleCheckNow = async () => {
    if (checking) return
    setChecking(true)
    setBusy(true)
    try {
      const { check_id: checkId } = await checkRedirectsBackground()
      await pollCheck(checkId, (res) => {
        const changed = res.updated.filter((u) => u.error || u.status === "redirect").length
        toast({
          title: `Checked ${res.checked} URL${res.checked === 1 ? "" : "s"}`,
          description: `${changed} changed or errored`,
          variant: changed ? "info" : "success",
        })
        reload()
      })
    } catch (e) {
      toast({ title: "Check failed", description: (e as Error).message, variant: "error" })
    } finally {
      setBusy(false)
      setChecking(false)
    }
  }

  const handleCheckOne = async (item: TrackedUrl) => {
    setBusyUrl(item.url)
    try {
      const { check_id: checkId } = await checkRedirectsBackground([item.url])
      await pollCheck(checkId, (res) => {
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
      })
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
    if (checking) return
    setChecking(true)
    setBusy(true)
    try {
      const { check_id: checkId } = await checkRedirectsBackground(urls)
      await pollCheck(checkId, (res) => {
        const changed = res.updated.filter((u) => u.error || u.status === "redirect").length
        toast({
          title: `Checked ${res.checked} URL${res.checked === 1 ? "" : "s"}`,
          description: `${changed} changed or errored`,
          variant: changed ? "info" : "success",
        })
        reload()
      })
    } catch (e) {
      toast({ title: "Check failed", description: (e as Error).message, variant: "error" })
    } finally {
      setBusy(false)
      setChecking(false)
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
    // Null only when the target actually changes (nothing to keep). Reopening
    // the SAME target keeps the edges mounted so a reload dims-and-cues like
    // every other refetch instead of being unable to ever keep content.
    if (historyTarget?.id !== target.id) setHistory(null)
    setHistoryLoading(true)
    setHistoryError(null)
    try {
      setHistory(await getUrlRedirectHistory(target.id))
    } catch (e) {
      setHistoryError((e as Error).message)
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
  const flow = useMemo(() => toFlow(graph), [graph])

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
  const tableEmpty = !loading && !tableError && total === 0

  /* ── Table columns ───────────────────────────────────────────────── */

  // Sync live state into the module-scope REDIRECTS_COLUMNS handles.
  REDIRECTS_UI.busy = busy
  REDIRECTS_UI.busyUrl = busyUrl
  REDIRECTS_UI.onCheck = handleCheckOne
  REDIRECTS_UI.onHistory = openHistory
  REDIRECTS_UI.onDelete = (i) => setDeleteTarget(i)
  const columns: DataTableColumn<TrackedUrl>[] = REDIRECTS_COLUMNS

  return (
    <div className="space-y-5">
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
        {/* The "Check now" poll and the auto-reload are background work; name
            them here and count the seconds. The banner below is the announced
            mirror, so this stays aria-hidden. Always mounted (shared
            `HeaderStatus` slot), so a load cannot re-wrap the control row. */}
        <HeaderStatus active={loading} icon={RefreshCcw}>
          Loading tracked URLs · <span className="font-mono tabular-nums">{elapsed}</span>
        </HeaderStatus>
        <Button onClick={handleAdd} disabled={busy || !addUrl.trim()}>
          Track URL
        </Button>
        {/* Constant label + pinned min-width: "Checking in background" is a
            genuinely different state (the work outlives the request), so the
            text is kept — but the box is sized to the longer string so the
            Track URL / Refresh controls beside it never move. The spinner
            swaps in for the same `h-4 w-4` Zap box, and `aria-busy` carries
            the state for AT without a per-poll live-region churn. */}
        <Button
          className="min-w-56"
          variant="outline"
          size="sm"
          onClick={handleCheckNow}
          disabled={busy || loading || checking}
          aria-busy={checking}
        >
          {checking ? <LoadingIcon /> : <Zap className="h-4 w-4" />}
          {checking ? "Checking in background" : "Check now"}
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

      {/* Visualization: redirect flow — cv-auto skips the panel's paint
          until it's scrolled into view. */}
      <div className="cv-auto overflow-hidden rounded-md border border-border bg-card shadow-sm">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-3">
          <div>
            <h3 className="text-sm font-semibold tracking-tight">Redirect flow</h3>
            <p className="text-xs text-muted-foreground">
              Sources grouped by the destination they currently land on. Hover a node to
              highlight its chain; click a source to filter the table.
            </p>
          </div>
          {graph && !graphEmpty && (
            <span className="text-xs text-muted-foreground">
              {flow.links.length} hop{flow.links.length === 1 ? "" : "s"}
            </span>
          )}
        </div>

        {/* Only the first graph read blanks to a skeleton; a reload keeps the
            loaded diagram mounted while `graphLoading` re-fetches it. */}
        {graphLoading && !graph ? (
          <div className="space-y-3 p-4" aria-busy="true">
            {/* The loaded surface is a DAG of source/destination nodes — mirror
                the node silhouettes and the zoom-control overlay. */}
            <SkeletonShape variant="dag" />
          </div>
        ) : graphError ? (
          <div className="p-4">
            <Callout action={<Button variant="outline" size="sm" onClick={() => loadGraph()}>Retry</Button>}>
              {graphError}
            </Callout>
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
            {flow && flow.links.length > 0 ? (
              <NetworkGraphDiagram
                nodes={flow.nodes}
                links={flow.links}
                directed
                onSelectUrl={focusTable}
                ariaLabel="Redirect source to destination network"
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
                        "inline-flex max-w-full cursor-pointer items-center gap-1.5 rounded-md border border-border bg-muted/30 px-2.5 py-1 font-mono text-[11px] text-muted-foreground transition-colors",
                        "hover:border-info/40 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                      )}
                    >
                      <span
                        className={cn(
                          "h-1.5 w-1.5 shrink-0",
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

        {/* Refetch with rows already on screen: keep them mounted and report
            the read out loud. First load still shows the DataTable skeleton. */}
        {loading && items.length > 0 && (
          <LoadingIndicator
            label="Loading tracked URLs"
            startedAt={loadingStartedAt}
            className="mb-3 max-w-md"
          />
        )}

        {tableError ? (
          <Callout action={<Button variant="outline" size="sm" onClick={() => reload()}>Retry</Button>}>
            {tableError}
          </Callout>
        ) : tableEmpty ? (
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
            loading={loading && items.length === 0}
            selectable
            busy={busy || loading}
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
            pageSize={pageSize}
            onPageSizeChange={(size) => { setPageSize(size); setPage(0) }}
            total={total}
            onPageChange={setPage}
            viewKey="redirects"
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
        {/* Refetch with edges already on screen: keep the loaded list mounted and
            only light the quiet "Refreshing" cue, so good data is never blanked.
            The edge-list placeholder is reserved for when there is genuinely
            nothing to keep (a first load of a newly opened target) — a loading
            dialog never competes with a populated one. */}
        {historyLoading && !history ? (
          <div className="space-y-3" aria-busy="true">
            {/* The loaded body is a list of variable-height edge cards. */}
            <SkeletonShape variant="edge-list" />
          </div>
        ) : historyLoading && history ? (
          <div className="space-y-2" aria-busy="true">
            <LoadingIndicator label="Refreshing history" className="max-w-md" />
            {history.edges.map((edge, i) => (
              <div
                key={i}
                className={cn(
                  "rounded-md border px-3 py-2.5",
                  edge.active ? "border-success/40 bg-success/5" : "border-border bg-muted/30 opacity-70",
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
        ) : historyError ? (
          <Callout action={<Button variant="outline" size="sm" onClick={() => historyTarget && openHistory(historyTarget)}>Retry</Button>}>
            {historyError}
          </Callout>
        ) : history && history.edges.length > 0 ? (
          <div className="space-y-2">
            {history.edges.map((edge, i) => (
              <div
                key={i}
                className={cn(
                  "rounded-md border px-3 py-2.5",
                  edge.active ? "border-success/40 bg-success/5" : "border-border bg-muted/30 opacity-70",
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
